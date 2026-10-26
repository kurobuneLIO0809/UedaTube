// 合言葉の検証と署名付きトークン（HMAC-SHA256）
//
// 注意：これは「共有合言葉による簡易アクセス制御」であり、利用者個人の本人確認ではありません。
import type { Env } from "./env";
import { getConfig } from "./config";
import { HttpError } from "./http";

export type Role = "viewer" | "admin";

export interface SessionClaims {
  typ: "session";
  role: Role;
  iat: number;
  exp: number;
  jti: string;
}

/** 動画・サムネイル配信用の短期トークン。特定の動画にだけ使える。 */
export interface MediaClaims {
  typ: "media";
  role: Role;
  vid: string;
  exp: number;
}

type Claims = SessionClaims | MediaClaims;

const encoder = new TextEncoder();
const MIN_SECRET_LENGTH = 32;
const MIN_PASSPHRASE_LENGTH = 8;

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    keyCache.clear(); // 秘密鍵を変更した場合に古いキーを保持しない
    keyCache.set(secret, k);
  }
  return k;
}

export function requireSessionSecret(env: Env): string {
  const s = env.SESSION_SECRET;
  if (!s || s.length < MIN_SECRET_LENGTH) {
    console.error(JSON.stringify({ event: "config_error", reason: "SESSION_SECRET is missing or too short" }));
    throw new HttpError(503, "SERVER_NOT_CONFIGURED", "サーバーの設定が完了していません（管理者に連絡してください）。");
  }
  return s;
}

async function sign(env: Env, claims: Claims): Promise<string> {
  const key = await hmacKey(requireSessionSecret(env));
  const payload = b64urlEncode(encoder.encode(JSON.stringify(claims)));
  const data = `v1.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
  return `${data}.${b64urlEncode(sig)}`;
}

async function verify(env: Env, token: string, nowMs: number): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || token.length > 2048) return null;
  const key = await hmacKey(requireSessionSecret(env));
  let sig: Uint8Array;
  try {
    sig = b64urlDecode(parts[2]);
  } catch {
    return null;
  }
  // crypto.subtle.verify は定数時間で比較する
  const ok = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  let claims: Claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) return null;
  if (claims.role !== "viewer" && claims.role !== "admin") return null;
  return claims;
}

export async function issueSessionToken(env: Env, role: Role, nowMs: number) {
  const cfg = getConfig(env);
  const ttl = role === "admin" ? cfg.adminTokenTtl : cfg.viewerTokenTtl;
  const iat = Math.floor(nowMs / 1000);
  const claims: SessionClaims = { typ: "session", role, iat, exp: iat + ttl, jti: crypto.randomUUID() };
  return { token: await sign(env, claims), role, expiresAt: new Date(claims.exp * 1000).toISOString() };
}

export async function issueMediaToken(env: Env, role: Role, videoId: string, nowMs: number) {
  const ttl = getConfig(env).mediaTokenTtl;
  const exp = Math.floor(nowMs / 1000) + ttl;
  const claims: MediaClaims = { typ: "media", role, vid: videoId, exp };
  return { token: await sign(env, claims), expiresAt: new Date(exp * 1000).toISOString() };
}

/** Authorization: Bearer ヘッダーのセッショントークンを検証し、必要な権限を確認する */
export async function requireSession(request: Request, env: Env, required: Role, nowMs: number): Promise<SessionClaims> {
  const header = request.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) throw new HttpError(401, "UNAUTHENTICATED", "合言葉を入力してください。");
  const claims = await verify(env, m[1], nowMs);
  if (!claims || claims.typ !== "session") {
    throw new HttpError(401, "INVALID_TOKEN", "セッションの有効期限が切れたか、無効です。もう一度合言葉を入力してください。");
  }
  if (required === "admin" && claims.role !== "admin") {
    throw new HttpError(403, "FORBIDDEN", "この操作には管理者の権限が必要です。");
  }
  return claims;
}

export async function requireMediaToken(token: string | null, env: Env, videoId: string, nowMs: number): Promise<MediaClaims> {
  if (!token) throw new HttpError(401, "UNAUTHENTICATED", "視聴用のURLが無効です。");
  const claims = await verify(env, token, nowMs);
  if (!claims || claims.typ !== "media" || claims.vid !== videoId) {
    throw new HttpError(401, "INVALID_TOKEN", "視聴用のURLの有効期限が切れたか、無効です。");
  }
  return claims;
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 入力された合言葉と設定値を比較する（ハッシュ化してから定数時間比較） */
export async function passphraseMatches(input: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(input), sha256(expected)]);
  return constantTimeEqual(a, b);
}

/** 合言葉の設定値を取り出す。未設定・短すぎる・閲覧用と管理者用が同じ場合はエラー */
export function requirePassphrase(env: Env, role: Role): string {
  const viewer = env.VIEWER_PASSPHRASE ?? "";
  const admin = env.ADMIN_PASSPHRASE ?? "";
  const value = role === "admin" ? admin : viewer;
  const misconfigured =
    value.length < MIN_PASSPHRASE_LENGTH || (role === "admin" && admin === viewer);
  if (misconfigured) {
    console.error(JSON.stringify({ event: "config_error", reason: `${role} passphrase is missing, too short, or not distinct` }));
    throw new HttpError(503, "SERVER_NOT_CONFIGURED", "サーバーの設定が完了していません（管理者に連絡してください）。");
  }
  return value;
}

/** IPアドレスを秘密鍵付きでハッシュ化する（生のIPは保存しない） */
export async function hashIdentifier(env: Env, value: string): Promise<string> {
  const key = await hmacKey(requireSessionSecret(env));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`id:${value}`)));
  return Array.from(sig.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await sha256(s);
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
