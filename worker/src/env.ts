// Workerにバインドされる環境（wrangler.jsonc と Secrets で設定）
export interface Env {
  DB: D1Database;
  /** 動画（塊に分割）とサムネイルの保存先。Workers KV（無料プラン：合計1GB） */
  MEDIA: KVNamespace;

  // ---- Secrets（wrangler secret put で設定。ソースコードには書かない） ----
  VIEWER_PASSPHRASE?: string;
  ADMIN_PASSPHRASE?: string;
  SESSION_SECRET?: string;

  // ---- 通常の設定値（wrangler.jsonc の vars） ----
  /** CORSで許可するオリジン（カンマ区切り）。例: https://example.github.io */
  ALLOWED_ORIGINS?: string;
  /** アップロードできる動画の最大バイト数 */
  MAX_UPLOAD_BYTES?: string;
  /** 分割アップロード1回（＝KVに保存する塊1つ）のバイト数。1MiB〜24MiB（KVの値の上限は25MiB） */
  UPLOAD_PART_BYTES?: string;
  /** KV に保存してよい合計バイト数（無料プランの上限1GBより少なくする） */
  KV_STORAGE_LIMIT_BYTES?: string;
  /** KV の1日あたりの書き込み・削除・一覧取得の上限（無料プランの上限1,000回より少なくする） */
  KV_DAILY_WRITE_LIMIT?: string;
  KV_DAILY_DELETE_LIMIT?: string;
  KV_DAILY_LIST_LIMIT?: string;
  VIEWER_TOKEN_TTL_SECONDS?: string;
  ADMIN_TOKEN_TTL_SECONDS?: string;
  /** 動画・サムネイル配信用の一時URLの有効期間 */
  MEDIA_TOKEN_TTL_SECONDS?: string;
}
