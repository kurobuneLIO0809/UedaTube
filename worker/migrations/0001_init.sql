-- School NICO 初期スキーマ
-- 時刻はすべて UTC の UNIX エポックミリ秒（INTEGER）で保存します。

CREATE TABLE videos (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  category         TEXT NOT NULL,
  r2Key            TEXT NOT NULL UNIQUE,
  thumbnailKey     TEXT,
  durationSeconds  REAL,
  width            INTEGER,
  height           INTEGER,
  videoCodec       TEXT,
  fileSize         INTEGER NOT NULL CHECK (fileSize > 0),
  contentType      TEXT NOT NULL DEFAULT 'video/mp4',
  -- R2 マルチパートアップロードのID（アップロード中のみ）
  uploadId         TEXT,
  partSize         INTEGER NOT NULL,
  createdAt        INTEGER NOT NULL,
  -- アップロード完了時刻
  uploadedAt       INTEGER,
  -- 削除予定時刻 = uploadedAt + 14日（下の CHECK 制約で保証）
  expiresAt        INTEGER,
  status           TEXT NOT NULL CHECK (status IN ('uploading', 'published', 'hidden', 'failed', 'deleting')),
  publishOnComplete INTEGER NOT NULL DEFAULT 1 CHECK (publishOnComplete IN (0, 1)),
  commentsEnabled  INTEGER NOT NULL DEFAULT 1 CHECK (commentsEnabled IN (0, 1)),
  failureReason    TEXT,
  deleteAttempts   INTEGER NOT NULL DEFAULT 0,
  lastDeleteError  TEXT,
  updatedAt        INTEGER NOT NULL,
  CHECK ((uploadedAt IS NULL AND expiresAt IS NULL) OR (expiresAt = uploadedAt + 1209600000)),
  CHECK (status NOT IN ('published', 'hidden') OR expiresAt IS NOT NULL)
);

CREATE INDEX idx_videos_status_expires ON videos (status, expiresAt);
CREATE INDEX idx_videos_expires ON videos (expiresAt);
CREATE INDEX idx_videos_created ON videos (createdAt);

CREATE TABLE comments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 動画を削除するとコメントも自動で削除される
  videoId             TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  nickname            TEXT,
  text                TEXT NOT NULL,
  playbackTimeSeconds REAL NOT NULL CHECK (playbackTimeSeconds >= 0),
  mode                TEXT NOT NULL CHECK (mode IN ('scroll', 'top', 'bottom', 'center', 'free')),
  color               TEXT NOT NULL CHECK (length(color) = 7 AND color GLOB '#[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'),
  fontSize            INTEGER NOT NULL CHECK (fontSize BETWEEN 12 AND 96),
  fontFamily          TEXT NOT NULL CHECK (fontFamily IN ('gothic', 'mincho', 'mono')),
  xPercent            REAL NOT NULL CHECK (xPercent BETWEEN 0 AND 100),
  yPercent            REAL NOT NULL CHECK (yPercent BETWEEN 0 AND 100),
  durationSeconds     REAL NOT NULL CHECK (durationSeconds BETWEEN 1 AND 10),
  opacity             REAL NOT NULL CHECK (opacity BETWEEN 0.1 AND 1),
  isCommentArt        INTEGER NOT NULL DEFAULT 0 CHECK (isCommentArt IN (0, 1)),
  -- コメントアートの行ごとの文字列・色・サイズ（JSON配列 [{text,color?,fontSize?}]）
  artLines            TEXT CHECK (artLines IS NULL OR json_valid(artLines)),
  textAlign           TEXT NOT NULL DEFAULT 'left' CHECK (textAlign IN ('left', 'center', 'right')),
  lineHeight          REAL NOT NULL DEFAULT 1.2 CHECK (lineHeight BETWEEN 0.8 AND 2.5),
  -- 管理者による非表示
  hidden              INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  -- 連投・重複投稿の判定用。ブラウザのセッション（トークンID）を秘密鍵付きでハッシュ化した値。
  -- 生のIPアドレスやトークンそのものは保存しない
  clientHash          TEXT NOT NULL,
  contentHash         TEXT NOT NULL,
  createdAt           INTEGER NOT NULL
);

CREATE INDEX idx_comments_video ON comments (videoId, id);
CREATE INDEX idx_comments_dup ON comments (videoId, contentHash, createdAt);
CREATE INDEX idx_comments_client ON comments (clientHash, createdAt);

-- 合言葉の連続試行・連続投稿の制限
CREATE TABLE rate_limits (
  key         TEXT PRIMARY KEY,
  count       INTEGER NOT NULL,
  windowStart INTEGER NOT NULL
);

-- 定期処理の状態（R2の孤立ファイル検査のカーソルなど）
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 自動削除の実行記録（秘密情報は記録しない）
CREATE TABLE cleanup_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ranAt          INTEGER NOT NULL,
  deletedVideos  INTEGER NOT NULL,
  failedVideos   INTEGER NOT NULL,
  orphanObjects  INTEGER NOT NULL,
  errors         TEXT
);
