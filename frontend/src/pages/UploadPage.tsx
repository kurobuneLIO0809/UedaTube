import { useEffect, useRef, useState } from "react";
import { ALLOWED_THUMBNAIL_MIME, LIMITS, MAX_THUMBNAIL_BYTES, RETENTION_DAYS, RETENTION_MS } from "../../../shared/constants";
import type { Mp4Info } from "../../../shared/mp4";
import { TRANSCODE_LIMITS, computeTargetSize } from "../../../shared/transcode";
import { validateVideoMeta } from "../../../shared/validation";
import { getDashboard } from "../api/client";
import { config } from "../config";
import { href } from "../router";
import { analyzeSourceFile, captureThumbnail, inspectVideoFile, type SourceAnalysis } from "../upload/inspect";
import { TranscodeError, transcodeTo720p, type TranscodeProgress } from "../upload/transcoder";
import { VideoUpload, type UploadProgress } from "../upload/uploader";
import { formatBytes, formatDateTime, formatTime } from "../util/format";

type Step = "edit" | "convert" | "confirm" | "upload";

/** アップロードする（変換後の、またはそのまま使える）動画 */
interface Prepared {
  file: File;
  info: Mp4Info;
  transcoded: boolean;
  source: { width: number | null; height: number | null; codec: string | null };
}

const PHASE_LABELS: Record<TranscodeProgress["phase"], string> = {
  loading: "変換プログラムを読み込んでいます（初回は約32MBのダウンロード）…",
  probing: "元の動画を調べています…",
  converting: "720p 以下の H.264 / AAC に変換しています…",
  finishing: "変換後のファイルを確認しています…",
};

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒`;
}

export function UploadPage() {
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<SourceAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [forceTranscode, setForceTranscode] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(config.categories[0] ?? "その他");
  const [publish, setPublish] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [step, setStep] = useState<Step>("edit");

  const [convert, setConvert] = useState<{ progress: TranscodeProgress | null; error: string | null }>({ progress: null, error: null });
  const convertAbort = useRef<AbortController | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [thumb, setThumb] = useState<Blob | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [thumbTime, setThumbTime] = useState(1);
  const [thumbError, setThumbError] = useState<string | null>(null);

  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);
  const uploadRef = useRef<VideoUpload | null>(null);

  useEffect(() => {
    getDashboard()
      .then((d) => setMaxBytes(d.limits.maxUploadBytes))
      .catch(() => setMaxBytes(500 * 1024 * 1024));
  }, []);

  useEffect(() => {
    if (!thumb) return setThumbUrl(null);
    const u = URL.createObjectURL(thumb);
    setThumbUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [thumb]);

  // 変換後の動画のプレビュー（実際にこのブラウザで再生できるかを確認する）
  useEffect(() => {
    if (!prepared) return setPreviewUrl(null);
    const u = URL.createObjectURL(prepared.file);
    setPreviewUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [prepared]);

  // 変換中・アップロード中にページを離れようとしたら警告
  useEffect(() => {
    const busy = step === "convert" && !convert.error ? true : !!progress && ["starting", "uploading", "finishing"].includes(progress.phase);
    if (!busy) return;
    const on = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, [step, convert.error, progress]);

  // ページを離れたら変換を止める
  useEffect(() => () => convertAbort.current?.abort(), []);

  async function chooseFile(f: File | null) {
    setFile(f);
    setAnalysis(null);
    setPrepared(null);
    setThumb(null);
    setErrors([]);
    setForceTranscode(false);
    if (!f || maxBytes === null) return;
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, "").slice(0, LIMITS.titleMaxChars));
    setAnalyzing(true);
    try {
      setAnalysis(await analyzeSourceFile(f, maxBytes));
    } finally {
      setAnalyzing(false);
    }
  }

  const needsTranscode = !!analysis && (analysis.transcodeReasons.length > 0 || forceTranscode);

  async function next() {
    const errs: string[] = [];
    if (!file || !analysis) errs.push("動画ファイルを選択してください。");
    else if (analysis.blockers.length) errs.push(...analysis.blockers);
    const meta = validateVideoMeta({ title, description, category });
    if (!meta.ok) errs.push(...meta.errors);
    setErrors(errs);
    if (errs.length || !file || !analysis || maxBytes === null) return;

    if (needsTranscode) {
      await runConvert(file);
      return;
    }
    // 変換不要：そのままアップロードできるか最終確認
    const check = await inspectVideoFile(file, maxBytes);
    if (!check.ok) return setErrors(check.reasons);
    setPrepared({
      file,
      info: check.info,
      transcoded: false,
      source: { width: check.info.width, height: check.info.height, codec: check.info.videoCodec },
    });
    setStep("confirm");
  }

  async function runConvert(source: File) {
    if (maxBytes === null) return;
    setStep("convert");
    setConvert({ progress: null, error: null });
    const ac = new AbortController();
    convertAbort.current = ac;
    try {
      const out = await transcodeTo720p(source, { signal: ac.signal, onProgress: (p) => setConvert({ progress: p, error: null }) });
      // 変換後のファイルを、サーバーと同じ規則で検査する（不合格ならアップロードしない）
      const check = await inspectVideoFile(out.file, maxBytes);
      if (!check.ok) {
        setConvert({ progress: null, error: `変換後の動画が条件を満たしませんでした：${check.reasons.join(" ")}` });
        return;
      }
      setPrepared({
        file: out.file,
        info: check.info,
        transcoded: true,
        source: { width: out.sourceWidth, height: out.sourceHeight, codec: analysis?.info?.videoCodec ?? null },
      });
      setThumb(null);
      setStep("confirm");
    } catch (err) {
      setConvert({ progress: null, error: err instanceof TranscodeError ? err.message : "変換に失敗しました。" });
    } finally {
      convertAbort.current = null;
    }
  }

  async function generateThumb() {
    if (!prepared) return;
    setThumbError(null);
    try {
      setThumb(await captureThumbnail(prepared.file, thumbTime));
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

  async function start() {
    if (!prepared) return;
    setStep("upload");
    const up =
      uploadRef.current ??
      new VideoUpload(
        prepared.file,
        { title, description, category, publish, source: { ...prepared.source, transcoded: prepared.transcoded } },
        thumb,
        setProgress,
      );
    uploadRef.current = up;
    try {
      setDoneId(await up.run());
    } catch {
      // 進捗表示にエラーを出している
    }
  }

  async function cancelUpload() {
    await uploadRef.current?.cancel();
    uploadRef.current = null;
  }

  function backToEdit() {
    uploadRef.current = null;
    setProgress(null);
    setDoneId(null);
    setStep("edit");
  }

  function resetAll() {
    backToEdit();
    setFile(null);
    setAnalysis(null);
    setPrepared(null);
    setTitle("");
    setDescription("");
    setThumb(null);
  }

  const info = analysis?.info;
  const target = info && info.width > 0 && info.height > 0 ? computeTargetSize(info.width, info.height) : null;
  const pct = progress && progress.total ? Math.floor((progress.loaded / progress.total) * 100) : 0;
  const convPct = convert.progress?.ratio != null ? Math.floor(convert.progress.ratio * 100) : null;

  return (
    <section aria-labelledby="upload-title" className="narrow">
      <p>
        <a href={href("/admin")}>← 管理ダッシュボード</a>
      </p>
      <h1 id="upload-title">動画のアップロード</h1>
      <p className="muted">
        保存される動画は MP4（H.264 + AAC）、1280×720（縦長は720×1280）以下です。条件に合わない動画は、アップロード前にこのブラウザで自動的に変換します。
        {maxBytes !== null && ` 保存できる大きさは1本 ${formatBytes(maxBytes)} まで。`}
      </p>

      <ol className="steps" aria-label="手順">
        <li className={step === "edit" ? "on" : ""}>1. 入力</li>
        <li className={step === "convert" ? "on" : ""}>2. 変換（必要な場合）</li>
        <li className={step === "confirm" ? "on" : ""}>3. 確認</li>
        <li className={step === "upload" ? "on" : ""}>4. アップロード</li>
      </ol>

      {step === "edit" && (
        <div className="card form-card">
          <label className="field">
            <span className="label">動画ファイル（MP4・MOV・WebM など）</span>
            <input
              type="file"
              accept="video/*,.mp4,.m4v,.mov,.webm,.mkv"
              onChange={(e) => void chooseFile(e.target.files?.[0] ?? null)}
              disabled={maxBytes === null}
            />
          </label>
          {analyzing && <p role="status">動画を調べています…</p>}
          {analysis && file && (
            <div className={`inspect ${analysis.blockers.length ? "ng" : "ok"}`} role={analysis.blockers.length ? "alert" : "status"}>
              <p>
                {info
                  ? `${info.width}×${info.height} / ${formatTime(info.durationSeconds)} / 映像 ${info.videoCodec} / 音声 ${info.audioCodecs.join(", ") || "なし"} / `
                  : ""}
                {formatBytes(file.size)}
              </p>
              {analysis.blockers.length > 0 ? (
                <ul>
                  {analysis.blockers.map((r) => (
                    <li key={r}>✖ {r}</li>
                  ))}
                </ul>
              ) : analysis.transcodeReasons.length > 0 ? (
                <>
                  <p>⟳ アップロード前に、このブラウザで自動変換します。</p>
                  <ul>
                    {analysis.transcodeReasons.map((r) => (
                      <li key={r}>・{r}</li>
                    ))}
                  </ul>
                  {target && (
                    <p className="small">
                      変換後：{target.width}×{target.height}（元の縦横比を維持）・H.264 / AAC の MP4
                    </p>
                  )}
                  <p className="small muted">
                    変換には動画の長さの数倍の時間がかかることがあります。変換中はこのタブを開いたままにしてください。元の動画はアップロードされません。
                  </p>
                </>
              ) : (
                <>
                  <p>✔ そのままアップロードできます（MP4 / H.264 / 720p 以下）。</p>
                  <label className="check small">
                    <input type="checkbox" checked={forceTranscode} onChange={(e) => setForceTranscode(e.target.checked)} />
                    再生できない端末がある場合に備えて再エンコードする（任意・時間がかかります）
                  </label>
                </>
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
            <button type="button" className="btn primary" onClick={() => void next()} disabled={analyzing || !analysis}>
              {needsTranscode ? "変換を開始" : "確認へ進む"}
            </button>
          </div>
        </div>
      )}

      {step === "convert" && (
        <div className="card form-card" aria-live="polite">
          <h2 className="section-title">{convert.error ? "変換に失敗しました" : "動画を変換しています"}</h2>
          {convert.error ? (
            <>
              <p className="form-error" role="alert">
                {convert.error}
              </p>
              <p className="muted small">動画はアップロード・公開されていません。</p>
              <div className="row wrap">
                <button type="button" className="btn primary" onClick={() => file && void runConvert(file)}>
                  もう一度変換する
                </button>
                <button type="button" className="btn" onClick={backToEdit}>
                  入力に戻る
                </button>
              </div>
            </>
          ) : (
            <>
              <p>{convert.progress ? PHASE_LABELS[convert.progress.phase] : "準備しています…"}</p>
              <div
                className="progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={convPct ?? undefined}
                aria-label="変換の進捗"
              >
                <div className={`progress-bar ${convPct === null ? "indeterminate" : ""}`} style={{ width: `${convPct ?? 100}%` }} />
              </div>
              <p className="muted small">
                {convPct !== null && `${convPct}% ・ `}経過 {formatElapsed(convert.progress?.elapsedMs ?? 0)}（上限 {TRANSCODE_LIMITS.timeoutMs / 3600000} 時間）
              </p>
              <button type="button" className="btn danger" onClick={() => convertAbort.current?.abort()}>
                変換をキャンセル
              </button>
            </>
          )}
        </div>
      )}

      {step === "confirm" && prepared && (
        <div className="card form-card">
          <h2 className="section-title">公開前の確認</h2>
          {previewUrl && (
            <video className="convert-preview" src={previewUrl} controls playsInline preload="metadata" aria-label="アップロードする動画のプレビュー" />
          )}
          <dl className="confirm-list">
            <dt>アップロードする動画</dt>
            <dd>
              {prepared.info.width}×{prepared.info.height} / {formatTime(prepared.info.durationSeconds)} / {prepared.info.videoCodec} /{" "}
              {prepared.info.audioCodecs.join(", ") || "音声なし"} / {formatBytes(prepared.file.size)}
            </dd>
            <dt>変換</dt>
            <dd>
              {prepared.transcoded
                ? `変換済み（元：${prepared.source.width ?? "?"}×${prepared.source.height ?? "?"}${prepared.source.codec ? ` / ${prepared.source.codec}` : ""}）。元の動画はアップロードしません。`
                : "変換なし（元のファイルをそのままアップロード）"}
            </dd>
            <dt>タイトル</dt>
            <dd>{title}</dd>
            <dt>説明文</dt>
            <dd className="pre-wrap">{description || "（なし）"}</dd>
            <dt>カテゴリ</dt>
            <dd>{category}</dd>
            <dt>公開状態</dt>
            <dd>{publish ? "アップロード完了後すぐに公開" : "非公開（あとで公開）"}</dd>
            <dt>削除予定日時</dt>
            <dd>
              アップロード完了から{RETENTION_DAYS}日後（今すぐ完了した場合：{formatDateTime(new Date(Date.now() + RETENTION_MS).toISOString())}）。
              <br />
              期限を過ぎると動画・サムネイル・コメントは自動で削除され、延長・再公開はできません。
            </dd>
          </dl>

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
                  <input
                    type="number"
                    className="num"
                    min={0}
                    max={Math.floor(prepared.info.durationSeconds)}
                    value={thumbTime}
                    onChange={(e) => setThumbTime(Math.max(0, Number(e.target.value) || 0))}
                  />
                  <button type="button" className="btn small" onClick={() => void generateThumb()}>
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

          <div className="row">
            <button type="button" className="btn" onClick={backToEdit}>
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
              <button type="button" className="btn danger" onClick={() => void cancelUpload()}>
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
                    void cancelUpload();
                    backToEdit();
                  }}
                >
                  やめて入力に戻る
                </button>
              </>
            )}
            {progress.phase === "canceled" && (
              <button type="button" className="btn" onClick={backToEdit}>
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
                <button type="button" className="btn ghost" onClick={resetAll}>
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
