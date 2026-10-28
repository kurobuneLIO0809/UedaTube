// 管理者専用API。すべてのハンドラーの先頭で requireSession(..., "admin") を必ず実行する。
import { ALLOWED_THUMBNAIL_MIME, ALLOWED_VIDEO_MIME, MAX_THUMBNAIL_BYTES } from "../../../shared/constants";
import { Mp4Error, assertSupportedMp4, parseMp4 } from "../../../shared/mp4";
import { validateVideoMeta } from "../../../shared/validation";
import { requireSession } from "../auth";
import { computeExpiresAt, deleteVideoCompletely, runCleanup } from "../cleanup";
import { getConfig } from "../config";
import { UUID_RE, adminVideo, commentCounts, getVideo, isExpired, publicComment, type CommentRow, type VideoRow } from "../db";
import {
  ChunkNotReadyError,
  STALE_UPLOAD_MS,
  chunkCount,
  chunkKey,
  chunkLength,
  chunkedReader,
  deleteKeys,
  hasOpBudget,
  opsToday,
  pendingChunkWrites,
  putChunk,
  recordOps,
  requireOpBudget,
  storagePrefix,
  storageUsage,
  thumbKey,
  thumbTtlSeconds,
} from "../storage";
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

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** KV への保存がまだ反映されていない場合の応答（数秒後の再試行で解決する） */
function notReady(): HttpError {
  return new HttpError(503, "NOT_READY", "保存した動画の反映を待っています。数秒後に再試行してください。", undefined, { "Retry-After": "3" });
}

/** 同時に進行できるアップロード（status = 'uploading'）の上限 */
export const MAX_CONCURRENT_UPLOADS = 3;

/**
 * 元動画の情報（任意）。ブラウザで自動変換した場合に、変換前の解像度などを管理者向けに記録する。
 * 参考情報であり、保存される動画の検査には使わない（検査は complete 時にサーバーが実ファイルで行う）。
 */
function parseSource(raw: unknown, errors: string[]) {
  const out = { width: null as number | null, height: null as number | null, codec: null as string | null, transcoded: false };
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object") {
    errors.push("元動画の情報の形式が不正です。");
    return out;
  }
  const r = raw as Record<string, unknown>;
  const dim = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 16384 ? (v as number) : null);
  if (r.width !== undefined && r.width !== null && dim(r.width) === null) errors.push("元動画の幅が不正です。");
  if (r.height !== undefined && r.height !== null && dim(r.height) === null) errors.push("元動画の高さが不正です。");
  if (r.codec !== undefined && r.codec !== null && (typeof r.codec !== "string" || !/^[A-Za-z0-9 ._-]{1,32}$/.test(r.codec))) {
    errors.push("元動画のコーデック名が不正です。");
  }
  if (r.transcoded !== undefined && typeof r.transcoded !== "boolean") errors.push("変換の有無の値が不正です。");
  out.width = dim(r.width);
  out.height = dim(r.height);
  out.codec = typeof r.codec === "string" && /^[A-Za-z0-9 ._-]{1,32}$/.test(r.codec) ? r.codec : null;
  out.transcoded = r.transcoded === true;
  return out;
}

/**
 * POST /api/admin/videos アップロードの開始。
 * KV の容量（合計の上限）と今日の書き込み回数に余裕があるかを先に確かめ、動画の大きさ分を予約する。
 */
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
  const source = parseSource(body.source, errors);
  if (errors.length) throw new HttpError(400, "INVALID_INPUT", errors[0], errors);
  const publish = body.publish !== false;

  // 同時に進行できるアップロード数を制限する（放置されたものは24時間後に自動削除）
  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM videos WHERE status = 'uploading' AND createdAt > ?1")
    .bind(now - STALE_UPLOAD_MS)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_CONCURRENT_UPLOADS) {
    throw new HttpError(
      429,
      "TOO_MANY_UPLOADS",
      `同時に進行できるアップロードは${MAX_CONCURRENT_UPLOADS}件までです。進行中のアップロードが終わるか、管理画面で中止してから再度お試しください。`,
    );
  }

  // KV の容量（合計）の確認。アップロード中の動画の予約分も含める
  const used = await storageUsage(env.DB);
  const size = fileSize as number;
  if (used + size > cfg.kvStorageLimitBytes) {
    throw new HttpError(
      507,
      "STORAGE_FULL",
      `動画の保存領域が足りません（使用中 ${formatMb(used)} / 上限 ${formatMb(cfg.kvStorageLimitBytes)}、この動画 ${formatMb(size)}）。` +
        "古い動画を削除するか、14日後の自動削除を待ってください。",
    );
  }
  // 今日の KV 書き込み回数の確認（塊の数＋サムネイル1回。進行中のアップロードの残りも含める）
  const chunks = chunkCount({ fileSize: size, partSize: cfg.uploadPartBytes });
  const pending = await pendingChunkWrites(env.DB, now);
  await requireOpBudget(env, "write", pending + chunks + 1, now);

  const id = crypto.randomUUID();
  const key = storagePrefix(id);
  {
    await env.DB.prepare(
      `INSERT INTO videos (id, title, description, category, storageKey, fileSize, contentType, uploadId, partSize,
         createdAt, status, publishOnComplete, commentsEnabled, updatedAt, sourceWidth, sourceHeight, sourceCodec, transcoded)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'uploading', ?11, 1, ?10, ?12, ?13, ?14, ?15)`,
    )
      .bind(
        id,
        meta.value.title,
        meta.value.description ?? "",
        meta.value.category,
        key,
        fileSize,
        ALLOWED_VIDEO_MIME,
        null,
        cfg.uploadPartBytes,
        now,
        publish ? 1 : 0,
        source.width,
        source.height,
        source.codec,
        source.transcoded ? 1 : 0,
      )
      .run();
  }
  return json({ videoId: id, partSize: cfg.uploadPartBytes, partCount: chunks }, 201);
}

/** PUT /api/admin/videos/:id/parts/:part 分割アップロードの1パート（＝KV に保存する塊1つ） */
export async function uploadPart(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const v = await requireVideo(ctx);
  if (v.status !== "uploading") throw new HttpError(409, "NOT_UPLOADING", "この動画はアップロード中ではありません。");
  const n = Number(ctx.params.part);
  if (!Number.isInteger(n) || n < 1 || n > chunkCount(v)) throw new HttpError(400, "INVALID_PART", "パート番号が不正です。");
  const idx = n - 1;
  const expected = chunkLength(v, idx);
  const declared = Number(ctx.request.headers.get("Content-Length"));
  if (!ctx.request.body || declared !== expected) {
    throw new HttpError(400, "INVALID_PART_SIZE", `パートの大きさが不正です（期待値 ${expected} バイト）。`);
  }
  // 上限ぎりぎりでの書き込みを防ぐ（createUpload で予約済みだが、他の操作で使われた場合に備える）
  await requireOpBudget(ctx.env, "write", 1, ctx.now);
  const bytes = await readLimited(ctx.request, expected);
  if (bytes.byteLength !== expected) {
    throw new HttpError(400, "INVALID_PART_SIZE", `パートの大きさが不正です（期待値 ${expected} バイト）。`);
  }
  try {
    await putChunk(ctx.env, v.storageKey, idx, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, ctx.now);
  } catch (err) {
    console.warn(JSON.stringify({ event: "upload_part_failed", videoId: v.id, part: n, error: String(err).slice(0, 200) }));
    throw new HttpError(502, "PART_FAILED", "パートの保存に失敗しました。再試行してください。");
  }
  await ctx.env.DB.prepare(
    "INSERT INTO video_chunks (videoId, idx, size) VALUES (?1, ?2, ?3) ON CONFLICT (videoId, idx) DO UPDATE SET size = ?3",
  )
    .bind(v.id, idx, expected)
    .run();
  return json({ partNumber: n, etag: `${v.id}-${idx}` });
}

/** 不正な動画は KV から削除し（回数に余裕があれば）、失敗理由だけを D1 に残す（行は24時間後に定期処理で削除） */
async function markFailed(ctx: Ctx, v: VideoRow, reason: string): Promise<void> {
  const chunks = await ctx.env.DB.prepare("SELECT idx FROM video_chunks WHERE videoId = ?1").bind(v.id).all<{ idx: number }>();
  const keys = chunks.results.map((c) => chunkKey(v.storageKey, c.idx));
  if (keys.length && (await hasOpBudget(ctx.env, "delete", keys.length, ctx.now))) {
    try {
      await deleteKeys(ctx.env, keys, ctx.now);
      await ctx.env.DB.prepare("DELETE FROM video_chunks WHERE videoId = ?1").bind(v.id).run();
    } catch {
      // 残った塊は定期処理（または KV の有効期限）で削除される
    }
  }
  await ctx.env.DB.prepare("UPDATE videos SET status = 'failed', uploadId = NULL, failureReason = ?2, updatedAt = ?3 WHERE id = ?1")
    .bind(v.id, reason.slice(0, 500), ctx.now)
    .run();
}

/** POST /api/admin/videos/:id/complete 全パートがそろったか確認し、MP4 を検査して公開する */
export async function completeUpload(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const v = await requireVideo(ctx);
  if (v.status !== "uploading") throw new HttpError(409, "NOT_UPLOADING", "この動画はアップロード中ではありません。");
  // 本文（パートの一覧）は互換のため受け取るが、そろっているかは D1 の記録で判定する
  await readJson(ctx.request, 512 * 1024).catch(() => undefined);
  const total = chunkCount(v);
  const got = await ctx.env.DB.prepare("SELECT idx, size FROM video_chunks WHERE videoId = ?1 ORDER BY idx")
    .bind(v.id)
    .all<{ idx: number; size: number }>();
  const have = new Set(got.results.map((c) => c.idx));
  const missing = Array.from({ length: total }, (_, i) => i).filter((i) => !have.has(i));
  if (missing.length) {
    throw new HttpError(400, "MISSING_PARTS", `まだ届いていないパートがあります（${missing.slice(0, 5).map((i) => i + 1).join(", ")}${missing.length > 5 ? " ほか" : ""}）。`);
  }
  const sum = got.results.reduce((a, c) => a + c.size, 0);
  if (sum !== v.fileSize) {
    await markFailed(ctx, v, "アップロードされたファイルのサイズが一致しません。");
    throw new HttpError(422, "SIZE_MISMATCH", "アップロードされたファイルのサイズが一致しません。");
  }

  // サーバー側でも MP4 の形式・解像度・コーデックを検査する（ブラウザの検査は信用しない）
  let info;
  try {
    info = await parseMp4(chunkedReader(ctx.env, v));
    assertSupportedMp4(info);
  } catch (err) {
    if (err instanceof ChunkNotReadyError) throw notReady();
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
  const cfg = getConfig(ctx.env);
  const used = await storageUsage(ctx.env.DB);
  if (used - v.thumbnailBytes + bytes.byteLength > cfg.kvStorageLimitBytes) {
    throw new HttpError(507, "STORAGE_FULL", "動画の保存領域が足りないため、サムネイルを保存できません。");
  }
  await requireOpBudget(ctx.env, "write", 1, ctx.now);
  const key = thumbKey(v.storageKey);
  await ctx.env.MEDIA.put(key, bytes, {
    expirationTtl: thumbTtlSeconds(v.expiresAt, ctx.now),
    metadata: { t: ctx.now, ct: actual },
  });
  await recordOps(ctx.env.DB, "write", 1, ctx.now);
  const res = await ctx.env.DB.prepare(
    "UPDATE videos SET thumbnailKey = ?2, thumbnailBytes = ?3, updatedAt = ?4 WHERE id = ?1 AND status IN ('uploading', 'published', 'hidden')",
  )
    .bind(v.id, key, bytes.byteLength, ctx.now)
    .run();
  if (!res.meta.changes) {
    // 途中で削除された場合はサムネイルも消して孤立させない
    await deleteKeys(ctx.env, [key], ctx.now).catch(() => undefined);
    throw new HttpError(409, "NOT_EDITABLE", "この動画にはサムネイルを設定できません。");
  }
  return json({ ok: true });
}

/** POST /api/admin/videos/:id/inspect 保存されているファイルが再生可能か検査する */
export async function inspectVideo(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  const v = await requireVideo(ctx);
  const checks: { name: string; ok: boolean; message: string }[] = [];
  const total = chunkCount(v);
  // KV の一覧取得は1日の回数制限が厳しいため、塊は D1 の記録と KV からの実際の読み込みで確認する
  const recorded = await ctx.env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM video_chunks WHERE videoId = ?1")
    .bind(v.id)
    .first<{ n: number; bytes: number }>();
  const complete = recorded?.n === total && recorded.bytes === v.fileSize;
  checks.push({
    name: "chunks",
    ok: complete,
    message: complete ? `保存されている塊：${total}個（${v.fileSize} バイト）` : `塊がそろっていません（記録 ${recorded?.n ?? 0} / 必要 ${total}）`,
  });
  if (complete) {
    try {
      const info = await parseMp4(chunkedReader(ctx.env, v));
      assertSupportedMp4(info);
      checks.push({ name: "mp4", ok: true, message: `MP4 ${info.videoCodec} ${info.width}×${info.height} / ${info.durationSeconds.toFixed(1)}秒` });
    } catch (err) {
      checks.push({
        name: "mp4",
        ok: false,
        message:
          err instanceof ChunkNotReadyError
            ? `KV に塊 ${err.idx + 1} が見つかりません（保存直後なら数秒後に再検査してください）。`
            : err instanceof Mp4Error
              ? err.message
              : "解析できませんでした。",
      });
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
  const [byStatus, comments, expiringSoon, failed, runs] = await DB.batch([
    DB.prepare(
      `SELECT CASE WHEN status IN ('published','hidden') AND expiresAt <= ?1 THEN 'expired' ELSE status END AS status,
              COUNT(*) AS n FROM videos GROUP BY 1`,
    ).bind(now),
    DB.prepare("SELECT COUNT(*) AS n, SUM(hidden) AS hidden FROM comments"),
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
  const cfg = getConfig(ctx.env);
  const usedBytes = await storageUsage(DB);
  const ops = await opsToday(DB, now);
  return json({
    now: iso(now),
    videos: statusCounts,
    comments: { total: c.n ?? 0, hidden: c.hidden ?? 0 },
    storageBytes: usedBytes,
    // 動画の保存領域（Workers KV 無料プラン）の使用状況
    kv: {
      usedBytes,
      limitBytes: cfg.kvStorageLimitBytes,
      opsToday: ops,
      opsLimits: cfg.kvDailyLimits,
      resetsAt: new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1)).toISOString(),
    },
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
    limits: {
      maxUploadBytes: cfg.maxUploadBytes,
      partSize: cfg.uploadPartBytes,
      // 今アップロードできる最大の大きさ（容量の残りと1本の上限の小さい方）
      availableBytes: Math.max(0, Math.min(cfg.maxUploadBytes, cfg.kvStorageLimitBytes - usedBytes)),
    },
  });
}

/** POST /api/admin/cleanup 自動削除を手動で実行する（動作確認用） */
export async function manualCleanup(ctx: Ctx): Promise<Response> {
  await admin(ctx);
  return json({ summary: await runCleanup(ctx.env, ctx.now) });
}
