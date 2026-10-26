-- 720p 自動変換に対応するための列を追加する。
-- 保存されるのは常に変換後（または変換不要と判定された）の動画だけで、元動画は保存しない。
-- 以下の source* は「元動画がどうだったか」を管理者に表示するための参考情報（ブラウザが報告した値）。
-- 実際に保存されている動画の解像度・コーデックは width / height / videoCodec（サーバーが検査した値）を使う。
ALTER TABLE videos ADD COLUMN sourceWidth INTEGER CHECK (sourceWidth IS NULL OR sourceWidth BETWEEN 1 AND 16384);
ALTER TABLE videos ADD COLUMN sourceHeight INTEGER CHECK (sourceHeight IS NULL OR sourceHeight BETWEEN 1 AND 16384);
ALTER TABLE videos ADD COLUMN sourceCodec TEXT CHECK (sourceCodec IS NULL OR length(sourceCodec) <= 32);
-- 1 = サイトの自動変換（再エンコード）を経てアップロードされた動画
ALTER TABLE videos ADD COLUMN transcoded INTEGER NOT NULL DEFAULT 0 CHECK (transcoded IN (0, 1));
