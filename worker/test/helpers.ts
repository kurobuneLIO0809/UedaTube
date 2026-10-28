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
  /** KV に保存する塊の大きさ（既定 5MiB） */
  partSize?: number;
}

export const THUMB_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

/** 動画の塊の KV キー（v/<id>/c/<番号>） */
export const chunkKeyOf = (id: string, idx: number) => `v/${id}/c/${idx}`;
export const thumbKeyOf = (id: string) => `v/${id}/t`;

/** KV に保存された塊をつなげて元のファイルに戻す */
export async function readStoredVideo(id: string): Promise<Uint8Array | null> {
  const row = await env.DB.prepare("SELECT fileSize, partSize FROM videos WHERE id = ?1").bind(id).first<{ fileSize: number; partSize: number }>();
  if (!row) return null;
  const out = new Uint8Array(row.fileSize);
  for (let i = 0; i * row.partSize < row.fileSize; i++) {
    const buf = await env.MEDIA.get(chunkKeyOf(id, i), "arrayBuffer");
    if (!buf) return null;
    out.set(new Uint8Array(buf), i * row.partSize);
  }
  return out;
}

/** D1 と KV に公開済みの動画を直接作成する */
export async function seedVideo(opts: SeedOptions = {}): Promise<{ id: string; bytes: Uint8Array }> {
  const id = crypto.randomUUID();
  const bytes = opts.bytes ?? buildMp4({ mdatBytes: 50_000, ...opts.mp4 });
  const partSize = opts.partSize ?? 5 * 1024 * 1024;
  const prefix = `v/${id}`;
  let thumbKey: string | null = null;
  const uploadedAt = opts.uploadedAt ?? Date.now();
  await env.DB.prepare(
    `INSERT INTO videos (id, title, description, category, storageKey, thumbnailKey, thumbnailBytes, durationSeconds, width, height, videoCodec,
      fileSize, contentType, partSize, createdAt, uploadedAt, expiresAt, status, commentsEnabled, updatedAt)
     VALUES (?1, ?2, '', ?3, ?4, ?5, ?6, 60, 1280, 720, 'avc1', ?7, 'video/mp4', ?8, ?9, ?9, ?10, ?11, ?12, ?9)`,
  )
    .bind(
      id,
      opts.title ?? "テスト動画",
      opts.category ?? "授業",
      prefix,
      opts.thumbnail ? (thumbKey = thumbKeyOf(id)) : null,
      opts.thumbnail ? THUMB_BYTES.length : 0,
      bytes.length,
      partSize,
      uploadedAt,
      uploadedAt + RETENTION_MS,
      opts.status ?? "published",
      opts.commentsEnabled === false ? 0 : 1,
    )
    .run();
  for (let i = 0; i * partSize < bytes.length; i++) {
    const chunk = bytes.slice(i * partSize, (i + 1) * partSize);
    await env.MEDIA.put(chunkKeyOf(id, i), chunk, { metadata: { t: Date.now() } });
    await env.DB.prepare("INSERT INTO video_chunks (videoId, idx, size) VALUES (?1, ?2, ?3)").bind(id, i, chunk.length).run();
  }
  if (thumbKey) await env.MEDIA.put(thumbKey, THUMB_BYTES, { metadata: { t: Date.now(), ct: "image/jpeg" } });
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
