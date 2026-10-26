// 管理者専用API。すべてのハンドラーの先頭で requireSession(..., "admin") を必ず実行する。
import { ALLOWED_THUMBNAIL_MIME, ALLOWED_VIDEO_MIME, MAX_THUMBNAIL_BYTES } from "../../../shared/constants";
import { Mp4Error, assertSupportedMp4, parseMp4, type ByteReader } from "../../../shared/mp4";
import { validateVideoMeta } from "../../../shared/validation";
import { requireSession } from "../auth";
import { computeExpiresAt, deleteVideoCompletely, runCleanup } from "../cleanup";
import { getConfig } from "../config";
import {
  UUID_RE,
  adminVideo,
  commentCounts,
  getVideo,
  isExpired,
  publicComment,
  thumbnailKey,
  videoKey,
  type CommentRow,
  type VideoRow,
} from "../db";
import { HttpError, json, readJson, readLimited } from "../http";
import type { Ctx } from "../router";

const admin = (ctx: Ctx) => requireSession(ctx.request, ctx.env, "admin", ctx.now);

function videoIdParam(ctx: Ctx): string {
  if (!UUID_RE.test(ctx.params.id)) throw new HttpError(404, "NOT_FOUND", "動画が見つかりません。");
  return ctx.params.id;
}

async function requireVideo(ctx: Ctx): Promise<VideoRow> {
  const v = await getVideo(ctx.env.DB, videoIdParam(ctx));
  if (!v) throw new HttpError(404, "NOT_FOUND", "動画が見つかりません。");
  return v;
}

function partCount(v: Pick<VideoRow, "fileSize" | "partSize">): number {
  return Math.ceil(v.fileSize / v.partSize);
}

function expectedPartLength(v: Pick<VideoRow, "fileSize" | "partSize">, n: number): number {
  const total = partCount(v);
  return n < total ? v.partSize : v.fileSize - v.partSize * (total - 1);
}

/** R2オブジェクトを範囲読み込みする ByteReader */
function r2Reader(bucket: R2Bucket, key: string, size: number): ByteReader {
  return {
    size,
    async read(offset, length) {
      const len = Math.max(0, Math.min(length, size - offset));
      if (len === 0) return new Uint8Array();
      const obj = await bucket.get(key, { range: { offset, length: len } });
      if (!obj) throw new Mp4Error("CORRUPT", "動画ファイルを読み込めませんでした。");
      return new Uint8Array(await obj.arrayBuffer());
    },
  };
}

/** POST /api/admin/videos アップロードの開始（R2マルチパートアップロードを作成） */
export async function createUpload(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const { env, now } = ctx;
  const cfg = getConfig(env);
  const body = (await readJson(ctx.request, 8 * 1024)) as Record<string, unknown>;

  const meta = validateVideoMeta(body);
  if (!meta.ok) throw new HttpError(400, "INVALID_INPUT", meta.errors[0], meta.errors);
  const errors: string[] = [];
  if (body.contentType !== ALLOWED_VIDEO_MIME) errors.push("MP4形式（video/mp4）の動画のみアップロードできます。");
  if (typeof body.fileName !== "string" || !/\.mp4$/i.test(body.fileName)) errors.push("拡張子が .mp4 のファイルを選択してください。");
  const fileSize = body.fileSize;
  if (!Number.isInteger(fileSize) || (fileSize as number) <= 0) errors.push("ファイルサイズが不正です。");
  else if ((fileSize as number) > cfg.maxUploadBytes) {
    errors.push(`ファイルサイズが上限（${Math.floor(cfg.maxUploadBytes / 1024 / 1024)}MB）を超えています。`);
  }
  if (errors.length) throw new HttpError(400, "INVALID_INPUT", errors[0], errors);
  const publish = body.publish !== false;

  const id = crypto.randomUUID();
  const key = videoKey(id);
  const upload = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: ALLOWED_VIDEO_MIME } });
  try {
    await env.DB.prepare(
      `INSERT INTO videos (id, title, description, category, r2Key, fileSize, contentType, uploadId, partSize,
         createdAt, status, publishOnComplete, commentsEnabled, updatedAt)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'uploading', ?11, 1, ?10)`,
    )
      .bind(id, meta.value.title, meta.value.description ?? "", meta.value.category, key, fileSize, ALLOWED_VIDEO_MIME, upload.uploadId, cfg.uploadPartBytes, now, publish ? 1 : 0)
      .run();
  } catch (err) {
    // D1への登録に失敗した場合はR2側を中止して孤立させない
    await upload.abort().catch(() => undefined);
    throw err;
  }
  const v = { fileSize: fileSize as number, partSize: cfg.uploadPartBytes };
  return json({ videoId: id, partSize: cfg.uploadPartBytes, partCount: partCount(v) }, 201);
}

/** PUT /api/admin/videos/:id/parts/:part 分割アップロードの1パート */
export async function uploadPart(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const v = await requireVideo(ctx);
  if (v.status !== "uploading" || !v.uploadId) throw new HttpError(409, "NOT_UPLOADING", "この動画はアップロード中ではありません。");
  const n = Number(ctx.params.part);
  if (!Number.isInteger(n) || n < 1 || n > partCount(v)) throw new HttpError(400, "INVALID_PART", "パート番号が不正です。");
  const expected = expectedPartLength(v, n);
  const declared = Number(ctx.request.headers.get("Content-Length"));
  if (!ctx.request.body || declared !== expected) {
    throw new HttpError(400, "INVALID_PART_SIZE", `パートの大きさが不正です（期待値 ${expected} バイト）。`);
  }
  const upload = ctx.env.BUCKET.resumeMultipartUpload(v.r2Key, v.uploadId);
  // 長さが確定したストリームとしてR2に渡す（本文をメモリに溜めない）
  const body =
    typeof FixedLengthStream === "function"
      ? ctx.request.body.pipeThrough(new FixedLengthStream(expected))
      : ctx.request.body;
  try {
    const part = await upload.uploadPart(n, body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  } catch (err) {
    console.warn(JSON.stringify({ event: "upload_part_failed", videoId: v.id, part: n, error: String(err).slice(0, 200) }));
    throw new HttpError(502, "PART_FAILED", "パートのアップロードに失敗しました。再試行してください。");
  }
}

async function markFailed(ctx: Ctx, v: VideoRow, reason: string): Promise<void> {
  // 不正な動画はR2から即座に削除し、失敗理由だけをD1に残す（行は24時間後に定期処理で削除）
  await ctx.env.BUCKET.delete(v.r2Key).catch(() => undefined);
  await ctx.env.DB.prepare("UPDATE videos SET status = 'failed', uploadId = NULL, failureReason = ?2, updatedAt = ?3 WHERE id = ?1")
    .bind(v.id, reason.slice(0, 500), ctx.now)
    .run();
}

/** POST /api/admin/videos/:id/complete 全パートの結合とMP4の検査 */
export async function completeUpload(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const v = await requireVideo(ctx);
  if (v.status !== "uploading" || !v.uploadId) throw new HttpError(409, "NOT_UPLOADING", "この動画はアップロード中ではありません。");
  const body = (await readJson(ctx.request, 512 * 1024)) as { parts?: unknown };
  const total = partCount(v);
  const parts = body.parts;
  if (
    !Array.isArray(parts) ||
    parts.length !== total ||
    !parts.every(
      (p, i) =>
        typeof p === "object" && p !== null && (p as R2UploadedPart).partNumber === i + 1 && typeof (p as R2UploadedPart).etag === "string",
    )
  ) {
    throw new HttpError(400, "INVALID_PARTS", "パートの一覧が不正です。");
  }

  try {
    await ctx.env.BUCKET.resumeMultipartUpload(v.r2Key, v.uploadId).complete(
      (parts as R2UploadedPart[]).map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
    );
  } catch (err) {
    console.warn(JSON.stringify({ event: "upload_complete_failed", videoId: v.id, error: String(err).slice(0, 200) }));
    throw new HttpError(502, "COMPLETE_FAILED", "動画ファイルの結合に失敗しました。再試行してください。");
  }

  const head = await ctx.env.BUCKET.head(v.r2Key);
  if (!head || head.size !== v.fileSize) {
    await markFailed(ctx, v, "アップロードされたファイルのサイズが一致しません。");
    throw new HttpError(422, "SIZE_MISMATCH", "アップロードされたファイルのサイズが一致しません。");
  }

  // サーバー側でもMP4の形式・解像度・コーデックを検査する（ブラウザの検査は信用しない）
  let info;
  try {
    info = await parseMp4(r2Reader(ctx.env.BUCKET, v.r2Key, head.size));
    assertSupportedMp4(info);
  } catch (err) {
    const message = err instanceof Mp4Error ? err.message : "動画ファイルを解析できませんでした。";
    await markFailed(ctx, v, message);
    throw new HttpError(422, err instanceof Mp4Error ? err.code : "INVALID_VIDEO", message);
  }

  const uploadedAt = ctx.now;
  const status = v.publishOnComplete === 1 ? "published" : "hidden";
  await ctx.env.DB.prepare(
    `UPDATE videos SET status = ?2, uploadId = NULL, width = ?3, height = ?4, durationSeconds = ?5, videoCodec = ?6,
       uploadedAt = ?7, expiresAt = ?8, updatedAt = ?7 WHERE id = ?1`,
  )
    .bind(v.id, status, info.width, info.height, info.durationSeconds, info.videoCodec, uploadedAt, computeExpiresAt(uploadedAt))
    .run();
  const updated = await getVideo(ctx.env.DB, v.id);
  return json({ video: adminVideo(updated!, 0, ctx.now) });
}

/** DELETE /api/admin/videos/:id 動画の削除（アップロード中の場合は中止） */
export async function deleteVideo(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const v = await requireVideo(ctx);
  const r = await deleteVideoCompletely(ctx.env, v, ctx.now);
  if (!r.ok) {
    throw new HttpError(500, "DELETE_FAILED", "削除の一部に失敗しました。動画は視聴不可にしてあり、自動削除で再試行されます。");
  }
  console.log(JSON.stringify({ event: "video_deleted", videoId: v.id, by: "admin" }));
  return json({ deleted: true });
}

/** PATCH /api/admin/videos/:id タイトル等の変更・公開状態・コメント受付 */
export async function updateVideo(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const v = await requireVideo(ctx);
  if (v.status !== "published" && v.status !== "hidden") {
    throw new HttpError(409, "NOT_EDITABLE", "この状態の動画は編集できません。");
  }
  if (isExpired(v, ctx.now)) {
    throw new HttpError(410, "EXPIRED", "公開期限を過ぎた動画は変更・再公開できません。");
  }
  const body = (await readJson(ctx.request, 8 * 1024)) as Record<string, unknown>;
  const meta = validateVideoMeta(body, true);
  if (!meta.ok) throw new HttpError(400, "INVALID_INPUT", meta.errors[0], meta.errors);

  const sets: string[] = [];
  const binds: unknown[] = [v.id];
  const add = (col: string, val: unknown) => {
    binds.push(val);
    sets.push(`${col} = ?${binds.length}`);
  };
  for (const k of ["title", "description", "category"] as const) if (meta.value[k] !== undefined) add(k, meta.value[k]);
  if (body.status !== undefined) {
    if (body.status !== "published" && body.status !== "hidden") throw new HttpError(400, "INVALID_INPUT", "公開状態が不正です。");
    add("status", body.status);
  }
  if (body.commentsEnabled !== undefined) {
    if (typeof body.commentsEnabled !== "boolean") throw new HttpError(400, "INVALID_INPUT", "コメント受付の値が不正です。");
    add("commentsEnabled", body.commentsEnabled ? 1 : 0);
  }
  if (sets.length === 0) throw new HttpError(400, "INVALID_INPUT", "変更する項目がありません。");
  add("updatedAt", ctx.now);
  // 条件付き更新：同時に期限切れ・削除が起きても再公開されない
  binds.push(ctx.now);
  await ctx.env.DB.prepare(
    `UPDATE videos SET ${sets.join(", ")} WHERE id = ?1 AND status IN ('published', 'hidden') AND expiresAt > ?${binds.length}`,
  )
    .bind(...binds)
    .run();
  const updated = await getVideo(ctx.env.DB, v.id);
  const counts = await commentCounts(ctx.env.DB, [v.id], true);
  return json({ video: adminVideo(updated!, counts.get(v.id) ?? 0, ctx.now) });
}

function detectImageType(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (
    b.length >= 12 &&
    String.fromCharCode(b[0], b[1], b[2], b[3]) === "RIFF" &&
    String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** PUT /api/admin/videos/:id/thumbnail サムネイル画像の登録 */
export async function putThumbnail(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const v = await requireVideo(ctx);
  if (v.status === "deleting" || v.status === "failed" || (v.expiresAt !== null && isExpired(v, ctx.now))) {
    throw new HttpError(409, "NOT_EDITABLE", "この動画にはサムネイルを設定できません。");
  }
  const ct = (ctx.request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!(ALLOWED_THUMBNAIL_MIME as readonly string[]).includes(ct)) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "サムネイルはJPEG・PNG・WebP形式にしてください。");
  }
  const bytes = await readLimited(ctx.request, MAX_THUMBNAIL_BYTES);
  const actual = detectImageType(bytes);
  if (!actual || actual !== ct) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "画像ファイルの内容が形式と一致しません。");
  const key = thumbnailKey(v.id);
  await ctx.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: actual } });
  const res = await ctx.env.DB.prepare(
    "UPDATE videos SET thumbnailKey = ?2, updatedAt = ?3 WHERE id = ?1 AND status IN ('uploading', 'published', 'hidden')",
  )
    .bind(v.id, key, ctx.now)
    .run();
  if (!res.meta.changes) {
    // 途中で削除された場合はサムネイルも消して孤立させない
    await ctx.env.BUCKET.delete(key);
    throw new HttpError(409, "NOT_EDITABLE", "この動画にはサムネイルを設定できません。");
  }
  return json({ ok: true });
}

/** POST /api/admin/videos/:id/inspect 保存されているファイルが再生可能か検査する */
export async function inspectVideo(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const v = await requireVideo(ctx);
  const checks: { name: string; ok: boolean; message: string }[] = [];
  const head = await ctx.env.BUCKET.head(v.r2Key);
  checks.push({ name: "file", ok: !!head, message: head ? "R2に動画ファイルがあります。" : "R2に動画ファイルがありません。" });
  if (head) {
    const sizeOk = head.size === v.fileSize;
    checks.push({ name: "size", ok: sizeOk, message: sizeOk ? `サイズ一致（${head.size} バイト）` : `サイズ不一致（記録 ${v.fileSize} / 実際 ${head.size}）` });
    try {
      const info = await parseMp4(r2Reader(ctx.env.BUCKET, v.r2Key, head.size));
      assertSupportedMp4(info);
      checks.push({ name: "mp4", ok: true, message: `MP4 ${info.videoCodec} ${info.width}×${info.height} / ${info.durationSeconds.toFixed(1)}秒` });
    } catch (err) {
      checks.push({ name: "mp4", ok: false, message: err instanceof Mp4Error ? err.message : "解析できませんでした。" });
    }
  }
  const expired = isExpired(v, ctx.now);
  checks.push({ name: "expiry", ok: !expired, message: expired ? "公開期限切れ、またはアップロード未完了です。" : "公開期限内です。" });
  return json({ ok: checks.every((c) => c.ok), checks });
}

/** GET /api/admin/videos すべての動画（非公開・失敗を含む） */
export async function adminListVideos(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const rows = await ctx.env.DB.prepare("SELECT * FROM videos ORDER BY createdAt DESC LIMIT 500").all<VideoRow>();
  const counts = await commentCounts(ctx.env.DB, rows.results.map((v) => v.id), true);
  return json({ videos: rows.results.map((v) => adminVideo(v, counts.get(v.id) ?? 0, ctx.now)) });
}

/** GET /api/admin/videos/:id 動画1件（管理者用） */
export async function adminGetVideo(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const v = await requireVideo(ctx);
  const counts = await commentCounts(ctx.env.DB, [v.id], true);
  return json({ video: adminVideo(v, counts.get(v.id) ?? 0, ctx.now) });
}

/** GET /api/admin/videos/:id/comments 非表示を含むコメント一覧（新しい順・ページ送り） */
export async function adminListComments(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const v = await requireVideo(ctx);
  const limit = Math.min(200, Math.max(1, Number(ctx.url.searchParams.get("limit")) || 50));
  const offset = Math.max(0, Number(ctx.url.searchParams.get("offset")) || 0);
  const rows = await ctx.env.DB.prepare("SELECT * FROM comments WHERE videoId = ?1 ORDER BY id DESC LIMIT ?2 OFFSET ?3")
    .bind(v.id, limit, offset)
    .all<CommentRow>();
  const total = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE videoId = ?1").bind(v.id).first<{ n: number }>();
  return json({ comments: rows.results.map((c) => publicComment(c, true)), total: total?.n ?? 0 });
}

function commentIdParam(ctx: Ctx): number {
  if (!/^\d{1,15}$/.test(ctx.params.id)) throw new HttpError(404, "NOT_FOUND", "コメントが見つかりません。");
  return Number(ctx.params.id);
}

/** PATCH /api/admin/comments/:id 非表示・再表示 */
export async function updateComment(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const id = commentIdParam(ctx);
  const body = (await readJson(ctx.request, 1024)) as { hidden?: unknown };
  if (typeof body.hidden !== "boolean") throw new HttpError(400, "INVALID_INPUT", "hidden の値が不正です。");
  const row = await ctx.env.DB.prepare("UPDATE comments SET hidden = ?2 WHERE id = ?1 RETURNING *")
    .bind(id, body.hidden ? 1 : 0)
    .first<CommentRow>();
  if (!row) throw new HttpError(404, "NOT_FOUND", "コメントが見つかりません。");
  return json({ comment: publicComment(row, true) });
}

/** DELETE /api/admin/comments/:id */
export async function deleteComment(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const id = commentIdParam(ctx);
  const res = await ctx.env.DB.prepare("DELETE FROM comments WHERE id = ?1").bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, "NOT_FOUND", "コメントが見つかりません。");
  return json({ deleted: true });
}

/** GET /api/admin/dashboard 統計と管理情報 */
export async function dashboard(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const { DB } = ctx.env;
  const now = ctx.now;
  const [byStatus, comments, storage, expiringSoon, failed, runs] = await DB.batch([
    DB.prepare(
      `SELECT CASE WHEN status IN ('published','hidden') AND expiresAt <= ?1 THEN 'expired' ELSE status END AS status,
              COUNT(*) AS n FROM videos GROUP BY 1`,
    ).bind(now),
    DB.prepare("SELECT COUNT(*) AS n, SUM(hidden) AS hidden FROM comments"),
    DB.prepare("SELECT COALESCE(SUM(fileSize), 0) AS bytes FROM videos WHERE status IN ('published','hidden')"),
    DB.prepare(
      "SELECT id, title, expiresAt FROM videos WHERE status IN ('published','hidden') AND expiresAt > ?1 AND expiresAt <= ?2 ORDER BY expiresAt LIMIT 20",
    ).bind(now, now + 2 * 24 * 60 * 60 * 1000),
    DB.prepare(
      "SELECT id, title, status, failureReason, lastDeleteError, deleteAttempts, createdAt FROM videos WHERE status IN ('failed','deleting') OR (status = 'uploading' AND createdAt < ?1) ORDER BY createdAt DESC LIMIT 50",
    ).bind(now - 60 * 60 * 1000),
    DB.prepare("SELECT * FROM cleanup_runs ORDER BY id DESC LIMIT 10"),
  ]);
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const statusCounts: Record<string, number> = {};
  for (const r of byStatus.results as { status: string; n: number }[]) statusCounts[r.status] = r.n;
  const c = (comments.results[0] ?? {}) as { n?: number; hidden?: number };
  return json({
    now: iso(now),
    videos: statusCounts,
    comments: { total: c.n ?? 0, hidden: c.hidden ?? 0 },
    storageBytes: (storage.results[0] as { bytes: number } | undefined)?.bytes ?? 0,
    expiringSoon: (expiringSoon.results as { id: string; title: string; expiresAt: number }[]).map((r) => ({
      ...r,
      expiresAt: iso(r.expiresAt),
    })),
    problems: (failed.results as (Record<string, unknown> & { createdAt: number })[]).map((r) => ({
      ...r,
      createdAt: iso(r.createdAt),
    })),
    cleanupRuns: (runs.results as { ranAt: number; errors: string | null }[]).map((r) => ({
      ...r,
      ranAt: iso(r.ranAt),
      errors: r.errors ? (JSON.parse(r.errors) as string[]) : [],
    })),
    limits: { maxUploadBytes: getConfig(ctx.env).maxUploadBytes, partSize: getConfig(ctx.env).uploadPartBytes },
  });
}

/** POST /api/admin/cleanup 自動削除を手動で実行する（動作確認用） */
export async function manualCleanup(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  return json({ summary: await runCleanup(ctx.env, ctx.now) });
}
