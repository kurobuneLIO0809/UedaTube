// コメントAPI（取得・投稿）
import { LIMITS } from "../../../shared/constants";
import { validateCommentInput } from "../../../shared/validation";
import { hashIdentifier, requireSession, sha256Hex } from "../auth";
import { assertViewable, getVideo, publicComment, UUID_RE, type CommentRow } from "../db";
import { HttpError, clientIp, json, readJson } from "../http";
import { hit } from "../ratelimit";
import type { Ctx } from "../router";

/** 一度に返すコメントの最大数（古いものから切り捨て） */
export const MAX_COMMENTS_FETCH = 2000;
/** 1本の動画に保存できるコメントの最大数 */
export const MAX_COMMENTS_PER_VIDEO = 20000;

export const COMMENT_RATE = {
  /** 同じブラウザ（セッション）からの最短投稿間隔 */
  minIntervalMs: 2000,
  /** 同じブラウザからの一定時間あたりの最大投稿数 */
  burstWindowMs: 30_000,
  burstMax: 6,
  /**
   * 同じIPアドレス全体での一定時間あたりの最大投稿数。
   * 学校では多くの人が1つのIPを共有するため、ブラウザ単位より大きな値にしている
   */
  ipBurstMax: 120,
  /** 同じブラウザから同じ内容を投稿できない時間 */
  sameUserDuplicateMs: 60_000,
  /** 動画全体で同じ内容を投稿できる回数（この時間内） */
  globalDuplicateWindowMs: 5 * 60_000,
  globalDuplicateMax: 5,
};

function requireVideoId(ctx: Ctx): string {
  if (!UUID_RE.test(ctx.params.id)) throw new HttpError(404, "NOT_FOUND", "動画が見つかりません。");
  return ctx.params.id;
}

/** GET /api/videos/:id/comments?after=<id> */
export async function listComments(ctx: Ctx): Promise<Response> {
  const claims = await requireSession(ctx.request, ctx.env, "viewer", ctx.now);
  const id = requireVideoId(ctx);
  assertViewable(await getVideo(ctx.env.DB, id), claims.role, ctx.now);

  const afterRaw = ctx.url.searchParams.get("after");
  const after = afterRaw !== null && /^\d+$/.test(afterRaw) ? Number(afterRaw) : null;

  let rows: CommentRow[];
  if (after !== null) {
    // 差分取得（ポーリング用）
    rows = (
      await ctx.env.DB.prepare(
        "SELECT * FROM comments WHERE videoId = ?1 AND hidden = 0 AND id > ?2 ORDER BY id ASC LIMIT ?3",
      )
        .bind(id, after, MAX_COMMENTS_FETCH)
        .all<CommentRow>()
    ).results;
  } else {
    // 最新の MAX_COMMENTS_FETCH 件を時系列順で返す
    rows = (
      await ctx.env.DB.prepare(
        "SELECT * FROM (SELECT * FROM comments WHERE videoId = ?1 AND hidden = 0 ORDER BY id DESC LIMIT ?2) ORDER BY id ASC",
      )
        .bind(id, MAX_COMMENTS_FETCH)
        .all<CommentRow>()
    ).results;
  }
  const total = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE videoId = ?1 AND hidden = 0")
    .bind(id)
    .first<{ n: number }>();
  const latestId = rows.length > 0 ? rows[rows.length - 1].id : (after ?? 0);
  return json({
    comments: rows.map((c) => publicComment(c)),
    latestId,
    total: total?.n ?? 0,
    truncated: after === null && (total?.n ?? 0) > rows.length,
  });
}

/** POST /api/videos/:id/comments */
export async function postComment(ctx: Ctx): Promise<Response> {
  const { env, request, now } = ctx;
  const claims = await requireSession(request, env, "viewer", now);
  const id = requireVideoId(ctx);

  const body = await readJson(request, LIMITS.commentBodyMaxBytes);
  const result = validateCommentInput(body);
  if (!result.ok) throw new HttpError(400, "INVALID_COMMENT", result.errors[0], result.errors);
  const c = result.value;

  const video = assertViewable(await getVideo(env.DB, id), claims.role, now);
  if (video.commentsEnabled !== 1) {
    throw new HttpError(403, "COMMENTS_DISABLED", "この動画は現在コメントの受付を停止しています。");
  }
  if (video.durationSeconds !== null && c.playbackTimeSeconds > video.durationSeconds + 1) {
    throw new HttpError(400, "INVALID_COMMENT", "再生位置が動画の長さを超えています。");
  }

  // 連続投稿の制限（ブラウザのセッション単位 + IPアドレス全体の上限）
  const clientHash = await hashIdentifier(env, `session:${claims.jti}`);
  const ipHash = await hashIdentifier(env, `ip:${clientIp(request)}`);
  const interval = await hit(env.DB, `cmt-int:${clientHash}`, COMMENT_RATE.minIntervalMs, now);
  if (interval.count > 1) {
    throw new HttpError(429, "TOO_FAST", "連続して投稿できません。少し待ってから投稿してください。", undefined, {
      "Retry-After": String(interval.retryAfterSeconds),
    });
  }
  const burst = await hit(env.DB, `cmt-burst:${clientHash}`, COMMENT_RATE.burstWindowMs, now);
  const ipBurst = await hit(env.DB, `cmt-ip:${ipHash}`, COMMENT_RATE.burstWindowMs, now);
  if (burst.count > COMMENT_RATE.burstMax || ipBurst.count > COMMENT_RATE.ipBurstMax) {
    throw new HttpError(429, "TOO_MANY_COMMENTS", "短時間に投稿しすぎています。しばらく待ってから投稿してください。", undefined, {
      "Retry-After": String(burst.retryAfterSeconds),
    });
  }

  // 同一内容の大量投稿の抑制（空白の違いは同じ内容とみなす）
  const contentHash = await sha256Hex(c.text.replace(/\s+/g, " ").trim().toLowerCase());
  const dup = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN clientHash = ?3 AND createdAt > ?4 THEN 1 ELSE 0 END) AS mine,
       COUNT(*) AS total
     FROM comments WHERE videoId = ?1 AND contentHash = ?2 AND createdAt > ?5`,
  )
    .bind(id, contentHash, clientHash, now - COMMENT_RATE.sameUserDuplicateMs, now - COMMENT_RATE.globalDuplicateWindowMs)
    .first<{ mine: number | null; total: number }>();
  if ((dup?.mine ?? 0) > 0) {
    throw new HttpError(429, "DUPLICATE", "同じ内容のコメントを続けて投稿することはできません。");
  }
  if ((dup?.total ?? 0) >= COMMENT_RATE.globalDuplicateMax) {
    throw new HttpError(429, "DUPLICATE", "同じ内容のコメントが短時間に多数投稿されています。時間をおいてください。");
  }

  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE videoId = ?1").bind(id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_COMMENTS_PER_VIDEO) {
    throw new HttpError(409, "COMMENT_LIMIT", "この動画のコメント数が上限に達しました。");
  }

  const row = await env.DB.prepare(
    `INSERT INTO comments (videoId, nickname, text, playbackTimeSeconds, mode, color, fontSize, fontFamily,
       xPercent, yPercent, durationSeconds, opacity, isCommentArt, artLines, textAlign, lineHeight,
       hidden, clientHash, contentHash, createdAt)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, ?17, ?18, ?19)
     RETURNING *`,
  )
    .bind(
      id,
      c.nickname,
      c.text,
      c.playbackTimeSeconds,
      c.mode,
      c.color,
      c.fontSize,
      c.fontFamily,
      c.xPercent,
      c.yPercent,
      c.durationSeconds,
      c.opacity,
      c.isCommentArt ? 1 : 0,
      c.artLines ? JSON.stringify(c.artLines) : null,
      c.textAlign,
      c.lineHeight,
      clientHash,
      contentHash,
      now,
    )
    .first<CommentRow>();
  if (!row) throw new HttpError(500, "INTERNAL", "コメントを保存できませんでした。");
  return json({ comment: publicComment(row) }, 201);
}
