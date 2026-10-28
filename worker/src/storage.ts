// 動画とサムネイルの保存（Workers KV）
//
// ・動画は partSize ごとの「塊」に分けて KV に保存する（KV の値の上限 25MiB 未満）。
//   キー: <storageKey>/c/<番号（0始まり）>、サムネイル: <storageKey>/t
// ・どの塊を受け取ったかは D1 の video_chunks で管理する（KV の一覧取得は1日の回数制限が厳しいため）。
// ・KV 無料プランの上限（合計1GB、1日あたり書き込み・削除・一覧取得 各1,000回）は超えると
//   課金ではなくエラーになる。途中で失敗しないよう、D1 で使用量を数えて手前で止める。
// ・すべての塊に有効期限（expirationTtl）を付け、定期削除が止まっても KV から自動で消えるようにする。
import { RETENTION_MS } from "../../shared/constants";
import type { ByteReader } from "../../shared/mp4";
import { Mp4Error } from "../../shared/mp4";
import { getConfig } from "./config";
import type { Env } from "./env";
import { HttpError } from "./http";

export type KvOp = "write" | "delete" | "list";

/** アップロードが完了しないまま放置された動画を削除するまでの時間 */
export const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
const DAY_SECONDS = 24 * 60 * 60;
/** KV の有効期限の最小値（Cloudflare の仕様で60秒以上） */
const MIN_TTL_SECONDS = 60;

export function storagePrefix(videoId: string): string {
  return `v/${videoId}`;
}

export function chunkKey(prefix: string, idx: number): string {
  return `${prefix}/c/${idx}`;
}

export function thumbKey(prefix: string): string {
  return `${prefix}/t`;
}

/** KV のキーから動画IDを取り出す（v/<id>/...） */
export function videoIdFromKey(key: string): string | null {
  const m = /^v\/([0-9a-f-]{36})\//.exec(key);
  return m ? m[1] : null;
}

export function chunkCount(v: { fileSize: number; partSize: number }): number {
  return Math.ceil(v.fileSize / v.partSize);
}

/** 塊 idx（0始まり）の大きさ */
export function chunkLength(v: { fileSize: number; partSize: number }, idx: number): number {
  const total = chunkCount(v);
  return idx < total - 1 ? v.partSize : v.fileSize - v.partSize * (total - 1);
}

/**
 * 動画の塊の有効期限（秒）。公開期間14日＋アップロード猶予1日＋余裕1日。
 * 通常は期限後5分以内に定期削除で消えるが、定期削除が止まっていても KV から自動で消える。
 */
export function chunkTtlSeconds(): number {
  return Math.ceil((RETENTION_MS + STALE_UPLOAD_MS) / 1000) + DAY_SECONDS;
}

/** サムネイルの有効期限（秒）。動画の削除予定日時＋1日（未確定なら動画の塊と同じ） */
export function thumbTtlSeconds(expiresAt: number | null, nowMs: number): number {
  if (expiresAt === null) return chunkTtlSeconds();
  return Math.max(MIN_TTL_SECONDS, Math.ceil((expiresAt - nowMs) / 1000) + DAY_SECONDS);
}

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** 今日（UTC）の KV 操作回数 */
export async function opsToday(db: D1Database, nowMs: number): Promise<Record<KvOp, number>> {
  const rows = await db
    .prepare("SELECT op, count FROM kv_daily_ops WHERE day = ?1")
    .bind(utcDay(nowMs))
    .all<{ op: KvOp; count: number }>();
  const out: Record<KvOp, number> = { write: 0, delete: 0, list: 0 };
  for (const r of rows.results) out[r.op] = r.count;
  return out;
}

export async function recordOps(db: D1Database, op: KvOp, n: number, nowMs: number): Promise<void> {
  if (n <= 0) return;
  await db
    .prepare(
      `INSERT INTO kv_daily_ops (day, op, count) VALUES (?1, ?2, ?3)
       ON CONFLICT (day, op) DO UPDATE SET count = count + ?3`,
    )
    .bind(utcDay(nowMs), op, n)
    .run();
}

/** 今日の残り回数が n 回以上あるか */
export async function hasOpBudget(env: Env, op: KvOp, n: number, nowMs: number): Promise<boolean> {
  const used = (await opsToday(env.DB, nowMs))[op];
  return used + n <= getConfig(env).kvDailyLimits[op];
}

const OP_LABELS: Record<KvOp, string> = { write: "書き込み", delete: "削除", list: "一覧取得" };

export async function requireOpBudget(env: Env, op: KvOp, n: number, nowMs: number): Promise<void> {
  if (!(await hasOpBudget(env, op, n, nowMs))) {
    throw new HttpError(
      429,
      "KV_DAILY_LIMIT",
      `今日の動画保存領域（Workers KV）の${OP_LABELS[op]}回数の上限に近いため、受け付けられません。日本時間の午前9時（UTC 0時）以降に再度お試しください。`,
    );
  }
}

/**
 * KV の使用量（バイト）。アップロード中の動画は予定の大きさ全体を予約として数える。
 * 完了・失敗・削除中の動画は実際に保存されている塊の合計。
 */
export async function storageUsage(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN v.status = 'uploading' THEN v.fileSize ELSE COALESCE(c.bytes, 0) END + v.thumbnailBytes), 0) AS bytes
       FROM videos v LEFT JOIN (SELECT videoId, SUM(size) AS bytes FROM video_chunks GROUP BY videoId) c ON c.videoId = v.id`,
    )
    .first<{ bytes: number }>();
  return row?.bytes ?? 0;
}

/** アップロード中の動画で、まだ受け取っていない塊の数（今後の書き込み予定） */
export async function pendingChunkWrites(db: D1Database, nowMs: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM((v.fileSize + v.partSize - 1) / v.partSize
              - (SELECT COUNT(*) FROM video_chunks c WHERE c.videoId = v.id)), 0) AS n
       FROM videos v WHERE v.status = 'uploading' AND v.createdAt > ?1`,
    )
    .bind(nowMs - STALE_UPLOAD_MS)
    .first<{ n: number }>();
  return Math.max(0, row?.n ?? 0);
}

/** 塊を KV に保存する（書き込み回数を記録） */
export async function putChunk(env: Env, prefix: string, idx: number, bytes: ArrayBuffer, nowMs: number): Promise<void> {
  await env.MEDIA.put(chunkKey(prefix, idx), bytes, { expirationTtl: chunkTtlSeconds(), metadata: { t: nowMs } });
  await recordOps(env.DB, "write", 1, nowMs);
}

/** KV のキーをまとめて削除する（削除回数を記録）。存在しないキーの削除も成功する */
export async function deleteKeys(env: Env, keys: string[], nowMs: number): Promise<void> {
  for (let i = 0; i < keys.length; i += 10) {
    await Promise.all(keys.slice(i, i + 10).map((k) => env.MEDIA.delete(k)));
  }
  await recordOps(env.DB, "delete", keys.length, nowMs);
}

/** 動画の塊が KV にまだ反映されていない（保存直後の別の地域など）ことを表すエラー */
export class ChunkNotReadyError extends Error {
  constructor(public idx: number) {
    super(`chunk ${idx} not found`);
  }
}

export async function getChunk(env: Env, prefix: string, idx: number): Promise<Uint8Array> {
  const buf = await env.MEDIA.get(chunkKey(prefix, idx), "arrayBuffer");
  if (!buf) throw new ChunkNotReadyError(idx);
  return new Uint8Array(buf);
}

/** 塊に分けて保存した動画を、MP4 解析用に範囲読み込みする ByteReader（直前の塊を再利用） */
export function chunkedReader(env: Env, v: { storageKey: string; fileSize: number; partSize: number }): ByteReader {
  let cached: { idx: number; bytes: Uint8Array } | null = null;
  const load = async (idx: number) => {
    if (cached?.idx !== idx) cached = { idx, bytes: await getChunk(env, v.storageKey, idx) };
    return cached.bytes;
  };
  return {
    size: v.fileSize,
    async read(offset, length) {
      const end = Math.min(v.fileSize, offset + length);
      if (end <= offset) return new Uint8Array();
      const out = new Uint8Array(end - offset);
      let pos = offset;
      while (pos < end) {
        const idx = Math.floor(pos / v.partSize);
        let bytes: Uint8Array;
        try {
          bytes = await load(idx);
        } catch (err) {
          if (err instanceof ChunkNotReadyError) throw err;
          throw new Mp4Error("CORRUPT", "動画ファイルを読み込めませんでした。");
        }
        const start = pos - idx * v.partSize;
        const take = Math.min(bytes.length - start, end - pos);
        if (take <= 0) throw new Mp4Error("CORRUPT", "動画ファイルの一部が欠けています。");
        out.set(bytes.subarray(start, start + take), pos - offset);
        pos += take;
      }
      return out;
    },
  };
}
