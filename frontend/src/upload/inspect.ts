// アップロード前のローカル検査（ブラウザ内で完結。サーバー側でも同じ検査を必ず行う）
import { ALLOWED_VIDEO_MIME } from "../../../shared/constants";
import { Mp4Error, assertSupportedMp4, parseMp4, type ByteReader, type Mp4Info } from "../../../shared/mp4";

/** Blob を読み込む（古いブラウザ向けに FileReader にも対応） */
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsArrayBuffer(blob);
  });
}

export function fileReader(file: Blob): ByteReader {
  return {
    size: file.size,
    async read(offset, length) {
      const end = Math.min(file.size, offset + length);
      if (end <= offset) return new Uint8Array();
      return new Uint8Array(await readBlob(file.slice(offset, end)));
    },
  };
}

export type InspectResult = { ok: true; info: Mp4Info } | { ok: false; reasons: string[]; info?: Mp4Info };

export async function inspectVideoFile(file: File, maxBytes: number): Promise<InspectResult> {
  const reasons: string[] = [];
  if (!/\.mp4$/i.test(file.name)) reasons.push("拡張子が .mp4 のファイルを選択してください。");
  if (file.type && file.type !== ALLOWED_VIDEO_MIME) reasons.push(`ファイルの種類が ${file.type} です。MP4（video/mp4）のみ対応しています。`);
  if (file.size > maxBytes) {
    reasons.push(`ファイルサイズ（${(file.size / 1024 / 1024).toFixed(1)}MB）が上限（${Math.floor(maxBytes / 1024 / 1024)}MB）を超えています。`);
  }
  if (file.size === 0) reasons.push("ファイルが空です。");
  let info: Mp4Info | undefined;
  try {
    info = await parseMp4(fileReader(file));
    assertSupportedMp4(info);
  } catch (err) {
    reasons.push(err instanceof Mp4Error ? err.message : "動画ファイルを解析できませんでした。");
  }
  if (reasons.length || !info) return { ok: false, reasons, info };
  return { ok: true, info };
}

/** 動画の指定時刻のフレームからサムネイル画像（JPEG）を作る */
export function captureThumbnail(file: File, atSeconds: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    const cleanup = () => URL.revokeObjectURL(url);
    const fail = () => {
      cleanup();
      reject(new Error("このブラウザでは動画からサムネイルを作成できませんでした。画像ファイルを指定してください。"));
    };
    v.addEventListener("error", fail, { once: true });
    v.addEventListener(
      "loadedmetadata",
      () => {
        v.currentTime = Math.min(Math.max(0, atSeconds), Math.max(0, v.duration - 0.1));
      },
      { once: true },
    );
    v.addEventListener(
      "seeked",
      () => {
        const w = 640;
        const h = Math.round((w * (v.videoHeight || 360)) / (v.videoWidth || 640));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return fail();
        ctx.drawImage(v, 0, 0, w, h);
        canvas.toBlob(
          (blob) => {
            cleanup();
            if (blob) resolve(blob);
            else reject(new Error("サムネイルを作成できませんでした。"));
          },
          "image/jpeg",
          0.82,
        );
      },
      { once: true },
    );
  });
}
