// Fudge deployment: one Worker that combines the pieces of cf-newsletter that
// Fudge uses, without Email Routing, Zero Trust Access or the admin console.
//
//   queue            -> consumer (per-recipient MIME, warmup, SEND_EMAIL)
//   GET/POST /u/...  -> tracker (unsubscribe page + RFC 8058 one-click POST)
//   /admin/*         -> small JSON API behind a bearer secret (ADMIN_TOKEN):
//       POST /admin/campaigns           create a campaign and enqueue recipients,
//                                       filtered by segment or by explicit emails
//       GET  /admin/campaigns/:id       progress counts
//       POST /admin/campaigns/:id/stop  stop: queued batches are dropped
//       POST /admin/bounces             mark hard bounces / complaints and write
//                                       the opt-out back to Fudge's account DB
//
// Every other path returns 404: no public signup, no open/click tracking.

import consumer, { type Env as ConsumerEnv } from '../../consumer/src/index';
import tracker, { type Env as TrackerEnv } from '../../tracker/src/index';
import { writeLog } from '../../../shared/db';
import { recordFudgeOptOut } from '../../../shared/fudge-consent';
import type { QueueMessage, Recipient } from '../../../shared/types';

export interface Env extends ConsumerEnv, TrackerEnv {
  DB: D1Database;
  ACCOUNT_DB: D1Database;
  QUEUE: Queue<QueueMessage>;
  ADMIN_TOKEN: string;
}

const BATCH_SIZE = 10;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'u') return tracker.fetch(req, env, ctx);
    if (parts[0] === 'admin') {
      if (!(await authorized(req, env))) return json({ error: 'unauthorized' }, 401);
      try {
        if (req.method === 'POST' && parts[1] === 'campaigns' && parts.length === 2) {
          return await createCampaign(req, env);
        }
        if (req.method === 'GET' && parts[1] === 'campaigns' && parts.length === 3) {
          return await campaignStatus(env, parts[2]!);
        }
        if (req.method === 'POST' && parts[1] === 'campaigns' && parts[3] === 'stop' && parts.length === 4) {
          const res = await env.DB
            .prepare("UPDATE campaigns SET status = 'failed' WHERE id = ? AND status = 'sending'")
            .bind(parts[2]!).run();
          return json({ stopped: (res.meta?.changes ?? 0) > 0 });
        }
        if (req.method === 'POST' && parts[1] === 'bounces' && parts.length === 2) {
          return await recordBounces(req, env);
        }
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }
    return new Response('not found', { status: 404 });
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    return consumer.queue(batch, env, ctx);
  },
};

async function authorized(req: Request, env: Env): Promise<boolean> {
  const header = req.headers.get('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || !given) return false;
  // Compare digests so the comparison time doesn't depend on the secret.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(env.ADMIN_TOKEN)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

interface CreateCampaignBody {
  newsletter_id: string;
  subject: string;
  html?: string;
  text: string;
  reply_to?: string;
  merge?: { openings?: Record<string, string> };
  // Exactly one of: segments (send to active subscribers in these segments)
  // or emails (send only to these active subscribers, e.g. a test).
  segments?: string[];
  emails?: string[];
  // Cap on recipients for this call (send a segment in daily chunks).
  limit?: number;
  // Must be true to enqueue; otherwise only report who would receive it.
  confirm?: boolean;
}

async function createCampaign(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as CreateCampaignBody;
  // html is required: buildEmail always emits a text/html part, and an empty
  // one would render as a footer-only email in most clients.
  if (!body.newsletter_id || !body.subject?.trim() || !body.text?.trim() || !body.html?.trim()) {
    throw new Error('newsletter_id, subject, text and html are required');
  }
  const bySegment = Array.isArray(body.segments) && body.segments.length > 0;
  const byEmail = Array.isArray(body.emails) && body.emails.length > 0;
  if (bySegment === byEmail) throw new Error('give exactly one of segments or emails');

  const nl = await env.DB.prepare('SELECT id FROM newsletters WHERE id = ? AND enabled = 1')
    .bind(body.newsletter_id).first();
  if (!nl) throw new Error('newsletter not found or disabled');

  // Recipients: active and confirmed, minus anyone who already has a `sends`
  // row for a campaign with the same subject — so re-running a segment (or
  // sending the next chunk) never mails the same person twice.
  const filter = bySegment ? body.segments! : body.emails!.map((e) => e.trim().toLowerCase());
  const placeholders = filter.map(() => '?').join(',');
  const column = bySegment ? 'segment' : 'lower(email)';
  const { results } = await env.DB
    .prepare(
      `SELECT id, email, name, segment, token FROM subscribers
       WHERE newsletter_id = ? AND status = 'active' AND confirm_token IS NULL
         AND ${column} IN (${placeholders})
         AND NOT EXISTS (
           SELECT 1 FROM sends s JOIN campaigns c ON c.id = s.campaign_id
           WHERE s.subscriber_id = subscribers.id AND c.subject = ?)
       ORDER BY id
       LIMIT ?`,
    )
    .bind(body.newsletter_id, ...filter, body.subject.trim(), Math.max(1, Math.min(body.limit ?? 100000, 100000)))
    .all<{ id: number; email: string; name: string | null; segment: string | null; token: string }>();
  const recipients = results ?? [];

  if (!body.confirm) {
    return json({ dry_run: true, recipients: recipients.length, sample: recipients.slice(0, 3).map((r) => r.email) });
  }
  if (recipients.length === 0) throw new Error('no matching active subscribers');

  const campaignId = crypto.randomUUID();
  await env.DB
    .prepare(
      'INSERT INTO campaigns (id, newsletter_id, subject, html, text, sent_by, reply_to_address, status, total_recipients, merge_json) ' +
        "VALUES (?, ?, ?, ?, ?, 'admin-api', ?, 'sending', ?, ?)",
    )
    .bind(
      campaignId,
      body.newsletter_id,
      body.subject.trim(),
      body.html ?? null,
      body.text,
      body.reply_to ?? null,
      recipients.length,
      body.merge ? JSON.stringify(body.merge) : null,
    )
    .run();

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch: Recipient[] = recipients.slice(i, i + BATCH_SIZE).map((r) => ({
      subscriberId: r.id,
      email: r.email,
      name: r.name ?? undefined,
      segment: r.segment ?? undefined,
      token: r.token,
    }));
    await env.QUEUE.send({ campaignId, batch });
  }
  await writeLog(env.DB, {
    source: 'admin-api',
    event: 'campaign.queued',
    campaignId,
    newsletterId: body.newsletter_id,
    message: `Queued ${recipients.length} recipient(s) (${bySegment ? 'segments ' + filter.join(',') : 'explicit emails'})`,
  });
  return json({ campaign_id: campaignId, recipients: recipients.length });
}

async function campaignStatus(env: Env, id: string): Promise<Response> {
  const c = await env.DB
    .prepare('SELECT id, subject, status, total_recipients, sent_count, failed_count, created_at FROM campaigns WHERE id = ?')
    .bind(id).first();
  if (!c) return json({ error: 'not found' }, 404);
  const { results } = await env.DB
    .prepare('SELECT status, COUNT(*) AS n FROM sends WHERE campaign_id = ? GROUP BY status')
    .bind(id).all();
  const unsubscribed = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM events WHERE campaign_id = ? AND type = 'unsubscribe'")
    .bind(id).first<{ n: number }>();
  return json({ campaign: c, sends: results, unsubscribes: unsubscribed?.n ?? 0 });
}

interface BounceBody {
  newsletter_id: string;
  // 'bounced' for hard bounces, 'complained' for spam complaints.
  status: 'bounced' | 'complained';
  emails: string[];
}

async function recordBounces(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as BounceBody;
  if (!body.newsletter_id || !['bounced', 'complained'].includes(body.status) || !body.emails?.length) {
    throw new Error('newsletter_id, status (bounced|complained) and emails are required');
  }
  let updated = 0;
  let fudgeAccounts = 0;
  for (const raw of body.emails) {
    const email = raw.trim().toLowerCase();
    const res = await env.DB
      .prepare(
        "UPDATE subscribers SET status = ?, last_bounce_at = datetime('now'), " +
          "hard_bounce_count = hard_bounce_count + CASE WHEN ? = 'bounced' THEN 1 ELSE 0 END, " +
          'bounce_count = bounce_count + CASE WHEN ? = \'bounced\' THEN 1 ELSE 0 END ' +
          "WHERE newsletter_id = ? AND lower(email) = ? AND status = 'active'",
      )
      .bind(body.status, body.status, body.status, body.newsletter_id, email)
      .run();
    updated += res.meta?.changes ?? 0;
    fudgeAccounts += await recordFudgeOptOut(env.ACCOUNT_DB, email);
  }
  await writeLog(env.DB, {
    level: 'warn',
    source: 'admin-api',
    event: `subscriber.${body.status}`,
    newsletterId: body.newsletter_id,
    message: `Marked ${updated} subscriber(s) ${body.status}; Fudge opt-out on ${fudgeAccounts} account(s)`,
  });
  return json({ updated, fudge_accounts: fudgeAccounts });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
