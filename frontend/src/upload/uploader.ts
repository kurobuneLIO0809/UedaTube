// 管理者による動画の分割アップロード（進捗表示・キャンセル・再試行に対応）
//
// Cloudflare Workers はリクエスト本文の大きさに上限（無料プランで100MB）があるため、
// 動画を一定サイズのパートに分けて送り、R2 のマルチパートアップロードで結合する。
import { ApiError, apiUrl, request } from "../api/client";
import { getToken } from "../api/session";

export interface UploadMeta {
  title: string;
  description: string;
  category: string;
  publish: boolean;
  /** 元動画の参考情報（ブラウザで自動変換した場合など）。保存される動画の検査はサーバーが行う */
  source?: { width: number | null; height: number | null; codec: string | null; transcoded: boolean };
}

export interface UploadProgress {
  phase: "starting" | "uploading" | "finishing" | "thumbnail" | "done" | "error" | "canceled";
  loaded: number;
  total: number;
  part: number;
  partCount: number;
  message?: string;
}

type Part = { partNumber: number; etag: string };

/** 1パートを XMLHttpRequest で送る（fetch では送信の進捗が取れないため） */
function putPart(url: string, token: string, blob: Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<Part> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let body: { partNumber?: number; etag?: string; error?: { code: string; message: string } } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // 下で処理
      }
      if (xhr.status === 200 && body.etag && body.partNumber) resolve({ partNumber: body.partNumber, etag: body.etag });
      else reject(new ApiError(xhr.status, body.error?.code ?? "PART_FAILED", body.error?.message ?? `パートの送信に失敗しました（${xhr.status}）。`));
    };
    xhr.onerror = () => reject(new ApiError(0, "NETWORK", "通信が切断されました。"));
    xhr.ontimeout = () => reject(new ApiError(0, "TIMEOUT", "通信がタイムアウトしました。"));
    xhr.onabort = () => reject(new ApiError(0, "ABORTED", "キャンセルしました。"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.timeout = 10 * 60 * 1000;
    xhr.send(blob);
  });
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new ApiError(0, "ABORTED", "キャンセルしました。"));
    });
  });

export class VideoUpload {
  videoId: string | null = null;
  private parts: Part[] = [];
  private partSize = 0;
  private partCount = 0;
  private controller = new AbortController();
  private progress: UploadProgress;

  constructor(
    private file: File,
    private meta: UploadMeta,
    private thumbnail: Blob | null,
    private onProgress: (p: UploadProgress) => void,
  ) {
    this.progress = { phase: "starting", loaded: 0, total: file.size, part: 0, partCount: 0 };
  }

  private emit(p: Partial<UploadProgress>) {
    this.progress = { ...this.progress, ...p };
    this.onProgress(this.progress);
  }

  /** アップロードを開始、または失敗したところから再開する */
  async run(): Promise<string> {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    try {
      if (!this.videoId) {
        this.emit({ phase: "starting", message: undefined });
        const r = await request<{ videoId: string; partSize: number; partCount: number }>("/api/admin/videos", {
          method: "POST",
          auth: "admin",
          json: {
            ...this.meta,
            // 中身が MP4 であることは検査済み。拡張子が .m4v などの場合も .mp4 として登録する
            fileName: this.file.name.replace(/\.[^.]*$/, "") + ".mp4",
            fileSize: this.file.size,
            contentType: "video/mp4",
          },
          signal,
        });
        this.videoId = r.videoId;
        this.partSize = r.partSize;
        this.partCount = r.partCount;
      }
      const token = getToken("admin");
      if (!token) throw new ApiError(401, "UNAUTHENTICATED", "管理者のセッションが切れました。もう一度ログインしてください。");

      for (let n = this.parts.length + 1; n <= this.partCount; n++) {
        const start = (n - 1) * this.partSize;
        const blob = this.file.slice(start, Math.min(this.file.size, start + this.partSize));
        this.emit({ phase: "uploading", part: n, partCount: this.partCount, loaded: start, message: undefined });
        let attempt = 0;
        for (;;) {
          try {
            const part = await putPart(
              apiUrl(`/api/admin/videos/${this.videoId}/parts/${n}`),
              token,
              blob,
              (loaded) => this.emit({ loaded: start + loaded }),
              signal,
            );
            this.parts.push(part);
            break;
          } catch (err) {
            // 通信エラーなどは自動で3回まで再試行
            if (signal.aborted || !(err instanceof ApiError) || (err.status >= 400 && err.status < 500) || ++attempt >= 3) throw err;
            this.emit({ message: `通信エラーのため再試行しています（${attempt}/3）…` });
            await sleep(1000 * 2 ** attempt, signal);
          }
        }
      }

      this.emit({ phase: "finishing", loaded: this.file.size, message: "サーバーで動画を検査しています…" });
      await request("/api/admin/videos/" + this.videoId + "/complete", {
        method: "POST",
        auth: "admin",
        json: { parts: this.parts },
        signal,
        timeoutMs: 120_000,
      });

      if (this.thumbnail) {
        this.emit({ phase: "thumbnail", message: "サムネイルを登録しています…" });
        await uploadThumbnail(this.videoId, this.thumbnail).catch(() => {
          // サムネイルの失敗は動画の公開を妨げない（管理画面から再設定できる）
          this.emit({ message: "サムネイルの登録に失敗しました。動画管理画面から再設定できます。" });
        });
      }
      this.emit({ phase: "done" });
      return this.videoId;
    } catch (err) {
      if (signal.aborted) {
        this.emit({ phase: "canceled", message: "アップロードをキャンセルしました。" });
      } else {
        // サーバー側で検査に失敗した動画（422）は再開できないので最初からやり直す
        if (err instanceof ApiError && err.status === 422) this.reset();
        this.emit({ phase: "error", message: err instanceof Error ? err.message : "アップロードに失敗しました。" });
      }
      throw err;
    }
  }

  private reset() {
    this.videoId = null;
    this.parts = [];
  }

  /** キャンセルして、サーバーに残った途中のデータを削除する */
  async cancel(): Promise<void> {
    this.controller.abort();
    const id = this.videoId;
    this.reset();
    if (id) await request(`/api/admin/videos/${id}`, { method: "DELETE", auth: "admin" }).catch(() => undefined);
  }
}

export async function uploadThumbnail(videoId: string, blob: Blob): Promise<void> {
  const token = getToken("admin");
  if (!token) throw new ApiError(401, "UNAUTHENTICATED", "管理者のセッションが切れました。");
  const res = await fetch(apiUrl(`/api/admin/videos/${videoId}/thumbnail`), {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": blob.type || "image/jpeg" },
    body: blob,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiError(res.status, "THUMBNAIL_FAILED", body?.error?.message ?? "サムネイルを登録できませんでした。");
  }
}
