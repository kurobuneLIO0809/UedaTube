import type { Env } from "./env";

export interface Config {
  allowedOrigins: string[];
  maxUploadBytes: number;
  uploadPartBytes: number;
  viewerTokenTtl: number;
  adminTokenTtl: number;
  mediaTokenTtl: number;
}

const MIB = 1024 * 1024;
/** R2のマルチパートでは最後以外のパートは5MiB以上が必要 */
export const MIN_PART_BYTES = 5 * MIB;
/** Workers無料プランのリクエスト本文の上限は100MB。余裕を持たせて95MiBまで */
export const MAX_PART_BYTES = 95 * MIB;

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
    maxUploadBytes: int(env.MAX_UPLOAD_BYTES, 500 * MIB, 1 * MIB, 5 * 1024 * MIB),
    uploadPartBytes: int(env.UPLOAD_PART_BYTES, 10 * MIB, MIN_PART_BYTES, MAX_PART_BYTES),
    viewerTokenTtl: int(env.VIEWER_TOKEN_TTL_SECONDS, 8 * 3600, 60, 7 * 24 * 3600),
    adminTokenTtl: int(env.ADMIN_TOKEN_TTL_SECONDS, 2 * 3600, 60, 24 * 3600),
    mediaTokenTtl: int(env.MEDIA_TOKEN_TTL_SECONDS, 15 * 60, 30, 3600),
  };
}
