// Per-recipient merge fields in the campaign body.
//
//   {{greeting}} -> "Hi Ana," or "Hi," when the subscriber has no first name.
//   {{opening}}  -> the campaign's opening line for the subscriber's segment,
//                   falling back to the campaign's "default" opening.
//
// Openings are campaign content, so they live on the campaign (`merge_json`),
// not on the subscriber. Values are HTML-escaped in the HTML part.

export interface MergeConfig {
  openings?: Record<string, string>;
}

export function parseMergeConfig(json: string | null | undefined): MergeConfig {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as MergeConfig;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function renderMergeFields(
  template: string,
  cfg: MergeConfig,
  firstName: string | null | undefined,
  segment: string | null | undefined,
  html: boolean,
): string {
  const name = (firstName ?? '').trim();
  const values: Record<string, string> = {
    greeting: name ? `Hi ${name},` : 'Hi,',
    opening: (segment && cfg.openings?.[segment]) ?? cfg.openings?.default ?? '',
  };
  return template.replace(/\{\{\s*(greeting|opening)\s*\}\}/g, (_m, key: string) => {
    const v = values[key] ?? '';
    return html ? escapeHtml(v) : v;
  });
}
