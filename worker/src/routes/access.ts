// 合言葉の検証（閲覧用・管理者用）
import { issueSessionToken, passphraseMatches, requirePassphrase, requireSession, hashIdentifier, type Role } from "../auth";
import { HttpError, clientIp, json, readJson } from "../http";
import { clear, hit, peek } from "../ratelimit";
import type { Ctx } from "../router";

/** 連続失敗の上限（ウィンドウ内の失敗回数） */
export const LOGIN_LIMITS: Record<Role, { maxFailures: number; windowMs: number }> = {
  viewer: { maxFailures: 10, windowMs: 10 * 60 * 1000 },
  admin: { maxFailures: 5, windowMs: 15 * 60 * 1000 },
};

async function verifyPassphrase(ctx: Ctx, role: Role): Promise<Response> {
  const { env, request, now } = ctx;
  const expected = requirePassphrase(env, role);
  const body = (await readJson(request, 2048)) as { passphrase?: unknown };
  const input = typeof body?.passphrase === "string" ? body.passphrase : "";
  if (input.length === 0 || input.length > 256) {
    throw new HttpError(400, "INVALID_INPUT", "合言葉を入力してください。");
  }

  const ipKey = await hashIdentifier(env, clientIp(request));
  const key = `login:${role}:${ipKey}`;
  const limit = LOGIN_LIMITS[role];
  const state = await peek(env.DB, key, limit.windowMs, now);
  if (state.count >= limit.maxFailures) {
    throw new HttpError(
      429,
      "TOO_MANY_ATTEMPTS",
      `合言葉の入力に続けて失敗したため、一時的に制限しています。約${Math.ceil(state.retryAfterSeconds / 60)}分後に再度お試しください。`,
      undefined,
      { "Retry-After": String(state.retryAfterSeconds) },
    );
  }

  if (!(await passphraseMatches(input, expected))) {
    const r = await hit(env.DB, key, limit.windowMs, now);
    console.warn(JSON.stringify({ event: "login_failed", role, failures: r.count }));
    const remaining = Math.max(0, limit.maxFailures - r.count);
    throw new HttpError(
      401,
      "WRONG_PASSPHRASE",
      remaining > 0
        ? `合言葉が違います。（あと${remaining}回失敗すると一時的に入力できなくなります）`
        : "合言葉が違います。一時的に入力を制限しました。しばらくしてから再度お試しください。",
    );
  }

  await clear(env.DB, key);
  return json(await issueSessionToken(env, role, now));
}

export const verifyViewer = (ctx: Ctx) => verifyPassphrase(ctx, "viewer");
export const verifyAdmin = (ctx: Ctx) => verifyPassphrase(ctx, "admin");

/** 現在のトークンが有効かどうかを確認する */
export async function sessionInfo(ctx: Ctx): Promise<Response> {
  const claims = await requireSession(ctx.request, ctx.env, "viewer", ctx.now);
  return json({ role: claims.role, expiresAt: new Date(claims.exp * 1000).toISOString() });
}
