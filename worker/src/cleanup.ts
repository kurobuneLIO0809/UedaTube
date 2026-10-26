// 動画の完全削除と、Cron Trigger による期限切れデータの定期削除
import type { Env } from "./env";
import { RETENTION_MS } from "../../shared/constants";
import { type VideoRow, videoIdFromKey } from "./db";

/** アップロードが完了しないまま放置された動画を削除するまでの時間 */
export const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
/** R2上にあってD1に無いファイルを孤立ファイルとみなすまでの時間 */
export const ORPHAN_GRACE_MS = 6 * 60 * 60 * 1000;
/** 1回の定期処理で削除する動画の最大数（Workersの実行時間・サブリクエスト上限に配慮） */
export const CLEANUP_BATCH = 10;
const ORPHAN_SCAN_LIMIT = 100;

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
 * 動画を完全に削除する（R2の動画・サムネイル、D1のコメント・メタデータ）。
 * 失敗した場合は status='deleting' のまま残し、次回の定期処理で再試行する。
 * 既に削除済みのファイルを削除しても失敗しない（R2のdeleteは存在しないキーでも成功する）。
 */
export async function deleteVideoCompletely(env: Env, video: VideoRow, nowMs: number): Promise<DeleteResult> {
  // まず視聴不可の状態にする（以降の処理が失敗しても再公開されない）
  await env.DB.prepare("UPDATE videos SET status = 'deleting', commentsEnabled = 0, updatedAt = ?2 WHERE id = ?1")
    .bind(video.id, nowMs)
    .run();
  try {
    if (video.uploadId) {
      try {
        await env.BUCKET.resumeMultipartUpload(video.r2Key, video.uploadId).abort();
      } catch {
        // 既に完了・中止済みのアップロードは無視してよい
      }
    }
    const keys = [video.r2Key, video.thumbnailKey].filter((k): k is string => !!k);
    await env.BUCKET.delete(keys);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM comments WHERE videoId = ?1").bind(video.id),
      env.DB.prepare("DELETE FROM videos WHERE id = ?1").bind(video.id),
    ]);
    return { ok: true };
  } catch (err) {
    const error = safeError(err);
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
 * R2に残っているがD1に対応する動画が無いファイル（アップロード処理の途中失敗などで生じた孤立ファイル）を削除する。
 * 1回の実行で一部ずつ検査し、続きの位置をmetaテーブルに保存する。
 */
export async function sweepOrphanObjects(env: Env, nowMs: number): Promise<number> {
  const cursorRow = await env.DB.prepare("SELECT value FROM meta WHERE key = 'orphan_cursor'").first<{ value: string }>();
  const listed = await env.BUCKET.list({
    prefix: "videos/",
    limit: ORPHAN_SCAN_LIMIT,
    ...(cursorRow ? { cursor: cursorRow.value } : {}),
  });

  const ids = [...new Set(listed.objects.map((o) => videoIdFromKey(o.key)).filter((x): x is string => !!x))];
  const existing = new Set<string>();
  if (ids.length > 0) {
    const res = await env.DB.prepare(`SELECT id FROM videos WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...ids)
      .all<{ id: string }>();
    for (const r of res.results) existing.add(r.id);
  }
  const orphanKeys = listed.objects
    .filter((o) => {
      const id = videoIdFromKey(o.key);
      // 想定外のキー、またはD1に無い動画のファイルで、一定時間以上経過したもの
      return (id === null || !existing.has(id)) && nowMs - o.uploaded.getTime() >= ORPHAN_GRACE_MS;
    })
    .map((o) => o.key);
  if (orphanKeys.length > 0) await env.BUCKET.delete(orphanKeys);

  if (listed.truncated) {
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('orphan_cursor', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1")
      .bind(listed.cursor)
      .run();
  } else if (cursorRow) {
    await env.DB.prepare("DELETE FROM meta WHERE key = 'orphan_cursor'").run();
  }
  return orphanKeys.length;
}

export function computeExpiresAt(uploadedAt: number): number {
  return uploadedAt + RETENTION_MS;
}
