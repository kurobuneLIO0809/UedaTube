import { env, exports } from "cloudflare:workers";
import { RETENTION_MS } from "../../shared/constants";
import { buildMp4, type FixtureOptions } from "../../shared/testing/mp4fixture";

export const BASE = "https://api.example.test";
export const ORIGIN = "https://example.github.io";
let ipCounter = 0;

/** テストごとに別のIPアドレスを使い、レート制限が他のテストに影響しないようにする */
export function freshIp(): string {
  ipCounter++;
  return `203.0.113.${ipCounter % 250}:${ipCounter}`;
}

export async function call(
  path: string,
  init: RequestInit & { token?: string; ip?: string; json?: unknown } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  headers.set("CF-Connecting-IP", init.ip ?? "198.51.100.1");
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  return (exports as unknown as { default: Fetcher }).default.fetch(`${BASE}${path}`, { ...init, headers, body });
}

export async function login(role: "viewer" | "admin"): Promise<string> {
  const res = await call(role === "admin" ? "/api/admin/verify" : "/api/access/verify", {
    method: "POST",
    json: { passphrase: role === "admin" ? env.ADMIN_PASSPHRASE : env.VIEWER_PASSPHRASE },
    ip: freshIp(),
  });
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

export interface SeedOptions {
  uploadedAt?: number;
  status?: "published" | "hidden";
  commentsEnabled?: boolean;
  bytes?: Uint8Array;
  title?: string;
  category?: string;
  thumbnail?: boolean;
  mp4?: FixtureOptions;
}

/** D1とR2に公開済みの動画を直接作成する */
export async function seedVideo(opts: SeedOptions = {}): Promise<{ id: string; bytes: Uint8Array }> {
  const id = crypto.randomUUID();
  const bytes = opts.bytes ?? buildMp4({ mdatBytes: 50_000, ...opts.mp4 });
  const key = `videos/${id}/video.mp4`;
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "video/mp4" } });
  let thumbKey: string | null = null;
  if (opts.thumbnail) {
    thumbKey = `videos/${id}/thumbnail`;
    await env.BUCKET.put(thumbKey, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { httpMetadata: { contentType: "image/jpeg" } });
  }
  const uploadedAt = opts.uploadedAt ?? Date.now();
  await env.DB.prepare(
    `INSERT INTO videos (id, title, description, category, r2Key, thumbnailKey, durationSeconds, width, height, videoCodec,
      fileSize, contentType, partSize, createdAt, uploadedAt, expiresAt, status, commentsEnabled, updatedAt)
     VALUES (?1, ?2, '', ?3, ?4, ?5, 60, 1280, 720, 'avc1', ?6, 'video/mp4', 5242880, ?7, ?7, ?8, ?9, ?10, ?7)`,
  )
    .bind(
      id,
      opts.title ?? "テスト動画",
      opts.category ?? "授業",
      key,
      thumbKey,
      bytes.length,
      uploadedAt,
      uploadedAt + RETENTION_MS,
      opts.status ?? "published",
      opts.commentsEnabled === false ? 0 : 1,
    )
    .run();
  return { id, bytes };
}

export function baseComment(extra: Record<string, unknown> = {}) {
  return {
    text: "こんにちは",
    playbackTimeSeconds: 42.5,
    mode: "scroll",
    color: "#FFFFFF",
    fontSize: 24,
    fontFamily: "gothic",
    ...extra,
  };
}
