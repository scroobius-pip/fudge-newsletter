// Write-back of opt-outs to Fudge's account database (fudge-account-production).
//
// Fudge's marketing audience export reads `user_preference`
// (product 'fudge', key 'marketing.email_subscribed'). When a recipient
// unsubscribes, hard-bounces or complains here, the same address must stop
// counting as subscribed there, or the next export would mail them again.
//
// The table's triggers require last_mutated_by = account_user_id and an active
// owner; the opted-out person is the owner, so both hold. Timestamps are Unix
// seconds, matching the rest of the account database.

const OPT_OUT_SQL =
  'INSERT INTO user_preference ' +
  '(account_user_id, product_key, preference_key, value_kind, boolean_value, created_at, updated_at, last_mutated_by) ' +
  "SELECT DISTINCT e.account_user_id, 'fudge', 'marketing.email_subscribed', 'boolean', 0, unixepoch(), unixepoch(), e.account_user_id " +
  'FROM account_email e JOIN account_user u ON u.id = e.account_user_id ' +
  "WHERE u.lifecycle_state = 'active' AND e.normalized_email = lower(trim(?)) " +
  'ON CONFLICT (account_user_id, product_key, preference_key) DO UPDATE SET ' +
  "value_kind = 'boolean', boolean_value = 0, integer_value = NULL, text_value = NULL, " +
  'updated_at = max(excluded.updated_at, user_preference.updated_at), ' +
  'last_mutated_by = user_preference.account_user_id';

/** Marks every active Fudge account using `email` as not subscribed. Returns rows changed. */
export async function recordFudgeOptOut(accountDb: D1Database | undefined, email: string): Promise<number> {
  if (!accountDb || !email) return 0;
  const res = await accountDb.prepare(OPT_OUT_SQL).bind(email).run();
  return res.meta?.changes ?? 0;
}
