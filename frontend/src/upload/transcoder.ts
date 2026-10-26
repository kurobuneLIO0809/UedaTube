// 管理者のブラウザ内で動画を 720p 以下の H.264/AAC MP4 に変換する（FFmpeg.wasm）。
//
// ・元動画はアップロードしない。変換後のファイルだけをアップロードし、サーバーが再検査する。
// ・元動画はブラウザ内のファイルシステムに「マウント」して読むだけで、コピーや保存はしない。
//   変換が終わったら（成功・失敗・キャンセルのいずれでも）作業ファイルを削除し、変換プログラムを終了してメモリを解放する。
// ・同時に実行できる変換は1件まで。大きさ・長さ・処理時間に上限を設ける。
// ・FFmpeg 本体（約32MB）は変換が必要になったときだけ同じサイトから読み込む（閲覧者は読み込まない）。
import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { TRANSCODE_LIMITS, buildTranscodeArgs, parseFfmpegProbeLog } from "../../../shared/transcode";

export type TranscodePhase = "loading" | "probing" | "converting" | "finishing";

export interface TranscodeProgress {
  phase: TranscodePhase;
  /** 0〜1（不明な場合は null） */
  ratio: number | null;
  elapsedMs: number;
}

export class TranscodeError extends Error {
  constructor(
    public code: "BUSY" | "TOO_LARGE" | "TOO_LONG" | "NO_VIDEO" | "LOAD_FAILED" | "FAILED" | "TIMEOUT" | "CANCELED",
    message: string,
  ) {
    super(message);
    this.name = "TranscodeError";
  }
}

let running = false;

export function isTranscoding(): boolean {
  return running;
}

/** FFmpeg 本体の置き場所（ビルド時に public/ffmpeg/ へコピーされる。同じサイトから配信） */
function coreUrls() {
  const base = new URL(`${import.meta.env.BASE_URL}ffmpeg/`, window.location.href);
  return { coreURL: new URL("ffmpeg-core.js", base).href, wasmURL: new URL("ffmpeg-core.wasm", base).href };
}

const MOUNT = "/source";

export async function transcodeTo720p(
  file: File,
  opts: { onProgress?: (p: TranscodeProgress) => void; signal?: AbortSignal } = {},
): Promise<{ file: File; sourceWidth: number | null; sourceHeight: number | null; durationSeconds: number | null }> {
  if (running) throw new TranscodeError("BUSY", "別の動画を変換中です。終わってから実行してください。");
  if (file.size > TRANSCODE_LIMITS.maxInputBytes) {
    throw new TranscodeError(
      "TOO_LARGE",
      `ブラウザで変換できるのは ${Math.floor(TRANSCODE_LIMITS.maxInputBytes / 1024 / 1024)}MB までです。動画を分割するか、パソコンで720pに変換してからアップロードしてください。`,
    );
  }
  running = true;
  const started = performance.now();
  const report = (phase: TranscodePhase, ratio: number | null) =>
    opts.onProgress?.({ phase, ratio, elapsedMs: performance.now() - started });

  let ffmpeg: FFmpeg | null = null;
  let mounted = false;
  const onAbort = () => ffmpeg?.terminate();
  opts.signal?.addEventListener("abort", onAbort);
  const checkAbort = () => {
    if (opts.signal?.aborted) throw new TranscodeError("CANCELED", "変換をキャンセルしました。");
  };

  try {
    report("loading", null);
    const { FFmpeg: FFmpegClass, FFFSType } = await import("@ffmpeg/ffmpeg");
    ffmpeg = new FFmpegClass();
    try {
      await ffmpeg.load(coreUrls());
    } catch {
      checkAbort();
      throw new TranscodeError("LOAD_FAILED", "変換プログラムを読み込めませんでした。通信状況を確認し、再度お試しください。");
    }
    checkAbort();

    // 元動画をコピーせずに読み込めるようにする
    await ffmpeg.createDir(MOUNT);
    await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, MOUNT);
    mounted = true;
    const input = `${MOUNT}/${file.name}`;

    // 元動画の情報（長さ・解像度）を調べる
    report("probing", null);
    const logs: string[] = [];
    const onLog = ({ message }: { message: string }) => {
      if (logs.length < 400) logs.push(message);
    };
    ffmpeg.on("log", onLog);
    await ffmpeg.exec(["-hide_banner", "-i", input], 60_000);
    ffmpeg.off("log", onLog);
    checkAbort();
    const probe = parseFfmpegProbeLog(logs);
    if (probe.width === null) throw new TranscodeError("NO_VIDEO", "映像が見つからないか、このブラウザでは読み込めない形式です。");
    if (probe.durationSeconds !== null && probe.durationSeconds > TRANSCODE_LIMITS.maxDurationSeconds) {
      throw new TranscodeError("TOO_LONG", `ブラウザで変換できるのは ${TRANSCODE_LIMITS.maxDurationSeconds / 60} 分までの動画です。`);
    }

    // 変換
    report("converting", 0);
    const errorLogs: string[] = [];
    const onErrLog = ({ message }: { message: string }) => {
      errorLogs.push(message);
      if (errorLogs.length > 30) errorLogs.shift();
    };
    const onProgress = ({ progress, time }: { progress: number; time: number }) => {
      // time はマイクロ秒。長さが分かっていればそれを優先する
      const ratio = probe.durationSeconds ? time / 1_000_000 / probe.durationSeconds : progress;
      report("converting", Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : null);
    };
    ffmpeg.on("log", onErrLog);
    ffmpeg.on("progress", onProgress);
    const code = await ffmpeg.exec(buildTranscodeArgs(input, "output.mp4"), TRANSCODE_LIMITS.timeoutMs);
    ffmpeg.off("log", onErrLog);
    ffmpeg.off("progress", onProgress);
    checkAbort();
    if (performance.now() - started >= TRANSCODE_LIMITS.timeoutMs) {
      throw new TranscodeError("TIMEOUT", "変換に時間がかかりすぎたため中止しました。短い動画に分けてください。");
    }
    if (code !== 0) {
      const tail = errorLogs.filter((l) => /error|invalid|failed/i.test(l)).slice(-2).join(" / ");
      throw new TranscodeError("FAILED", `変換に失敗しました。${tail ? `（${tail.slice(0, 200)}）` : ""}`);
    }

    report("finishing", 1);
    const data = await ffmpeg.readFile("output.mp4");
    await ffmpeg.deleteFile("output.mp4").catch(() => undefined);
    if (!(data instanceof Uint8Array) || data.length === 0) throw new TranscodeError("FAILED", "変換後のファイルが空です。");
    const name = `${file.name.replace(/\.[^.]+$/, "") || "video"}_720p.mp4`;
    return {
      file: new File([data as BlobPart], name, { type: "video/mp4" }),
      sourceWidth: probe.width,
      sourceHeight: probe.height,
      durationSeconds: probe.durationSeconds,
    };
  } catch (err) {
    if (opts.signal?.aborted) throw new TranscodeError("CANCELED", "変換をキャンセルしました。");
    if (err instanceof TranscodeError) throw err;
    throw new TranscodeError("FAILED", "変換中にエラーが発生しました。ブラウザのメモリが足りない可能性があります。");
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (ffmpeg) {
      try {
        if (mounted && !opts.signal?.aborted) await ffmpeg.unmount(MOUNT);
      } catch {
        // 既に終了している場合は無視
      }
      // 作業ファイル・メモリを解放する
      try {
        ffmpeg.terminate();
      } catch {
        // 既に終了している場合は無視
      }
    }
    running = false;
  }
}
