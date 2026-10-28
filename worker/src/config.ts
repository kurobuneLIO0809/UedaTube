import type { Env } from "./env";

export interface Config {
  allowedOrigins: string[];
  maxUploadBytes: number;
  uploadPartBytes: number;
  viewerTokenTtl: number;
  adminTokenTtl: number;
  mediaTokenTtl: number;
  kvStorageLimitBytes: number;
  kvDailyLimits: { write: number; delete: number; list: number };
}

const MIB = 1024 * 1024;
export const MIN_PART_BYTES = 1 * MIB;
/** Workers KV の値の上限（25MiB）より小さくする */
export const MAX_PART_BYTES = 24 * MIB;
/** Workers KV 無料プランの上限（合計1GB・1日1,000回） */
export const KV_FREE_STORAGE_BYTES = 1000 * 1000 * 1000;
export const KV_FREE_DAILY_OPS = 1000;

function int(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = v === undefined || v === "" ? fallback : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function getConfig(env: Env): Config {
  return {
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean),
    maxUploadBytes: int(env.MAX_UPLOAD_BYTES, 200 * MIB, 1 * MIB, KV_FREE_STORAGE_BYTES),
    uploadPartBytes: int(env.UPLOAD_PART_BYTES, 8 * MIB, MIN_PART_BYTES, MAX_PART_BYTES),
    viewerTokenTtl: int(env.VIEWER_TOKEN_TTL_SECONDS, 8 * 3600, 60, 7 * 24 * 3600),
    adminTokenTtl: int(env.ADMIN_TOKEN_TTL_SECONDS, 2 * 3600, 60, 24 * 3600),
    mediaTokenTtl: int(env.MEDIA_TOKEN_TTL_SECONDS, 15 * 60, 30, 3600),
    kvStorageLimitBytes: int(env.KV_STORAGE_LIMIT_BYTES, 900 * MIB, 1 * MIB, KV_FREE_STORAGE_BYTES),
    kvDailyLimits: {
      write: int(env.KV_DAILY_WRITE_LIMIT, 900, 1, KV_FREE_DAILY_OPS),
      delete: int(env.KV_DAILY_DELETE_LIMIT, 900, 1, KV_FREE_DAILY_OPS),
      list: int(env.KV_DAILY_LIST_LIMIT, 900, 1, KV_FREE_DAILY_OPS),
    },
  };
}
