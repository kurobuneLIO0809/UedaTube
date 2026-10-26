import { useEffect, useRef, useState } from "react";
import { ALLOWED_THUMBNAIL_MIME, LIMITS, MAX_THUMBNAIL_BYTES, RETENTION_DAYS, RETENTION_MS } from "../../../shared/constants";
import { validateVideoMeta } from "../../../shared/validation";
import { getDashboard } from "../api/client";
import { config } from "../config";
import { href } from "../router";
import { captureThumbnail, inspectVideoFile, type InspectResult } from "../upload/inspect";
import { VideoUpload, type UploadProgress } from "../upload/uploader";
import { formatBytes, formatDateTime, formatTime } from "../util/format";

type Step = "edit" | "confirm" | "upload";

export function UploadPage() {
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<InspectResult | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(config.categories[0] ?? "その他");
  const [publish, setPublish] = useState(true);
  const [thumb, setThumb] = useState<Blob | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [thumbTime, setThumbTime] = useState(1);
  const [thumbError, setThumbError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [step, setStep] = useState<Step>("edit");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);
  const uploadRef = useRef<VideoUpload | null>(null);

  useEffect(() => {
    getDashboard()
      .then((d) => setMaxBytes(d.limits.maxUploadBytes))
      .catch(() => setMaxBytes(500 * 1024 * 1024));
  }, []);

  useEffect(() => {
    if (!thumb) {
      setThumbUrl(null);
      return;
    }
    const u = URL.createObjectURL(thumb);
    setThumbUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [thumb]);

  // ページを離れるときにアップロード中なら警告
  useEffect(() => {
    const on = (e: BeforeUnloadEvent) => {
      if (progress && ["starting", "uploading", "finishing"].includes(progress.phase)) e.preventDefault();
    };
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, [progress]);

  async function chooseFile(f: File | null) {
    setFile(f);
    setInspection(null);
    setThumb(null);
    setErrors([]);
    if (!f || maxBytes === null) return;
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, "").slice(0, LIMITS.titleMaxChars));
    setInspecting(true);
    try {
      setInspection(await inspectVideoFile(f, maxBytes));
    } finally {
      setInspecting(false);
    }
  }

  async function generateThumb() {
    if (!file) return;
    setThumbError(null);
    try {
      setThumb(await captureThumbnail(file, thumbTime));
    } catch (err) {
      setThumbError(err instanceof Error ? err.message : "サムネイルを作成できませんでした。");
    }
  }

  function chooseThumb(f: File | null) {
    setThumbError(null);
    if (!f) return;
    if (!(ALLOWED_THUMBNAIL_MIME as readonly string[]).includes(f.type)) return setThumbError("JPEG・PNG・WebP の画像を選択してください。");
    if (f.size > MAX_THUMBNAIL_BYTES) return setThumbError("サムネイル画像は2MB以下にしてください。");
    setThumb(f);
  }

  function toConfirm() {
    const errs: string[] = [];
    if (!file) errs.push("動画ファイルを選択してください。");
    else if (!inspection?.ok) errs.push("この動画はアップロードできません。理由を確認してください。");
    const meta = validateVideoMeta({ title, description, category });
    if (!meta.ok) errs.push(...meta.errors);
    setErrors(errs);
    if (errs.length === 0) setStep("confirm");
  }

  async function start() {
    if (!file) return;
    setStep("upload");
    const up = uploadRef.current ?? new VideoUpload(file, { title, description, category, publish }, thumb, setProgress);
    uploadRef.current = up;
    try {
      setDoneId(await up.run());
    } catch {
      // 進捗表示にエラーを出している
    }
  }

  async function cancel() {
    await uploadRef.current?.cancel();
    uploadRef.current = null;
  }

  function resetAll() {
    uploadRef.current = null;
    setProgress(null);
    setDoneId(null);
    setStep("edit");
  }

  const info = inspection?.info;
  const pct = progress && progress.total ? Math.floor((progress.loaded / progress.total) * 100) : 0;

  return (
    <section aria-labelledby="upload-title" className="narrow">
      <p>
        <a href={href("/admin")}>← 管理ダッシュボード</a>
      </p>
      <h1 id="upload-title">動画のアップロード</h1>
      <p className="muted">
        MP4（H.264 + AAC）、解像度1280×720（720p）以下の動画に対応しています。このサイトでは動画の変換は行いません。
        {maxBytes !== null && ` 最大 ${formatBytes(maxBytes)}。`}
      </p>

      <ol className="steps" aria-label="手順">
        <li className={step === "edit" ? "on" : ""}>1. 入力</li>
        <li className={step === "confirm" ? "on" : ""}>2. 確認</li>
        <li className={step === "upload" ? "on" : ""}>3. アップロード</li>
      </ol>

      {step === "edit" && (
        <div className="card form-card">
          <label className="field">
            <span className="label">動画ファイル（.mp4）</span>
            <input type="file" accept="video/mp4,.mp4" onChange={(e) => void chooseFile(e.target.files?.[0] ?? null)} disabled={maxBytes === null} />
          </label>
          {inspecting && <p role="status">動画を検査しています…</p>}
          {inspection && (
            <div className={`inspect ${inspection.ok ? "ok" : "ng"}`} role={inspection.ok ? "status" : "alert"}>
              {info && (
                <p>
                  {info.width}×{info.height} / {formatTime(info.durationSeconds)} / 映像 {info.videoCodec} / 音声 {info.audioCodecs.join(", ") || "なし"} /{" "}
                  {file && formatBytes(file.size)}
                </p>
              )}
              {inspection.ok ? (
                <p>✔ アップロードできます。</p>
              ) : (
                <ul>
                  {inspection.reasons.map((r) => (
                    <li key={r}>✖ {r}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <label className="field">
            <span className="label">タイトル（必須）</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.titleMaxChars} />
          </label>
          <label className="field">
            <span className="label">説明文</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={LIMITS.descriptionMaxChars} rows={4} />
          </label>
          <label className="field">
            <span className="label">カテゴリ</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {config.categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>

          <fieldset className="field-group">
            <legend>サムネイル（任意）</legend>
            <div className="row wrap">
              <label className="field">
                <span className="label">画像を指定</span>
                <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => chooseThumb(e.target.files?.[0] ?? null)} />
              </label>
              <label className="field">
                <span className="label">または動画の {thumbTime} 秒の場面から作成</span>
                <div className="row">
                  <input type="number" className="num" min={0} max={info ? Math.floor(info.durationSeconds) : 0} value={thumbTime} onChange={(e) => setThumbTime(Math.max(0, Number(e.target.value) || 0))} />
                  <button type="button" className="btn small" onClick={() => void generateThumb()} disabled={!inspection?.ok}>
                    動画から作成
                  </button>
                </div>
              </label>
            </div>
            {thumbError && <p className="form-error">{thumbError}</p>}
            {thumbUrl && (
              <div className="row">
                <img src={thumbUrl} alt="サムネイルのプレビュー" className="thumb-preview" />
                <button type="button" className="btn small ghost" onClick={() => setThumb(null)}>
                  取り消す
                </button>
              </div>
            )}
          </fieldset>

          <label className="check">
            <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
            アップロード後すぐに公開する（外すと非公開で登録し、確認後に公開できます）
          </label>

          {errors.length > 0 && (
            <ul className="form-error" role="alert">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <div className="row">
            <span className="spacer" />
            <button type="button" className="btn primary" onClick={toConfirm} disabled={inspecting}>
              確認へ進む
            </button>
          </div>
        </div>
      )}

      {step === "confirm" && file && info && (
        <div className="card form-card">
          <h2 className="section-title">公開前の確認</h2>
          <dl className="confirm-list">
            <dt>ファイル</dt>
            <dd>
              {file.name}（{formatBytes(file.size)}）
            </dd>
            <dt>動画</dt>
            <dd>
              {info.width}×{info.height} / {formatTime(info.durationSeconds)}
            </dd>
            <dt>タイトル</dt>
            <dd>{title}</dd>
            <dt>説明文</dt>
            <dd className="pre-wrap">{description || "（なし）"}</dd>
            <dt>カテゴリ</dt>
            <dd>{category}</dd>
            <dt>サムネイル</dt>
            <dd>{thumbUrl ? <img src={thumbUrl} alt="" className="thumb-preview" /> : "なし"}</dd>
            <dt>公開状態</dt>
            <dd>{publish ? "アップロード完了後すぐに公開" : "非公開（あとで公開）"}</dd>
            <dt>削除予定日時</dt>
            <dd>
              アップロード完了から{RETENTION_DAYS}日後（今すぐ完了した場合：{formatDateTime(new Date(Date.now() + RETENTION_MS).toISOString())}）。
              <br />
              期限を過ぎると動画とコメントは自動で削除され、延長・再公開はできません。
            </dd>
          </dl>
          <div className="row">
            <button type="button" className="btn" onClick={() => setStep("edit")}>
              戻る
            </button>
            <span className="spacer" />
            <button type="button" className="btn primary" onClick={() => void start()}>
              アップロードを開始
            </button>
          </div>
        </div>
      )}

      {step === "upload" && progress && (
        <div className="card form-card" aria-live="polite">
          <h2 className="section-title">
            {progress.phase === "done"
              ? "アップロードが完了しました"
              : progress.phase === "error"
                ? "アップロードに失敗しました"
                : progress.phase === "canceled"
                  ? "キャンセルしました"
                  : "アップロード中…"}
          </h2>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="アップロードの進捗">
            <div className="progress-bar" style={{ width: `${pct}%` }} />
          </div>
          <p>
            {pct}%（{formatBytes(progress.loaded)} / {formatBytes(progress.total)}）
            {progress.partCount > 0 && ` パート ${progress.part}/${progress.partCount}`}
          </p>
          {progress.message && <p className={progress.phase === "error" ? "form-error" : "muted"}>{progress.message}</p>}
          <div className="row wrap">
            {["starting", "uploading", "finishing"].includes(progress.phase) && (
              <button type="button" className="btn danger" onClick={() => void cancel()}>
                キャンセル
              </button>
            )}
            {progress.phase === "error" && (
              <>
                <button type="button" className="btn primary" onClick={() => void start()}>
                  再試行
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void cancel();
                    resetAll();
                  }}
                >
                  やめて入力に戻る
                </button>
              </>
            )}
            {progress.phase === "canceled" && (
              <button type="button" className="btn" onClick={resetAll}>
                入力に戻る
              </button>
            )}
            {progress.phase === "done" && doneId && (
              <>
                <a className="btn primary" href={href(`/watch/${doneId}`)}>
                  動画を確認する
                </a>
                <a className="btn" href={href(`/admin/videos/${doneId}`)}>
                  動画の管理
                </a>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    resetAll();
                    setFile(null);
                    setInspection(null);
                    setTitle("");
                    setDescription("");
                    setThumb(null);
                  }}
                >
                  続けてアップロード
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
