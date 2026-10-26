// D1を使った固定ウィンドウ方式のレート制限
export interface RateLimitResult {
  count: number;
  /** 制限が解除されるまでの秒数 */
  retryAfterSeconds: number;
}

/** カウンターを1増やして現在の回数を返す */
export async function hit(db: D1Database, key: string, windowMs: number, nowMs: number): Promise<RateLimitResult> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, windowStart) VALUES (?1, 1, ?2)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.windowStart <= ?3 THEN 1 ELSE rate_limits.count + 1 END,
         windowStart = CASE WHEN rate_limits.windowStart <= ?3 THEN ?2 ELSE rate_limits.windowStart END
       RETURNING count, windowStart`,
    )
    .bind(key, nowMs, nowMs - windowMs)
    .first<{ count: number; windowStart: number }>();
  const count = row?.count ?? 1;
  const start = row?.windowStart ?? nowMs;
  return { count, retryAfterSeconds: Math.max(1, Math.ceil((start + windowMs - nowMs) / 1000)) };
}

/** カウンターを増やさずに現在の回数を確認する */
export async function peek(db: D1Database, key: string, windowMs: number, nowMs: number): Promise<RateLimitResult> {
  const row = await db
    .prepare("SELECT count, windowStart FROM rate_limits WHERE key = ?1 AND windowStart > ?2")
    .bind(key, nowMs - windowMs)
    .first<{ count: number; windowStart: number }>();
  if (!row) return { count: 0, retryAfterSeconds: 0 };
  return { count: row.count, retryAfterSeconds: Math.max(1, Math.ceil((row.windowStart + windowMs - nowMs) / 1000)) };
}

export async function clear(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM rate_limits WHERE key = ?1").bind(key).run();
}
