// 閲覧者向けの動画API（一覧・詳細・配信）
import { issueMediaToken, requireMediaToken, requireSession, type Role } from "../auth";
import { assertViewable, commentCounts, getVideo, publicVideo, UUID_RE, type VideoRow } from "../db";
import { HttpError, SECURITY_HEADERS, json } from "../http";
import { ChunkNotReadyError, chunkCount, getChunk } from "../storage";
import type { Ctx } from "../router";

function requireVideoId(ctx: Ctx): string {
  const id = ctx.params.id;
  if (!UUID_RE.test(id)) throw new HttpError(404, "NOT_FOUND", "動画が見つかりません。");
  return id;
}

async function mediaUrls(ctx: Ctx, v: VideoRow, role: Role) {
  const { token, expiresAt } = await issueMediaToken(ctx.env, role, v.id, ctx.now);
  const base = `${ctx.url.origin}/api/videos/${v.id}`;
  return {
    streamUrl: `${base}/stream?st=${token}`,
    thumbnailUrl: v.thumbnailKey ? `${base}/thumbnail?st=${token}` : null,
    mediaExpiresAt: expiresAt,
  };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** GET /api/videos 公開中の動画一覧（期限切れは含めない） */
export async function listVideos(ctx: Ctx): Promise<Response> {
  const claims = await requireSession(ctx.request, ctx.env, "viewer", ctx.now);
  const q = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const category = (ctx.url.searchParams.get("category") ?? "").trim().slice(0, 30);
  const sort = ctx.url.searchParams.get("sort") === "old" ? "ASC" : "DESC";
  const limit = Math.min(100, Math.max(1, Number(ctx.url.searchParams.get("limit")) || 60));
  const offset = Math.max(0, Number(ctx.url.searchParams.get("offset")) || 0);

  const where = ["status = 'published'", "expiresAt > ?1"];
  const binds: unknown[] = [ctx.now];
  if (q) {
    binds.push(`%${escapeLike(q)}%`);
    where.push(`title LIKE ?${binds.length} ESCAPE '\\'`);
  }
  if (category) {
    binds.push(category);
    where.push(`category = ?${binds.length}`);
  }
  binds.push(limit + 1, offset);
  const rows = await ctx.env.DB.prepare(
    `SELECT * FROM videos WHERE ${where.join(" AND ")} ORDER BY uploadedAt ${sort}, id ${sort} LIMIT ?${
      binds.length - 1
    } OFFSET ?${binds.length}`,
  )
    .bind(...binds)
    .all<VideoRow>();
  const hasMore = rows.results.length > limit;
  const videos = rows.results.slice(0, limit);
  const counts = await commentCounts(ctx.env.DB, videos.map((v) => v.id));
  const categories = await ctx.env.DB.prepare(
    "SELECT DISTINCT category FROM videos WHERE status = 'published' AND expiresAt > ?1 ORDER BY category",
  )
    .bind(ctx.now)
    .all<{ category: string }>();

  const items = await Promise.all(
    videos.map(async (v) => {
      const urls = await mediaUrls(ctx, v, claims.role);
      return { ...publicVideo(v, counts.get(v.id) ?? 0), thumbnailUrl: urls.thumbnailUrl };
    }),
  );
  return json({ videos: items, categories: categories.results.map((c) => c.category), hasMore });
}

/** GET /api/videos/:id 動画の詳細と一時的な視聴URL */
export async function videoDetail(ctx: Ctx): Promise<Response> {
  const claims = await requireSession(ctx.request, ctx.env, "viewer", ctx.now);
  const id = requireVideoId(ctx);
  const v = assertViewable(await getVideo(ctx.env.DB, id), claims.role, ctx.now);
  const counts = await commentCounts(ctx.env.DB, [v.id]);
  return json({ video: { ...publicVideo(v, counts.get(v.id) ?? 0), ...(await mediaUrls(ctx, v, claims.role)) } });
}

/** GET /api/videos/:id/playback 視聴URLの再発行（有効期限が切れたとき用） */
export async function playback(ctx: Ctx): Promise<Response> {
  const claims = await requireSession(ctx.request, ctx.env, "viewer", ctx.now);
  const id = requireVideoId(ctx);
  const v = assertViewable(await getVideo(ctx.env.DB, id), claims.role, ctx.now);
  return json(await mediaUrls(ctx, v, claims.role));
}

export type ParsedRange = { offset: number; length: number } | null | "unsatisfiable";

/** Rangeヘッダーを解析する（単一範囲のみ対応） */
export function parseRange(header: string | null, size: number): ParsedRange {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "unsatisfiable";
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { offset: start, length: end - start + 1 };
}

const MEDIA_HEADERS = {
  ...SECURITY_HEADERS,
  // 期限切れ後にキャッシュから再生されないよう、動画は保存させない
  "Cache-Control": "private, no-store",
};

/** 保存直後は KV の反映が他の地域に届くまで最大60秒ほどかかるため、その間は再試行を促す */
const PROPAGATION_GRACE_MS = 2 * 60 * 1000;

function chunkMissing(v: VideoRow, nowMs: number): HttpError {
  if (v.uploadedAt !== null && nowMs - v.uploadedAt < PROPAGATION_GRACE_MS) {
    return new HttpError(503, "NOT_READY", "動画の準備中です。少し待ってから再生してください。", undefined, { "Retry-After": "5" });
  }
  return new HttpError(404, "FILE_MISSING", "動画ファイルが見つかりません。");
}

/**
 * GET/HEAD /api/videos/:id/stream?st=... 認証・期限確認・Range対応の動画配信。
 * 動画は KV に塊で保存されているため、Range 要求には「要求された位置を含む塊1つ分まで」を 206 で返す
 * （ブラウザは足りない分を続けて要求する）。Range なしの要求には全体を順に流す。
 */
export async function streamVideo(ctx: Ctx): Promise<Response> {
  const id = requireVideoId(ctx);
  const claims = await requireMediaToken(ctx.url.searchParams.get("st"), ctx.env, id, ctx.now);
  // 期限はトークンではなく毎回D1の値で確認する（KVにファイルが残っていても期限切れなら配信しない）
  const v = assertViewable(await getVideo(ctx.env.DB, id), claims.role, ctx.now);

  const size = v.fileSize;
  const range = parseRange(ctx.request.headers.get("Range"), size);
  const base: Record<string, string> = {
    ...MEDIA_HEADERS,
    "Content-Type": v.contentType || "video/mp4",
    "Accept-Ranges": "bytes",
    ETag: `"${v.id}-${v.fileSize}"`,
  };

  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
  }
  if (ctx.request.method === "HEAD") {
    return new Response(null, { status: 200, headers: { ...base, "Content-Length": String(size) } });
  }
  if (range) {
    const idx = Math.floor(range.offset / v.partSize);
    const chunkStart = idx * v.partSize;
    let bytes: Uint8Array;
    try {
      bytes = await getChunk(ctx.env, v.storageKey, idx);
    } catch (err) {
      if (err instanceof ChunkNotReadyError) throw chunkMissing(v, ctx.now);
      throw err;
    }
    const startInChunk = range.offset - chunkStart;
    const endInChunk = Math.min(bytes.length, startInChunk + range.length); // 排他的
    if (startInChunk >= endInChunk) throw new HttpError(500, "FILE_CORRUPT", "動画ファイルが壊れています。");
    const body = bytes.subarray(startInChunk, endInChunk);
    const last = range.offset + body.length - 1;
    return new Response(body, {
      status: 206,
      headers: { ...base, "Content-Length": String(body.length), "Content-Range": `bytes ${range.offset}-${last}/${size}` },
    });
  }

  // Range なし：最初の塊を確認してから、全体を順番に流す
  let first: Uint8Array;
  try {
    first = await getChunk(ctx.env, v.storageKey, 0);
  } catch (err) {
    if (err instanceof ChunkNotReadyError) throw chunkMissing(v, ctx.now);
    throw err;
  }
  const total = chunkCount(v);
  let next = 1;
  const env = ctx.env;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
      if (total === 1) controller.close();
    },
    async pull(controller) {
      if (next >= total) return controller.close();
      try {
        controller.enqueue(await getChunk(env, v.storageKey, next++));
        if (next >= total) controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return new Response(stream, { status: 200, headers: { ...base, "Content-Length": String(size) } });
}

/** GET /api/videos/:id/thumbnail?st=... */
export async function thumbnail(ctx: Ctx): Promise<Response> {
  const id = requireVideoId(ctx);
  const claims = await requireMediaToken(ctx.url.searchParams.get("st"), ctx.env, id, ctx.now);
  const v = assertViewable(await getVideo(ctx.env.DB, id), claims.role, ctx.now);
  if (!v.thumbnailKey) throw new HttpError(404, "NOT_FOUND", "サムネイルがありません。");
  const obj = await ctx.env.MEDIA.getWithMetadata<{ ct?: string }>(v.thumbnailKey, "arrayBuffer");
  if (!obj.value) throw new HttpError(404, "NOT_FOUND", "サムネイルがありません。");
  return new Response(obj.value, {
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": obj.metadata?.ct ?? "image/jpeg",
      "Cache-Control": "private, max-age=60",
    },
  });
}
