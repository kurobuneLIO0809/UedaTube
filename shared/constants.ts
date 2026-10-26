// フロントエンドとWorkerで共有する定数。
// ここを変更すると両方の検証ロジックに反映されます。

/** 動画の保存期間（日）。仕様により14日間で固定。 */
export const RETENTION_DAYS = 14;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** 受け付ける最大解像度（長辺×短辺）。縦長動画は720×1280まで許可。 */
export const MAX_VIDEO_LONG_SIDE = 1280;
export const MAX_VIDEO_SHORT_SIDE = 720;

/** 受け付ける動画コーデック（互換性優先のため H.264 のみ）。 */
export const ALLOWED_VIDEO_CODECS = ["avc1", "avc3"] as const;
/** 受け付ける音声コーデック（音声なしも可）。 */
export const ALLOWED_AUDIO_CODECS = ["mp4a"] as const;

export const ALLOWED_VIDEO_MIME = "video/mp4";
export const ALLOWED_THUMBNAIL_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

export const COMMENT_MODES = ["scroll", "top", "bottom", "center", "free"] as const;
export type CommentMode = (typeof COMMENT_MODES)[number];

export const FONT_FAMILIES = ["gothic", "mincho", "mono"] as const;
export type FontFamilyKey = (typeof FONT_FAMILIES)[number];

export const TEXT_ALIGNS = ["left", "center", "right"] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

export const COLOR_PRESETS: ReadonlyArray<{ name: string; value: string }> = [
  { name: "白", value: "#FFFFFF" },
  { name: "赤", value: "#FF3B3B" },
  { name: "ピンク", value: "#FF8FCB" },
  { name: "オレンジ", value: "#FF9F1C" },
  { name: "黄色", value: "#FFE53B" },
  { name: "緑", value: "#3BD16F" },
  { name: "シアン", value: "#22D3EE" },
  { name: "青", value: "#3B82F6" },
  { name: "紫", value: "#A855F7" },
  { name: "黒", value: "#000000" },
];

export const FONT_SIZE_PRESETS = { small: 16, medium: 24, large: 36 } as const;

export const LIMITS = {
  /** 通常コメントの最大文字数 */
  commentMaxChars: 75,
  /** ニックネームの最大文字数 */
  nicknameMaxChars: 20,
  /** 文字職人モードの最大行数 */
  artMaxLines: 40,
  /** 文字職人モードの1行あたり最大文字数 */
  artMaxLineChars: 100,
  /** 文字職人モードの合計最大文字数 */
  artMaxTotalChars: 2000,
  fontSizeMin: 12,
  fontSizeMax: 96,
  durationMin: 1,
  durationMax: 10,
  opacityMin: 0.1,
  opacityMax: 1,
  lineHeightMin: 0.8,
  lineHeightMax: 2.5,
  /** 動画の最大長さ（秒）。再生位置の上限検証に使用 */
  playbackTimeMax: 6 * 60 * 60,
  titleMaxChars: 100,
  descriptionMaxChars: 2000,
  categoryMaxChars: 30,
  /** コメント投稿APIのリクエスト本文の上限（バイト） */
  commentBodyMaxBytes: 16 * 1024,
} as const;

export const DEFAULT_DURATION = { scroll: 4, fixed: 3 } as const;

/** 文字職人モードでタブを何文字分の空白に展開するか */
export const TAB_WIDTH = 4;

export const DEFAULT_NICKNAME = "名無し";
