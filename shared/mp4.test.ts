import { describe, expect, it } from "vitest";
import { Mp4Error, assertSupportedMp4, bytesReader, isResolutionAllowed, parseMp4 } from "./mp4";
import { buildMp4 } from "./testing/mp4fixture";

async function check(bytes: Uint8Array) {
  const info = await parseMp4(bytesReader(bytes));
  assertSupportedMp4(info);
  return info;
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof Mp4Error ? e.code : String(e);
  }
}

describe("MP4解析", () => {
  it("解像度・長さ・コーデックを読み取る", async () => {
    const info = await check(buildMp4({ width: 1280, height: 720, durationSeconds: 93.25 }));
    expect(info).toMatchObject({ width: 1280, height: 720, durationSeconds: 93.25, videoCodec: "avc1", audioCodecs: ["mp4a"] });
  });

  it("moov が末尾にあるファイルも読める", async () => {
    const info = await check(buildMp4({ moovAtEnd: true, width: 640, height: 360 }));
    expect(info.width).toBe(640);
  });

  it("720pを超える動画を拒否する", async () => {
    expect(await code(check(buildMp4({ width: 1920, height: 1080 })))).toBe("RESOLUTION_TOO_HIGH");
    expect(await code(check(buildMp4({ width: 1280, height: 721 })))).toBe("RESOLUTION_TOO_HIGH");
    expect(await code(check(buildMp4({ width: 720, height: 1280 })))).toBe("OK");
    expect(isResolutionAllowed(1280, 720)).toBe(true);
    expect(isResolutionAllowed(854, 480)).toBe(true);
    expect(isResolutionAllowed(1281, 720)).toBe(false);
  });

  it("対応していない形式を拒否する", async () => {
    const webm = new Uint8Array(64);
    webm.set([0x1a, 0x45, 0xdf, 0xa3]);
    expect(await code(check(webm))).toBe("NOT_MP4");
    expect(await code(check(new Uint8Array(4)))).toBe("NOT_MP4");
    expect(await code(check(buildMp4({ videoCodec: "hvc1" })))).toBe("UNSUPPORTED_VIDEO_CODEC");
    expect(await code(check(buildMp4({ audioCodec: "Opus" })))).toBe("UNSUPPORTED_AUDIO_CODEC");
    expect(await code(check(buildMp4({ majorBrand: "qt  " })))).toBe("QUICKTIME");
    expect(await code(check(buildMp4({ videoCodec: "encv" })))).toBe("ENCRYPTED");
    expect(await code(check(buildMp4({ audioCodec: null })))).toBe("OK");
  });

  it("途中で切れたファイルを拒否する", async () => {
    const full = buildMp4({ moovAtEnd: true });
    expect(await code(check(full.slice(0, full.length - 50)))).toBe("CORRUPT");
  });
});
