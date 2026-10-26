// Workerにバインドされる環境（wrangler.jsonc と Secrets で設定）
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;

  // ---- Secrets（wrangler secret put で設定。ソースコードには書かない） ----
  VIEWER_PASSPHRASE?: string;
  ADMIN_PASSPHRASE?: string;
  SESSION_SECRET?: string;

  // ---- 通常の設定値（wrangler.jsonc の vars） ----
  /** CORSで許可するオリジン（カンマ区切り）。例: https://example.github.io */
  ALLOWED_ORIGINS?: string;
  /** アップロードできる動画の最大バイト数 */
  MAX_UPLOAD_BYTES?: string;
  /** 分割アップロード1回あたりのバイト数（5MiB以上、Workersのリクエスト上限未満） */
  UPLOAD_PART_BYTES?: string;
  VIEWER_TOKEN_TTL_SECONDS?: string;
  ADMIN_TOKEN_TTL_SECONDS?: string;
  /** 動画・サムネイル配信用の一時URLの有効期間 */
  MEDIA_TOKEN_TTL_SECONDS?: string;
}
