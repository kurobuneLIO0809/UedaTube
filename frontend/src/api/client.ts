// Worker API の呼び出し。認証トークンの付与、タイムアウト、エラーの日本語化を行う。
import { config } from "../config";
import { clearToken, getToken, setToken, viewerCapableToken, type Role } from "./session";
import type { AdminVideo, CommentList, Comment, Dashboard, Video, VideoDetail } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: string[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Auth = "none" | "viewer" | "admin";

interface RequestOptions {
  method?: string;
  json?: unknown;
  auth?: Auth;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** 認証切れを画面に知らせるためのイベント */
export const AUTH_EXPIRED_EVENT = "snico:auth-expired";

export function apiUrl(path: string): string {
  return `${config.apiBaseUrl}${path}`;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const auth = opts.auth ?? "viewer";
  const headers: Record<string, string> = {};
  let usedRole: Role | null = null;
  if (auth !== "none") {
    const token = auth === "admin" ? getToken("admin") : viewerCapableToken();
    if (!token) {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT, { detail: auth }));
      throw new ApiError(401, "UNAUTHENTICATED", "合言葉を入力してください。");
    }
    usedRole = auth === "admin" || getToken("admin") === token ? "admin" : "viewer";
    headers.Authorization = `Bearer ${token}`;
  }
  if (opts.json !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), opts.timeoutMs ?? 20_000);
  const onAbort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onAbort);

  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: opts.method ?? "GET",
      headers,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new ApiError(0, "ABORTED", "キャンセルしました。");
    if (controller.signal.aborted) throw new ApiError(0, "TIMEOUT", "サーバーの応答がありません。時間をおいて再度お試しください。");
    void err;
    throw new ApiError(
      0,
      "NETWORK",
      typeof navigator !== "undefined" && navigator.onLine === false
        ? "インターネットに接続されていません。接続を確認してください。"
        : "サーバーに接続できませんでした。ネットワークを確認してください。",
    );
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  let body: unknown = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string; details?: string[] } } | null)?.error;
    const err = new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? `エラーが発生しました（${res.status}）。`, e?.details ?? []);
    if (res.status === 401 && usedRole) {
      clearToken(usedRole);
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT, { detail: usedRole }));
    }
    throw err;
  }
  return body as T;
}

// ---- 認証 ----
export async function verifyPassphrase(role: Role, passphrase: string): Promise<void> {
  const r = await request<{ token: string; expiresAt: string }>(role === "admin" ? "/api/admin/verify" : "/api/access/verify", {
    method: "POST",
    json: { passphrase },
    auth: "none",
  });
  setToken(role, r.token, r.expiresAt);
}

// ---- 閲覧者 ----
export interface ListParams {
  q?: string;
  category?: string;
  sort?: "new" | "old";
}

export function listVideos(p: ListParams, signal?: AbortSignal) {
  const qs = new URLSearchParams();
  if (p.q) qs.set("q", p.q);
  if (p.category) qs.set("category", p.category);
  if (p.sort) qs.set("sort", p.sort);
  return request<{ videos: Video[]; categories: string[]; hasMore: boolean }>(`/api/videos?${qs}`, { signal });
}

export const getVideo = (id: string, signal?: AbortSignal) =>
  request<{ video: VideoDetail }>(`/api/videos/${encodeURIComponent(id)}`, { signal }).then((r) => r.video);

export const refreshPlayback = (id: string) =>
  request<{ streamUrl: string; thumbnailUrl: string | null; mediaExpiresAt: string }>(`/api/videos/${encodeURIComponent(id)}/playback`);

export const listComments = (id: string, after?: number, signal?: AbortSignal) =>
  request<CommentList>(`/api/videos/${encodeURIComponent(id)}/comments${after !== undefined ? `?after=${after}` : ""}`, { signal });

export const postComment = (id: string, body: unknown) =>
  request<{ comment: Comment }>(`/api/videos/${encodeURIComponent(id)}/comments`, { method: "POST", json: body }).then((r) => r.comment);

// ---- 管理者 ----
export const getDashboard = () => request<Dashboard>("/api/admin/dashboard", { auth: "admin" });
export const adminListVideos = () => request<{ videos: AdminVideo[] }>("/api/admin/videos", { auth: "admin" }).then((r) => r.videos);
export const adminGetVideo = (id: string) =>
  request<{ video: AdminVideo }>(`/api/admin/videos/${encodeURIComponent(id)}`, { auth: "admin" }).then((r) => r.video);
export const adminUpdateVideo = (id: string, patch: Record<string, unknown>) =>
  request<{ video: AdminVideo }>(`/api/admin/videos/${encodeURIComponent(id)}`, { method: "PATCH", json: patch, auth: "admin" }).then(
    (r) => r.video,
  );
export const adminDeleteVideo = (id: string) =>
  request<{ deleted: boolean }>(`/api/admin/videos/${encodeURIComponent(id)}`, { method: "DELETE", auth: "admin" });
export const adminInspectVideo = (id: string) =>
  request<{ ok: boolean; checks: { name: string; ok: boolean; message: string }[] }>(
    `/api/admin/videos/${encodeURIComponent(id)}/inspect`,
    { method: "POST", auth: "admin", timeoutMs: 60_000 },
  );
export const adminListComments = (id: string, offset: number, limit = 50) =>
  request<{ comments: Comment[]; total: number }>(`/api/admin/videos/${encodeURIComponent(id)}/comments?offset=${offset}&limit=${limit}`, {
    auth: "admin",
  });
export const adminSetCommentHidden = (id: number, hidden: boolean) =>
  request<{ comment: Comment }>(`/api/admin/comments/${id}`, { method: "PATCH", json: { hidden }, auth: "admin" });
export const adminDeleteComment = (id: number) => request(`/api/admin/comments/${id}`, { method: "DELETE", auth: "admin" });
export const adminRunCleanup = () =>
  request<{ summary: { deletedVideos: number; failedVideos: number; orphanObjects: number; errors: string[] } }>("/api/admin/cleanup", {
    method: "POST",
    auth: "admin",
    timeoutMs: 60_000,
  });
