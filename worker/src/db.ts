// D1の行の型と、APIで返すJSONへの変換
import type { ArtLine } from "../../shared/validation";
import type { Role } from "./auth";
import { HttpError } from "./http";

export type VideoStatus = "uploading" | "published" | "hidden" | "failed" | "deleting";

export interface VideoRow {
  id: string;
  title: string;
  description: string;
  category: string;
  r2Key: string;
  thumbnailKey: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  fileSize: number;
  contentType: string;
  uploadId: string | null;
  partSize: number;
  createdAt: number;
  uploadedAt: number | null;
  expiresAt: number | null;
  status: VideoStatus;
  publishOnComplete: number;
  commentsEnabled: number;
  failureReason: string | null;
  deleteAttempts: number;
  lastDeleteError: string | null;
  updatedAt: number;
  sourceWidth: number | null;
  sourceHeight: number | null;
  sourceCodec: string | null;
  transcoded: number;
}

export interface CommentRow {
  id: number;
  videoId: string;
  nickname: string | null;
  text: string;
  playbackTimeSeconds: number;
  mode: string;
  color: string;
  fontSize: number;
  fontFamily: string;
  xPercent: number;
  yPercent: number;
  durationSeconds: number;
  opacity: number;
  isCommentArt: number;
  artLines: string | null;
  textAlign: string;
  lineHeight: number;
  hidden: number;
  clientHash: string;
  contentHash: string;
  createdAt: number;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function isExpired(v: Pick<VideoRow, "expiresAt">, nowMs: number): boolean {
  // expiresAt が無い動画（アップロード未完了）は視聴不可として扱う
  return v.expiresAt === null || nowMs >= v.expiresAt;
}

/**
 * 視聴できる動画かどうかを判定する。期限切れは管理者であっても視聴させない。
 * 閲覧者は公開中の動画のみ、管理者は非公開（確認用）の動画も視聴できる。
 */
export function assertViewable(v: VideoRow | null, role: Role, nowMs: number): VideoRow {
  if (!v || v.status === "uploading" || v.status === "failed") {
    throw new HttpError(404, "NOT_FOUND", "動画が見つかりません。");
  }
  if (v.status === "deleting" || isExpired(v, nowMs)) {
    throw new HttpError(410, "EXPIRED", "この動画は公開期限（14日間）を過ぎたため視聴できません。");
  }
  if (v.status !== "published" && role !== "admin") {
    throw new HttpError(404, "NOT_FOUND", "動画が見つかりません。");
  }
  return v;
}

export async function getVideo(db: D1Database, id: string): Promise<VideoRow | null> {
  return db.prepare("SELECT * FROM videos WHERE id = ?1").bind(id).first<VideoRow>();
}

export function publicVideo(v: VideoRow, commentCount: number) {
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    category: v.category,
    durationSeconds: v.durationSeconds,
    width: v.width,
    height: v.height,
    hasThumbnail: v.thumbnailKey !== null,
    uploadedAt: iso(v.uploadedAt),
    expiresAt: iso(v.expiresAt),
    commentsEnabled: v.commentsEnabled === 1,
    commentCount,
    status: v.status,
  };
}

export function adminVideo(v: VideoRow, commentCount: number, nowMs: number) {
  return {
    ...publicVideo(v, commentCount),
    createdAt: iso(v.createdAt),
    fileSize: v.fileSize,
    videoCodec: v.videoCodec,
    failureReason: v.failureReason,
    deleteAttempts: v.deleteAttempts,
    lastDeleteError: v.lastDeleteError,
    expired: v.expiresAt !== null && nowMs >= v.expiresAt,
    // 元動画の参考情報（自動変換した場合）
    source: { width: v.sourceWidth, height: v.sourceHeight, codec: v.sourceCodec, transcoded: v.transcoded === 1 },
  };
}

export function publicComment(c: CommentRow, includeModeration = false) {
  let artLines: ArtLine[] | null = null;
  if (c.artLines) {
    try {
      artLines = JSON.parse(c.artLines) as ArtLine[];
    } catch {
      artLines = null;
    }
  }
  return {
    id: c.id,
    videoId: c.videoId,
    nickname: c.nickname,
    text: c.text,
    playbackTimeSeconds: c.playbackTimeSeconds,
    mode: c.mode,
    color: c.color,
    fontSize: c.fontSize,
    fontFamily: c.fontFamily,
    xPercent: c.xPercent,
    yPercent: c.yPercent,
    durationSeconds: c.durationSeconds,
    opacity: c.opacity,
    isCommentArt: c.isCommentArt === 1,
    artLines,
    textAlign: c.textAlign,
    lineHeight: c.lineHeight,
    createdAt: iso(c.createdAt),
    ...(includeModeration ? { hidden: c.hidden === 1 } : {}),
  };
}

export async function commentCounts(db: D1Database, ids: string[], includeHidden = false): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (ids.length === 0) return map;
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
  const res = await db
    .prepare(
      `SELECT videoId, COUNT(*) AS n FROM comments WHERE videoId IN (${placeholders}) ${
        includeHidden ? "" : "AND hidden = 0"
      } GROUP BY videoId`,
    )
    .bind(...ids)
    .all<{ videoId: string; n: number }>();
  for (const r of res.results) map.set(r.videoId, r.n);
  return map;
}

export function videoKey(id: string): string {
  return `videos/${id}/video.mp4`;
}

export function thumbnailKey(id: string): string {
  return `videos/${id}/thumbnail`;
}

/** R2のキーから動画IDを取り出す（videos/{id}/...） */
export function videoIdFromKey(key: string): string | null {
  const m = /^videos\/([0-9a-f-]{36})\//.exec(key);
  return m ? m[1] : null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
