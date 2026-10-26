// 720p への自動変換（再エンコード）に関する共通処理。
//
// 変換は管理者のブラウザ内で FFmpeg（WebAssembly 版）を使って実行し、変換後のファイルだけをアップロードする。
// サーバー（Worker）はアップロードされたファイルを必ず再検査し、720p を超える・H.264/AAC でないファイルは保存しない。
// そのため「ブラウザで720pに見せかける」ことはできず、保存されるファイルは実際に720p以下になる。
import {
  ALLOWED_AUDIO_CODECS,
  ALLOWED_VIDEO_CODECS,
  MAX_VIDEO_LONG_SIDE,
  MAX_VIDEO_SHORT_SIDE,
} from "./constants";
import { isResolutionAllowed, type Mp4Info } from "./mp4";

/** ブラウザ内変換の上限（端末のメモリと処理時間を守るため） */
export const TRANSCODE_LIMITS = {
  /** 変換元ファイルの最大サイズ（ブラウザのメモリ上に読み込むため） */
  maxInputBytes: 1024 * 1024 * 1024,
  /** 変換元動画の最大の長さ（秒） */
  maxDurationSeconds: 30 * 60,
  /** 変換処理の最大時間（これを超えたら中止する） */
  timeoutMs: 2 * 60 * 60 * 1000,
} as const;

/** 変換後の映像・音声の設定 */
export const TRANSCODE_OUTPUT = {
  /** 画質（小さいほど高画質・大きいファイル）。23 は H.264 の標準的な値 */
  crf: 23,
  /** 変換速度と圧縮率のバランス。ブラウザ内処理のため速めの設定 */
  preset: "veryfast",
  maxVideoBitrate: "3M",
  bufferSize: "6M",
  audioBitrate: "128k",
} as const;

/**
 * 変換後の解像度を求める（FFmpeg の scale フィルターと同じ規則）。
 * ・横長（幅 ≥ 高さ）は 1280×720、縦長は 720×1280 の枠に収める
 * ・元のアスペクト比を保つ
 * ・拡大はしない（元が小さければそのまま）
 * ・幅・高さは偶数（H.264 の要件）
 */
export function computeTargetSize(width: number, height: number): { width: number; height: number; scaled: boolean } {
  if (!(width > 0 && height > 0)) throw new Error("invalid size");
  const landscape = width >= height;
  const boxW = Math.min(width, landscape ? MAX_VIDEO_LONG_SIDE : MAX_VIDEO_SHORT_SIDE);
  const boxH = Math.min(height, landscape ? MAX_VIDEO_SHORT_SIDE : MAX_VIDEO_LONG_SIDE);
  const ratio = Math.min(boxW / width, boxH / height);
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const w = even(width * ratio);
  const h = even(height * ratio);
  return { width: w, height: h, scaled: w !== width || h !== height };
}

/** FFmpeg の scale フィルター（computeTargetSize と同じ規則。回転情報を適用した後の向きで判定する） */
export const SCALE_FILTER =
  "scale=w='min(iw,if(gte(iw,ih),1280,720))':h='min(ih,if(gte(iw,ih),720,1280))'" +
  ":force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,format=yuv420p";

/** H.264 + AAC の MP4 に変換する FFmpeg の引数 */
export function buildTranscodeArgs(input: string, output: string): string[] {
  return [
    "-hide_banner",
    "-y",
    "-i",
    input,
    // 最初の映像と（あれば）最初の音声だけを使う。字幕・データ・メタデータは捨てる
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-vf",
    SCALE_FILTER,
    "-c:v",
    "libx264",
    "-preset",
    TRANSCODE_OUTPUT.preset,
    "-crf",
    String(TRANSCODE_OUTPUT.crf),
    "-maxrate",
    TRANSCODE_OUTPUT.maxVideoBitrate,
    "-bufsize",
    TRANSCODE_OUTPUT.bufferSize,
    "-profile:v",
    "high",
    "-level:v",
    "4.0",
    "-c:a",
    "aac",
    "-b:a",
    TRANSCODE_OUTPUT.audioBitrate,
    "-ac",
    "2",
    // 先頭に再生用の情報を置き、読み込みながら再生できるようにする
    "-movflags",
    "+faststart",
    output,
  ];
}

/**
 * 変換（再エンコード）が必要な理由を返す。空配列なら変換不要（そのままアップロードできる）。
 * info が null の場合は MP4 として解析できなかった（MOV・WebM などの別形式、または壊れたファイル）。
 */
export function transcodeReasons(info: Mp4Info | null, parseError?: string): string[] {
  if (!info) return [parseError ? `MP4 として読み込めないため変換します（${parseError}）` : "MP4 以外の形式のため変換します。"];
  const reasons: string[] = [];
  if (!isResolutionAllowed(info.width, info.height)) {
    const t = computeTargetSize(info.width, info.height);
    reasons.push(`解像度 ${info.width}×${info.height} を ${t.width}×${t.height} に縮小します。`);
  }
  if (!(ALLOWED_VIDEO_CODECS as readonly string[]).includes(info.videoCodec)) {
    reasons.push(`映像コーデック「${info.videoCodec || "不明"}」を H.264 に変換します。`);
  }
  const badAudio = info.audioCodecs.filter((c) => !(ALLOWED_AUDIO_CODECS as readonly string[]).includes(c));
  if (badAudio.length) reasons.push(`音声コーデック「${badAudio.join(", ")}」を AAC に変換します。`);
  if (info.majorBrand === "qt  ") reasons.push("QuickTime（MOV）形式を MP4 に変換します。");
  return reasons;
}

/** FFmpeg のログから元動画の情報（長さ・解像度）を読み取る */
export function parseFfmpegProbeLog(lines: string[]): { durationSeconds: number | null; width: number | null; height: number | null } {
  let durationSeconds: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  for (const line of lines) {
    const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (d && durationSeconds === null) durationSeconds = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
    if (width === null && /Stream #\d+:\d+.*Video:/.test(line)) {
      const s = /,\s*(\d{2,5})x(\d{2,5})[\s,[]/.exec(line);
      if (s) {
        width = Number(s[1]);
        height = Number(s[2]);
      }
    }
  }
  return { durationSeconds, width, height };
}
