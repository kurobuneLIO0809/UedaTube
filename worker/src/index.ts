// School NICO API（Cloudflare Workers）
import type { Env } from "./env";
import { getConfig } from "./config";
import { runCleanup } from "./cleanup";
import { HttpError, corsHeaders, errorResponse, json, withHeaders } from "./http";
import { Router, type Ctx } from "./router";
import { sessionInfo, verifyAdmin, verifyViewer } from "./routes/access";
import { listVideos, playback, streamVideo, thumbnail, videoDetail } from "./routes/videos";
import { listComments, postComment } from "./routes/comments";
import {
  adminGetVideo,
  adminListComments,
  adminListVideos,
  completeUpload,
  createUpload,
  dashboard,
  deleteComment,
  deleteVideo,
  inspectVideo,
  manualCleanup,
  putThumbnail,
  updateComment,
  updateVideo,
  uploadPart,
} from "./routes/admin";

const router = new Router()
  .on("GET", "/api/health", async () => json({ ok: true }))
  .on("POST", "/api/access/verify", verifyViewer)
  .on("POST", "/api/admin/verify", verifyAdmin)
  .on("GET", "/api/session", sessionInfo)
  .on("GET", "/api/videos", listVideos)
  .on("GET", "/api/videos/:id", videoDetail)
  .on("GET", "/api/videos/:id/playback", playback)
  .on("GET", "/api/videos/:id/stream", streamVideo)
  .on("GET", "/api/videos/:id/thumbnail", thumbnail)
  .on("GET", "/api/videos/:id/comments", listComments)
  .on("POST", "/api/videos/:id/comments", postComment)
  .on("GET", "/api/admin/dashboard", dashboard)
  .on("POST", "/api/admin/cleanup", manualCleanup)
  .on("GET", "/api/admin/videos", adminListVideos)
  .on("POST", "/api/admin/videos", createUpload)
  .on("GET", "/api/admin/videos/:id", adminGetVideo)
  .on("PATCH", "/api/admin/videos/:id", updateVideo)
  .on("DELETE", "/api/admin/videos/:id", deleteVideo)
  .on("PUT", "/api/admin/videos/:id/parts/:part", uploadPart)
  .on("POST", "/api/admin/videos/:id/complete", completeUpload)
  .on("PUT", "/api/admin/videos/:id/thumbnail", putThumbnail)
  .on("POST", "/api/admin/videos/:id/inspect", inspectVideo)
  .on("GET", "/api/admin/videos/:id/comments", adminListComments)
  .on("PATCH", "/api/admin/comments/:id", updateComment)
  .on("DELETE", "/api/admin/comments/:id", deleteComment);

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const cfg = getConfig(env);
  const cors = corsHeaders(request, cfg.allowedOrigins);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: Object.keys(cors).length ? 204 : 403, headers: cors });
  }

  try {
    // 許可していないサイトからのブラウザ経由の書き込み要求は拒否する（認証とは別の多層防御）
    const origin = request.headers.get("Origin");
    if (origin && !cfg.allowedOrigins.includes(origin) && request.method !== "GET" && request.method !== "HEAD") {
      throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "このサイトからの操作は許可されていません。");
    }
    const m = router.match(request.method, url.pathname);
    if (m === null) throw new HttpError(404, "NOT_FOUND", "見つかりません。");
    if (m === "method") throw new HttpError(405, "METHOD_NOT_ALLOWED", "このメソッドは使用できません。");
    const c: Ctx = { request, env, url, params: m.params, now: Date.now(), waitUntil: (p) => ctx.waitUntil(p) };
    return withHeaders(await m.handler(c), cors);
  } catch (err) {
    if (err instanceof HttpError) return withHeaders(errorResponse(err), cors);
    console.error(JSON.stringify({ event: "unhandled_error", path: url.pathname, error: String(err).slice(0, 300) }));
    return withHeaders(errorResponse(new HttpError(500, "INTERNAL", "サーバーでエラーが発生しました。")), cors);
  }
}

export default {
  fetch: handleRequest,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    void controller;
    ctx.waitUntil(runCleanup(env, Date.now()));
  },
} satisfies ExportedHandler<Env>;
