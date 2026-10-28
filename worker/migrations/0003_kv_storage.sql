-- 動画の保存先を R2 から Workers KV に変更する（支払い方法の登録が不要な無料プランで運用するため）。
-- 動画は一定サイズの「塊（チャンク）」に分けて KV に保存し、どの塊を受け取ったかを D1 で管理する。

-- 保存先のキーの接頭辞（例: v/<動画ID>）。塊は <接頭辞>/c/<番号>、サムネイルは <接頭辞>/t
ALTER TABLE videos RENAME COLUMN r2Key TO storageKey;

-- サムネイルの大きさ（容量の集計用）
ALTER TABLE videos ADD COLUMN thumbnailBytes INTEGER NOT NULL DEFAULT 0 CHECK (thumbnailBytes >= 0);

-- 受け取った塊。動画の行を削除すると自動で消える
CREATE TABLE video_chunks (
  videoId TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  idx     INTEGER NOT NULL CHECK (idx >= 0),
  size    INTEGER NOT NULL CHECK (size > 0),
  PRIMARY KEY (videoId, idx)
);

-- KV の1日あたりの操作回数（無料プランの上限を超える前に止めるため。日付は UTC）
CREATE TABLE kv_daily_ops (
  day   TEXT NOT NULL,
  op    TEXT NOT NULL CHECK (op IN ('write', 'delete', 'list')),
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (day, op)
);
