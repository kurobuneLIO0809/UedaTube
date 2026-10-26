import { describe, expect, it } from "vitest";
import { buildMp4 } from "../../../shared/testing/mp4fixture";
import { analyzeSourceFile, inspectVideoFile } from "./inspect";

const MB = 1024 * 1024;
const file = (bytes: Uint8Array, name = "a.mp4", type = "video/mp4") => new File([bytes as BlobPart], name, { type });

describe("そのままアップロードできるかの最終確認（inspectVideoFile）", () => {
  it("720p以下のMP4は通す", async () => {
    const r = await inspectVideoFile(file(buildMp4({ width: 1280, height: 720 })), 100 * MB);
    expect(r.ok).toBe(true);
  });

  it("720pを超える動画は理由を表示して拒否する（変換せずに送ることはできない）", async () => {
    const r = await inspectVideoFile(file(buildMp4({ width: 1920, height: 1080 })), 100 * MB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/1920×1080.*720p/);
  });

  it("MP4以外・サイズ超過を拒否する", async () => {
    const webm = new Uint8Array(100);
    webm.set([0x1a, 0x45, 0xdf, 0xa3]);
    const r1 = await inspectVideoFile(file(webm, "a.webm", "video/webm"), 100 * MB);
    expect(r1.ok).toBe(false);
    const r2 = await inspectVideoFile(file(buildMp4({ mdatBytes: 2 * MB })), 1 * MB);
    expect(r2.ok).toBe(false);
  });
});

describe("変換が必要かの判定（analyzeSourceFile）", () => {
  it("1080p横長・縦長は変換対象になり、変換後の大きさを示す", async () => {
    const land = await analyzeSourceFile(file(buildMp4({ width: 1920, height: 1080 })), 100 * MB);
    expect(land.blockers).toEqual([]);
    expect(land.transcodeReasons.join()).toContain("1280×720");
    const port = await analyzeSourceFile(file(buildMp4({ width: 1080, height: 1920 })), 100 * MB);
    expect(port.transcodeReasons.join()).toContain("720×1280");
  });

  it("720p以下のH.264/AACはそのままアップロードできる", async () => {
    const r = await analyzeSourceFile(file(buildMp4({ width: 1280, height: 720 })), 100 * MB);
    expect(r).toMatchObject({ transcodeReasons: [], blockers: [] });
  });

  it("MOV・WebM・HEVC は変換対象", async () => {
    const webm = new Uint8Array(100);
    webm.set([0x1a, 0x45, 0xdf, 0xa3]);
    expect((await analyzeSourceFile(file(webm, "a.webm", "video/webm"), 100 * MB)).transcodeReasons.length).toBe(1);
    expect((await analyzeSourceFile(file(buildMp4({ videoCodec: "hvc1" })), 100 * MB)).transcodeReasons.length).toBeGreaterThan(0);
  });

  it("上限を超える大きさは変換して小さくし、変換もできない大きさは止める", async () => {
    const r = await analyzeSourceFile(file(buildMp4({ mdatBytes: 2 * MB })), 1 * MB);
    expect(r.transcodeReasons.join()).toContain("上限");
    const huge = new File([new Uint8Array(16) as BlobPart], "huge.mov", { type: "video/quicktime" });
    Object.defineProperty(huge, "size", { value: 2 * 1024 * MB });
    const h = await analyzeSourceFile(huge, 500 * MB);
    expect(h.blockers.join()).toContain("変換できるのは");
  });

  it("動画以外のファイルは止める", async () => {
    const r = await analyzeSourceFile(new File(["hello"], "a.txt", { type: "text/plain" }), 100 * MB);
    expect(r.blockers.length).toBeGreaterThan(0);
  });
});
