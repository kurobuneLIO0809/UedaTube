// 動画の完全削除と、Cron Trigger による期限切れデータの定期削除
import type { Env } from "./env";
import { RETENTION_MS } from "../../shared/constants";
import type { VideoRow } from "./db";
import { STALE_UPLOAD_MS, chunkKey, deleteKeys, hasOpBudget, recordOps, videoIdFromKey } from "./storage";

export { STALE_UPLOAD_MS };
/** KV にあって D1 に無いファイルを孤立ファイルとみなすまでの時間 */
export const ORPHAN_GRACE_MS = 6 * 60 * 60 * 1000;
/** 孤立ファイルの検査は KV の一覧取得（1日の回数制限あり）を使うため、1時間に1回だけ行う */
export const ORPHAN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** 1回の定期処理で削除する動画の最大数（Workersの実行時間・サブリクエスト上限に配慮） */
export const CLEANUP_BATCH = 10;
const ORPHAN_SCAN_LIMIT = 200;

export interface DeleteResult {
  ok: boolean;
  error?: string;
}

/** ログ・DBに残すエラーメッセージ（秘密情報やスタックトレースを含めない） */
function safeError(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return msg.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 300);
}

/**
 * 動画を完全に削除する（KV の動画の塊・サムネイル、D1 のコメント・メタデータ）。
 * 失敗した場合や、今日の KV 削除回数が足りない場合は status='deleting' のまま残し、次回の定期処理で再試行する
 * （その間も視聴はできない。KV の塊には有効期限があるため、最終的には KV からも自動で消える）。
 * 既に削除済みのキーを削除しても失敗しない。
 */
export async function deleteVideoCompletely(env: Env, video: VideoRow, nowMs: number): Promise<DeleteResult> {
  // まず視聴不可の状態にする（以降の処理が失敗しても再公開されない）
  await env.DB.prepare("UPDATE videos SET status = 'deleting', commentsEnabled = 0, updatedAt = ?2 WHERE id = ?1")
    .bind(video.id, nowMs)
    .run();
  const fail = async (error: string): Promise<DeleteResult> => {
    try {
      await env.DB.prepare(
        "UPDATE videos SET deleteAttempts = deleteAttempts + 1, lastDeleteError = ?2, updatedAt = ?3 WHERE id = ?1",
      )
        .bind(video.id, error, nowMs)
        .run();
    } catch {
      // D1自体が失敗している場合は次回に任せる
    }
    return { ok: false, error };
  };
  try {
    // 保存した塊は D1 に記録してあるので、それだけを削除する（無駄な削除回数を使わない）
    const chunks = await env.DB.prepare("SELECT idx FROM video_chunks WHERE videoId = ?1").bind(video.id).all<{ idx: number }>();
    const keys = chunks.results.map((c) => chunkKey(video.storageKey, c.idx));
    if (video.thumbnailKey) keys.push(video.thumbnailKey);
    if (keys.length > 0) {
      if (!(await hasOpBudget(env, "delete", keys.length, nowMs))) {
        return await fail("今日の KV 削除回数の上限に近いため、次回の定期処理で削除します（視聴はできません）。");
      }
      await deleteKeys(env, keys, nowMs);
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM comments WHERE videoId = ?1").bind(video.id),
      env.DB.prepare("DELETE FROM video_chunks WHERE videoId = ?1").bind(video.id),
      env.DB.prepare("DELETE FROM videos WHERE id = ?1").bind(video.id),
    ]);
    return { ok: true };
  } catch (err) {
    return await fail(safeError(err));
  }
}

export interface CleanupSummary {
  deletedVideos: number;
  failedVideos: number;
  orphanObjects: number;
  errors: string[];
}

/** 期限切れ・削除中・放置されたアップロードの動画を探して削除する */
export async function runCleanup(env: Env, nowMs: number): Promise<CleanupSummary> {
  const summary: CleanupSummary = { deletedVideos: 0, failedVideos: 0, orphanObjects: 0, errors: [] };

  const candidates = await env.DB.prepare(
    `SELECT * FROM videos
     WHERE (expiresAt IS NOT NULL AND expiresAt <= ?1)
        OR status = 'deleting'
        OR (status IN ('uploading', 'failed') AND createdAt <= ?2)
     ORDER BY COALESCE(expiresAt, createdAt) ASC
     LIMIT ?3`,
  )
    .bind(nowMs, nowMs - STALE_UPLOAD_MS, CLEANUP_BATCH)
    .all<VideoRow>();

  for (const video of candidates.results) {
    const r = await deleteVideoCompletely(env, video, nowMs);
    if (r.ok) summary.deletedVideos++;
    else {
      summary.failedVideos++;
      summary.errors.push(`video ${video.id}: ${r.error}`);
    }
  }

  try {
    summary.orphanObjects = await sweepOrphanObjects(env, nowMs);
  } catch (err) {
    summary.errors.push(`orphan sweep: ${safeError(err)}`);
  }

  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM rate_limits WHERE windowStart < ?1").bind(nowMs - 24 * 60 * 60 * 1000),
      // KV 操作回数の記録は7日分だけ残す
      env.DB.prepare("DELETE FROM kv_daily_ops WHERE day < ?1").bind(new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)),
      env.DB.prepare(
        "INSERT INTO cleanup_runs (ranAt, deletedVideos, failedVideos, orphanObjects, errors) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).bind(
        nowMs,
        summary.deletedVideos,
        summary.failedVideos,
        summary.orphanObjects,
        summary.errors.length ? JSON.stringify(summary.errors.slice(0, 10)) : null,
      ),
      env.DB.prepare("DELETE FROM cleanup_runs WHERE id NOT IN (SELECT id FROM cleanup_runs ORDER BY id DESC LIMIT 100)"),
    ]);
  } catch (err) {
    summary.errors.push(`log: ${safeError(err)}`);
  }

  console.log(JSON.stringify({ event: "cleanup", at: new Date(nowMs).toISOString(), ...summary }));
  return summary;
}

/**
 * KV に残っているが D1 に対応する動画が無いファイル（処理の途中失敗などで生じた孤立ファイル）を削除する。
 * KV の一覧取得・削除は1日の回数制限があるため、1時間に1回、回数に余裕があるときだけ一部ずつ検査する。
 * （孤立ファイルにも有効期限が付いているため、ここで消せなくても最終的には KV から自動で消える。）
 */
export async function sweepOrphanObjects(env: Env, nowMs: number): Promise<number> {
  const last = await env.DB.prepare("SELECT value FROM meta WHERE key = 'orphan_last_sweep'").first<{ value: string }>();
  if (last && nowMs - Number(last.value) < ORPHAN_SWEEP_INTERVAL_MS) return 0;
  if (!(await hasOpBudget(env, "list", 1, nowMs))) return 0;
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('orphan_last_sweep', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1")
    .bind(String(nowMs))
    .run();

  const cursorRow = await env.DB.prepare("SELECT value FROM meta WHERE key = 'orphan_cursor'").first<{ value: string }>();
  const listed = await env.MEDIA.list<{ t?: number }>({
    prefix: "v/",
    limit: ORPHAN_SCAN_LIMIT,
    ...(cursorRow ? { cursor: cursorRow.value } : {}),
  });
  await recordOps(env.DB, "list", 1, nowMs);

  const ids = [...new Set(listed.keys.map((k) => videoIdFromKey(k.name)).filter((x): x is string => !!x))];
  const existing = new Set<string>();
  if (ids.length > 0) {
    const res = await env.DB.prepare(`SELECT id FROM videos WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...ids)
      .all<{ id: string }>();
    for (const r of res.results) existing.add(r.id);
  }
  const orphanKeys = listed.keys
    .filter((k) => {
      const id = videoIdFromKey(k.name);
      const writtenAt = typeof k.metadata?.t === "number" ? k.metadata.t : 0;
      // 想定外のキー、または D1 に無い動画のファイルで、一定時間以上経過したもの
      return (id === null || !existing.has(id)) && nowMs - writtenAt >= ORPHAN_GRACE_MS;
    })
    .map((k) => k.name);
  let deleted = 0;
  if (orphanKeys.length > 0 && (await hasOpBudget(env, "delete", orphanKeys.length, nowMs))) {
    await deleteKeys(env, orphanKeys, nowMs);
    deleted = orphanKeys.length;
  }

  if (!listed.list_complete) {
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('orphan_cursor', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1")
      .bind(listed.cursor)
      .run();
  } else if (cursorRow) {
    await env.DB.prepare("DELETE FROM meta WHERE key = 'orphan_cursor'").run();
  }
  return deleted;
}

export function computeExpiresAt(uploadedAt: number): number {
  return uploadedAt + RETENTION_MS;
}
