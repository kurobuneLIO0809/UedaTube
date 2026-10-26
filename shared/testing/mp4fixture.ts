// テスト専用：最小構成のMP4バイト列を生成する。
// 実際の映像データは含まないが、解析器が読むボックス構造は本物と同じ。

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const len = 8 + payloads.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let p = 8;
  for (const pl of payloads) {
    out.set(pl, p);
    p += pl.length;
  }
  return out;
}

function bytes(n: number): Uint8Array {
  return new Uint8Array(n);
}

function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v);
  return b;
}

function u16(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v);
  return b;
}

function str(s: string): Uint8Array {
  return new Uint8Array(Array.from(s, (c) => c.charCodeAt(0)));
}

export interface FixtureOptions {
  width?: number;
  height?: number;
  durationSeconds?: number;
  videoCodec?: string;
  audioCodec?: string | null;
  majorBrand?: string;
  /** moov を mdat の後ろに置く（faststart でないファイル） */
  moovAtEnd?: boolean;
  /** mdat の大きさ（バイト） */
  mdatBytes?: number;
}

function tkhd(width: number, height: number): Uint8Array {
  // version 0: flags(4) creation(4) modification(4) trackId(4) reserved(4) duration(4)
  // reserved(8) layer(2) altgroup(2) volume(2) reserved(2) matrix(36) width(4) height(4)
  return box("tkhd", bytes(4), bytes(4), bytes(4), u32(1), bytes(4), bytes(4), bytes(8), bytes(8), bytes(36), u32(width * 65536), u32(height * 65536));
}

function hdlr(handler: string): Uint8Array {
  return box("hdlr", bytes(4), bytes(4), str(handler), bytes(12), str("h\0"));
}

function visualEntry(codec: string, width: number, height: number): Uint8Array {
  return box(codec, bytes(6), u16(1), bytes(16), u16(width), u16(height), bytes(50));
}

function audioEntry(codec: string): Uint8Array {
  return box(codec, bytes(6), u16(1), bytes(20));
}

function trak(handler: string, entry: Uint8Array, width: number, height: number): Uint8Array {
  const stsd = box("stsd", bytes(4), u32(1), entry);
  return box("trak", tkhd(width, height), box("mdia", box("mdhd", bytes(24)), hdlr(handler), box("minf", box("stbl", stsd))));
}

export function buildMp4(opts: FixtureOptions = {}): Uint8Array {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const duration = opts.durationSeconds ?? 60;
  const timescale = 1000;
  const ftyp = box("ftyp", str(opts.majorBrand ?? "isom"), u32(512), str("isomiso2avc1mp41"));
  const mvhd = box("mvhd", bytes(4), bytes(4), bytes(4), u32(timescale), u32(Math.round(duration * timescale)), bytes(80));
  const tracks = [trak("vide", visualEntry(opts.videoCodec ?? "avc1", width, height), width, height)];
  const audio = opts.audioCodec === undefined ? "mp4a" : opts.audioCodec;
  if (audio) tracks.push(trak("soun", audioEntry(audio), 0, 0));
  const moov = box("moov", mvhd, ...tracks);
  const mdatPayload = new Uint8Array(opts.mdatBytes ?? 1024);
  for (let i = 0; i < mdatPayload.length; i++) mdatPayload[i] = i % 251;
  const mdat = box("mdat", mdatPayload);
  const parts = opts.moovAtEnd ? [ftyp, mdat, moov] : [ftyp, moov, mdat];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
