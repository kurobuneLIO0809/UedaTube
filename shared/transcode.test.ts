// @vitest-environment node
/// <reference types="node" />
// 720p 変換の規則と、実際の FFmpeg で変換した結果の検証。
// ブラウザ（FFmpeg.wasm）と同じ引数を、テストではネイティブの ffmpeg コマンドで実行する。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertSupportedMp4, bytesReader, parseMp4 } from "./mp4";
import { buildMp4 } from "./testing/mp4fixture";
import { buildTranscodeArgs, computeTargetSize, parseFfmpegProbeLog, transcodeReasons } from "./transcode";

describe("変換後の解像度（computeTargetSize）", () => {
  it("横長は 1280×720 以内、縦長は 720×1280 以内に収め、アスペクト比を保つ", () => {
    expect(computeTargetSize(1920, 1080)).toEqual({ width: 1280, height: 720, scaled: true });
    expect(computeTargetSize(3840, 2160)).toEqual({ width: 1280, height: 720, scaled: true });
    expect(computeTargetSize(1080, 1920)).toEqual({ width: 720, height: 1280, scaled: true });
    expect(computeTargetSize(1440, 1080)).toEqual({ width: 960, height: 720, scaled: true });
    expect(computeTargetSize(2560, 1080)).toEqual({ width: 1280, height: 540, scaled: true });
    expect(computeTargetSize(1080, 1080)).toEqual({ width: 720, height: 720, scaled: true });
  });

  it("小さい動画は拡大しない", () => {
    expect(computeTargetSize(640, 360)).toEqual({ width: 640, height: 360, scaled: false });
    expect(computeTargetSize(1280, 720)).toEqual({ width: 1280, height: 720, scaled: false });
  });

  it("どんな大きさでも上限以内・偶数・アスペクト比を維持", () => {
    for (let w = 100; w <= 4000; w += 137) {
      for (let h = 100; h <= 4000; h += 211) {
        const t = computeTargetSize(w, h);
        expect(Math.max(t.width, t.height)).toBeLessThanOrEqual(1280);
        expect(Math.min(t.width, t.height)).toBeLessThanOrEqual(720);
        expect(t.width % 2).toBe(0);
        expect(t.height % 2).toBe(0);
        expect(t.width).toBeLessThanOrEqual(w);
        expect(t.height).toBeLessThanOrEqual(h);
        // 偶数への丸めによる誤差（2ピクセル以内）を除けばアスペクト比は同じ
        if (t.scaled) expect(Math.abs(t.height - (t.width * h) / w)).toBeLessThanOrEqual(2.01 * Math.max(1, h / w));
      }
    }
  });
});

describe("変換が必要かどうかの判定", () => {
  it("720p 以下の H.264/AAC MP4 は変換しない", async () => {
    const info = await parseMp4(bytesReader(buildMp4({ width: 1280, height: 720 })));
    expect(transcodeReasons(info)).toEqual([]);
  });

  it("1080p・HEVC・MOV・MP4 以外は変換する", async () => {
    expect(transcodeReasons(await parseMp4(bytesReader(buildMp4({ width: 1920, height: 1080 }))))[0]).toContain("1280×720");
    expect(transcodeReasons(await parseMp4(bytesReader(buildMp4({ videoCodec: "hvc1" }))))[0]).toContain("H.264");
    expect(transcodeReasons(await parseMp4(bytesReader(buildMp4({ audioCodec: "Opus" }))))[0]).toContain("AAC");
    expect(transcodeReasons(null, "MP4ファイルではありません。").length).toBe(1);
  });

  it("FFmpeg のログから長さと解像度を読み取る", () => {
    const log = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input':",
      "  Duration: 00:01:02.50, start: 0.000000, bitrate: 1000 kb/s",
      "  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps",
    ];
    expect(parseFfmpegProbeLog(log)).toEqual({ durationSeconds: 62.5, width: 1920, height: 1080 });
  });
});

// 使う ffmpeg：環境変数 FFMPEG_PATH（CI では固定バージョンの静的ビルド）、なければ PATH 上の ffmpeg
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const encoders = spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "";
const missing = ["libx264", "libx265", "libvpx-vp9", "libopus", " aac "].filter((e) => !encoders.includes(e));
const hasFfmpeg = missing.length === 0;
// CI（REQUIRE_FFMPEG=1）では、ffmpeg が無い・必要なエンコーダーが無い場合にスキップせず失敗させる
if (process.env.REQUIRE_FFMPEG === "1" && !hasFfmpeg) {
  throw new Error(`実際の FFmpeg による変換テストに必要な ffmpeg（${FFMPEG}）が使えません。不足: ${missing.join(", ") || "ffmpeg 本体"}`);
}
const dir = mkdtempSync(join(tmpdir(), "snico-transcode-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeInput(name: string, args: string[]): string {
  const out = join(dir, name);
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args, out]);
  return out;
}

function transcode(input: string, name: string) {
  const out = join(dir, name);
  const r = spawnSync(FFMPEG, ["-loglevel", "error", ...buildTranscodeArgs(input, out)], { encoding: "utf8" });
  return { status: r.status, out, stderr: r.stderr };
}

async function inspect(path: string) {
  const info = await parseMp4(bytesReader(new Uint8Array(readFileSync(path))));
  assertSupportedMp4(info); // サーバーと同じ検査に合格すること
  return info;
}

/** 実際にデコードできるか（全フレームを読み、エラーが無いこと） */
function decodesCleanly(path: string): boolean {
  const r = spawnSync(FFMPEG, ["-v", "error", "-i", path, "-f", "null", "-"], { encoding: "utf8" });
  return r.status === 0 && r.stderr.trim() === "";
}

const testsrc = (size: string, seconds = 2) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30`, "-t", String(seconds)];
const tone = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-shortest"];

// 実際にエンコードするため、既定の5秒では足りないことがある（特に VP9 の作成）
describe.skipIf(!hasFfmpeg)("実際の FFmpeg による変換（ブラウザと同じ引数）", { timeout: 60_000 }, () => {
  it("1080p 横長の H.264 を 1280×720 の H.264/AAC MP4 に変換する", async () => {
    const input = makeInput("land.mp4", [...testsrc("1920x1080"), ...tone, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"]);
    const r = transcode(input, "land-out.mp4");
    expect(r.status, r.stderr).toBe(0);
    const info = await inspect(r.out);
    expect([info.width, info.height]).toEqual([1280, 720]);
    expect(info.videoCodec).toBe("avc1");
    expect(info.audioCodecs).toEqual(["mp4a"]);
    expect(info.durationSeconds).toBeGreaterThan(1.9);
    expect(decodesCleanly(r.out)).toBe(true);
  });

  it("1080p 縦長（1080×1920）を 720×1280 に変換する", async () => {
    const input = makeInput("port.mp4", [...testsrc("1080x1920"), ...tone, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"]);
    const r = transcode(input, "port-out.mp4");
    expect(r.status, r.stderr).toBe(0);
    const info = await inspect(r.out);
    expect([info.width, info.height]).toEqual([720, 1280]);
    expect(decodesCleanly(r.out)).toBe(true);
  });

  it("4:3・シネマスコープなどのアスペクト比を保つ", async () => {
    for (const [size, expected] of [
      ["1440x1080", [960, 720]],
      ["2560x1080", [1280, 540]],
    ] as const) {
      const input = makeInput(`ar-${size}.mp4`, [...testsrc(size, 1), "-c:v", "libx264", "-preset", "ultrafast"]);
      const r = transcode(input, `ar-${size}-out.mp4`);
      expect(r.status, r.stderr).toBe(0);
      const info = await inspect(r.out);
      expect([info.width, info.height]).toEqual(expected);
      const [w, h] = size.split("x").map(Number);
      expect(Math.abs(info.width / info.height - w / h)).toBeLessThan(0.01);
      expect(info.audioCodecs).toEqual([]); // 音声なしの動画は音声なしのまま
    }
  });

  it("小さい HEVC（H.265）は拡大せず H.264 に再エンコードする", async () => {
    const input = makeInput("small-hevc.mp4", [...testsrc("640x360", 1), "-c:v", "libx265", "-preset", "ultrafast", "-tag:v", "hvc1", "-x265-params", "log-level=error"]);
    expect(transcodeReasons(await parseMp4(bytesReader(new Uint8Array(readFileSync(input)))))).not.toEqual([]);
    const r = transcode(input, "small-hevc-out.mp4");
    expect(r.status, r.stderr).toBe(0);
    const info = await inspect(r.out);
    expect([info.width, info.height, info.videoCodec]).toEqual([640, 360, "avc1"]);
  });

  it("MP4 以外（WebM / VP9 + Opus）の 1080p も MP4 に変換する", async () => {
    const input = makeInput("vp9.webm", [...testsrc("1920x1080", 1), ...tone, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus"]);
    const r = transcode(input, "vp9-out.mp4");
    expect(r.status, r.stderr).toBe(0);
    const info = await inspect(r.out);
    expect([info.width, info.height, info.videoCodec, info.audioCodecs[0]]).toEqual([1280, 720, "avc1", "mp4a"]);
  });

  it("回転情報付きのスマートフォン動画は、見た目の向き（縦長）で 720×1280 にする", async () => {
    const input = makeInput("rotated.mp4", ["-display_rotation", "90", ...testsrc("1920x1080", 1), "-c:v", "libx264", "-preset", "ultrafast"]);
    const r = transcode(input, "rotated-out.mp4");
    expect(r.status, r.stderr).toBe(0);
    const info = await inspect(r.out);
    expect([info.width, info.height]).toEqual([720, 1280]);
  });

  it("壊れたファイルは変換に失敗し、出力ファイルを作らない", () => {
    const broken = join(dir, "broken.mp4");
    const bytes = buildMp4({ width: 1920, height: 1080 });
    writeFileSync(broken, bytes.slice(0, 200));
    const r = transcode(broken, "broken-out.mp4");
    expect(r.status).not.toBe(0);
    expect(existsSync(r.out)).toBe(false);
  });
});
