import { describe, expect, it } from "vitest";
import { buildMp4 } from "../../../shared/testing/mp4fixture";
import { inspectVideoFile } from "./inspect";

const MB = 1024 * 1024;
const file = (bytes: Uint8Array, name = "a.mp4", type = "video/mp4") => new File([bytes as BlobPart], name, { type });

describe("アップロード前の検査", () => {
  it("720p以下のMP4は通す", async () => {
    const r = await inspectVideoFile(file(buildMp4({ width: 1280, height: 720 })), 100 * MB);
    expect(r.ok).toBe(true);
  });

  it("720pを超える動画は理由を表示して拒否する", async () => {
    const r = await inspectVideoFile(file(buildMp4({ width: 1920, height: 1080 })), 100 * MB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/1920×1080.*720p/);
  });

  it("MP4以外・サイズ超過を拒否する", async () => {
    const webm = new Uint8Array(100);
    webm.set([0x1a, 0x45, 0xdf, 0xa3]);
    const r1 = await inspectVideoFile(file(webm, "a.webm", "video/webm"), 100 * MB);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reasons.length).toBeGreaterThanOrEqual(2);
    const r2 = await inspectVideoFile(file(buildMp4({ mdatBytes: 2 * MB })), 1 * MB);
    expect(r2.ok).toBe(false);
  });
});
