// 最小限のMP4（ISO BMFF）解析器。
// 動画ファイル全体を読み込まず、ボックスのヘッダーと moov ボックスだけを
// 範囲読み込みして、解像度・長さ・コーデックを調べます。
// ブラウザ（File.slice）とWorker（R2の範囲取得）の両方で同じ処理を使います。
import {
  ALLOWED_AUDIO_CODECS,
  ALLOWED_VIDEO_CODECS,
  MAX_VIDEO_LONG_SIDE,
  MAX_VIDEO_SHORT_SIDE,
} from "./constants";

export interface ByteReader {
  /** ファイル全体のサイズ（バイト） */
  size: number;
  /** offset から length バイトを読み込む（ファイル末尾を越える場合は短くてよい） */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface Mp4Info {
  majorBrand: string;
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodecs: string[];
}

export type Mp4ErrorCode =
  | "NOT_MP4"
  | "QUICKTIME"
  | "MOOV_NOT_FOUND"
  | "MOOV_TOO_LARGE"
  | "FRAGMENTED_ONLY"
  | "NO_VIDEO_TRACK"
  | "ENCRYPTED"
  | "UNSUPPORTED_VIDEO_CODEC"
  | "UNSUPPORTED_AUDIO_CODEC"
  | "RESOLUTION_TOO_HIGH"
  | "INVALID_DURATION"
  | "CORRUPT";

export class Mp4Error extends Error {
  constructor(
    public code: Mp4ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "Mp4Error";
  }
}

/** moov ボックスとして読み込む最大サイズ（これより大きい動画は異常とみなす） */
export const MAX_MOOV_BYTES = 32 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 1000;

function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

function u64(b: Uint8Array, o: number): number {
  return u32(b, o) * 2 ** 32 + u32(b, o + 4);
}

function u16(b: Uint8Array, o: number): number {
  return (b[o] << 8) + b[o + 1];
}

interface Box {
  type: string;
  /** ボックス本体（ヘッダーの後）の開始位置 */
  start: number;
  /** ボックス終端（排他的） */
  end: number;
}

/** バッファ内の子ボックスを列挙する */
function childBoxes(buf: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(buf, p);
    const type = fourcc(buf, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) throw new Mp4Error("CORRUPT", "動画ファイルが壊れています（ボックスヘッダー）。");
      size = u64(buf, p + 8);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) {
      throw new Mp4Error("CORRUPT", "動画ファイルが壊れています（ボックスサイズ）。");
    }
    boxes.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return boxes;
}

function find(buf: Uint8Array, parent: Box, type: string): Box | undefined {
  return childBoxes(buf, parent.start, parent.end).find((b) => b.type === type);
}

interface TrackInfo {
  handler: string;
  width: number;
  height: number;
  codec: string;
}

function parseTrack(buf: Uint8Array, trak: Box): TrackInfo | null {
  const tkhd = find(buf, trak, "tkhd");
  const mdia = find(buf, trak, "mdia");
  if (!mdia) return null;
  const hdlr = find(buf, mdia, "hdlr");
  if (!hdlr || hdlr.start + 12 > hdlr.end) return null;
  const handler = fourcc(buf, hdlr.start + 8);

  let width = 0;
  let height = 0;
  if (tkhd) {
    const version = buf[tkhd.start];
    const wOff = tkhd.start + (version === 1 ? 88 : 76);
    if (wOff + 8 <= tkhd.end) {
      // 16.16 固定小数点
      width = Math.round(u32(buf, wOff) / 65536);
      height = Math.round(u32(buf, wOff + 4) / 65536);
    }
  }

  let codec = "";
  const minf = find(buf, mdia, "minf");
  const stbl = minf && find(buf, minf, "stbl");
  const stsd = stbl && find(buf, stbl, "stsd");
  if (stsd && stsd.start + 16 <= stsd.end) {
    const entryStart = stsd.start + 8; // version/flags + entry_count
    const entries = childBoxes(buf, entryStart, stsd.end);
    if (entries.length > 0) {
      const e = entries[0];
      codec = e.type;
      if (handler === "vide" && e.start + 28 <= e.end) {
        // VisualSampleEntry: reserved(6) data_ref(2) pre_defined(2) reserved(2) pre_defined(12) width(2) height(2)
        const cw = u16(buf, e.start + 24);
        const ch = u16(buf, e.start + 26);
        width = Math.max(width, cw);
        height = Math.max(height, ch);
      }
    }
  }
  return { handler, width, height, codec };
}

/** MP4を解析する。対応外の形式であれば Mp4Error を投げる。 */
export async function parseMp4(reader: ByteReader): Promise<Mp4Info> {
  if (reader.size < 16) throw new Mp4Error("NOT_MP4", "MP4ファイルではありません（ファイルが小さすぎます）。");

  let offset = 0;
  let majorBrand = "";
  let moov: { offset: number; size: number; header: number } | null = null;
  let sawMoof = false;
  let count = 0;

  while (offset + 8 <= reader.size) {
    if (++count > MAX_TOP_LEVEL_BOXES) throw new Mp4Error("CORRUPT", "動画ファイルの構造が不正です。");
    const head = await reader.read(offset, 16);
    if (head.length < 8) break;
    let size = u32(head, 0);
    const type = fourcc(head, 4);
    let header = 8;
    if (size === 1) {
      if (head.length < 16) throw new Mp4Error("CORRUPT", "動画ファイルが壊れています。");
      size = u64(head, 8);
      header = 16;
    } else if (size === 0) {
      size = reader.size - offset;
    }
    if (count === 1) {
      if (type !== "ftyp") {
        throw new Mp4Error("NOT_MP4", "MP4ファイルではありません。MP4（H.264）形式の動画を選択してください。");
      }
      const ftyp = await reader.read(offset + header, 4);
      majorBrand = fourcc(ftyp, 0);
      if (majorBrand === "qt  ") {
        throw new Mp4Error("QUICKTIME", "QuickTime（MOV）形式の動画には対応していません。MP4形式に書き出してください。");
      }
    }
    if (size < header || offset + size > reader.size) {
      throw new Mp4Error("CORRUPT", "動画ファイルが途中で切れているか、壊れています。");
    }
    if (type === "moov") moov = { offset, size, header };
    if (type === "moof") sawMoof = true;
    if (moov && type === "moov") break;
    offset += size;
  }

  if (!moov) {
    if (sawMoof) throw new Mp4Error("FRAGMENTED_ONLY", "断片化MP4（fMP4）には対応していません。");
    throw new Mp4Error("MOOV_NOT_FOUND", "動画の情報（moov）が見つかりません。ファイルが壊れている可能性があります。");
  }
  if (moov.size > MAX_MOOV_BYTES) {
    throw new Mp4Error("MOOV_TOO_LARGE", "動画のメタデータが大きすぎるため処理できません。");
  }

  const buf = await reader.read(moov.offset, moov.size);
  if (buf.length < moov.size) throw new Mp4Error("CORRUPT", "動画のメタデータを読み込めませんでした。");
  const root: Box = { type: "moov", start: moov.header, end: moov.size };

  // 再生時間
  const mvhd = find(buf, root, "mvhd");
  let durationSeconds = 0;
  if (mvhd) {
    const v = buf[mvhd.start];
    const timescale = v === 1 ? u32(buf, mvhd.start + 20) : u32(buf, mvhd.start + 12);
    const duration = v === 1 ? u64(buf, mvhd.start + 24) : u32(buf, mvhd.start + 16);
    if (timescale > 0) durationSeconds = duration / timescale;
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Mp4Error("INVALID_DURATION", "動画の長さを取得できませんでした。");
  }

  const tracks = childBoxes(buf, root.start, root.end)
    .filter((b) => b.type === "trak")
    .map((t) => parseTrack(buf, t))
    .filter((t): t is TrackInfo => t !== null);

  const video = tracks.find((t) => t.handler === "vide");
  if (!video) throw new Mp4Error("NO_VIDEO_TRACK", "映像トラックが見つかりません。");
  const audioCodecs = tracks.filter((t) => t.handler === "soun").map((t) => t.codec);

  return {
    majorBrand,
    durationSeconds: Math.round(durationSeconds * 1000) / 1000,
    width: video.width,
    height: video.height,
    videoCodec: video.codec,
    audioCodecs,
  };
}

/** 解像度が上限以内か（縦長動画にも対応するため長辺・短辺で判定） */
export function isResolutionAllowed(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  return Math.max(width, height) <= MAX_VIDEO_LONG_SIDE && Math.min(width, height) <= MAX_VIDEO_SHORT_SIDE;
}

/** 解析結果が受け付け条件を満たすか検査する。満たさなければ Mp4Error を投げる。 */
export function assertSupportedMp4(info: Mp4Info): void {
  if (info.videoCodec === "encv" || info.audioCodecs.includes("enca")) {
    throw new Mp4Error("ENCRYPTED", "暗号化（DRM）された動画には対応していません。");
  }
  if (!(ALLOWED_VIDEO_CODECS as readonly string[]).includes(info.videoCodec)) {
    const name =
      info.videoCodec === "hvc1" || info.videoCodec === "hev1"
        ? "H.265/HEVC"
        : info.videoCodec === "av01"
          ? "AV1"
          : info.videoCodec || "不明";
    throw new Mp4Error(
      "UNSUPPORTED_VIDEO_CODEC",
      `映像コーデック「${name}」のままでは保存できません。互換性のため H.264（AVC）の MP4 が必要です（アップロード画面の自動変換を使ってください）。`,
    );
  }
  const badAudio = info.audioCodecs.find((c) => !(ALLOWED_AUDIO_CODECS as readonly string[]).includes(c));
  if (badAudio) {
    throw new Mp4Error(
      "UNSUPPORTED_AUDIO_CODEC",
      `音声コーデック「${badAudio}」のままでは保存できません。AAC 音声が必要です（アップロード画面の自動変換を使ってください）。`,
    );
  }
  if (!isResolutionAllowed(info.width, info.height)) {
    throw new Mp4Error(
      "RESOLUTION_TOO_HIGH",
      `解像度 ${info.width}×${info.height} は保存できる上限（${MAX_VIDEO_LONG_SIDE}×${MAX_VIDEO_SHORT_SIDE}、720p）を超えています。` +
        "保存する動画は720p以下である必要があります（アップロード画面の自動変換を使ってください）。",
    );
  }
}

/** メモリ上のバイト列を ByteReader として扱う（テスト・小さいファイル用） */
export function bytesReader(bytes: Uint8Array): ByteReader {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)),
  };
}
