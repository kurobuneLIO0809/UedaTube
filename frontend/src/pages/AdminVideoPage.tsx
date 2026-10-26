import { useCallback, useEffect, useState } from "react";
import { ALLOWED_THUMBNAIL_MIME, LIMITS, MAX_THUMBNAIL_BYTES } from "../../../shared/constants";
import {
  ApiError,
  adminDeleteComment,
  adminDeleteVideo,
  adminGetVideo,
  adminInspectVideo,
  adminListComments,
  adminSetCommentHidden,
  adminUpdateVideo,
} from "../api/client";
import type { AdminVideo, Comment } from "../api/types";
import { ConfirmDialog, ErrorPage, ErrorState, Loading, errorKind } from "../components/Status";
import { MODE_LABELS } from "../components/StyleControls";
import { config } from "../config";
import { displayNickname } from "../comments/engine";
import { href, navigate } from "../router";
import { uploadThumbnail } from "../upload/uploader";
import { formatBytes, formatDateTime, formatPlayback, formatTime, remaining } from "../util/format";
import { statusLabel } from "./AdminDashboardPage";

const PAGE = 50;

export function AdminVideoPage({ id }: { id: string }) {
  const [video, setVideo] = useState<AdminVideo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({ title: "", description: "", category: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [inspect, setInspect] = useState<{ ok: boolean; checks: { name: string; ok: boolean; message: string }[] } | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [confirm, setConfirm] = useState<{ type: "video" } | { type: "comment"; c: Comment } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await adminGetVideo(id);
      setVideo(v);
      setForm({ title: v.title, description: v.description, category: v.category });
    } catch (e) {
      setError(e);
    }
  }, [id]);

  const loadComments = useCallback(async () => {
    try {
      const r = await adminListComments(id, offset, PAGE);
      setComments(r.comments);
      setTotal(r.total);
    } catch {
      // 動画の読み込みエラー側で表示
    }
  }, [id, offset]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadComments();
  }, [loadComments]);

  const report = (e: unknown, fallback: string) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : fallback });

  async function save(patch: Record<string, unknown>, done: string) {
    setBusy(true);
    try {
      const v = await adminUpdateVideo(id, patch);
      setVideo(v);
      setMsg({ ok: true, text: done });
    } catch (e) {
      report(e, "保存できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  async function runInspect() {
    setBusy(true);
    try {
      setInspect(await adminInspectVideo(id));
    } catch (e) {
      report(e, "検査できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  async function replaceThumb(f: File | null) {
    if (!f) return;
    if (!(ALLOWED_THUMBNAIL_MIME as readonly string[]).includes(f.type) || f.size > MAX_THUMBNAIL_BYTES) {
      setMsg({ ok: false, text: "JPEG・PNG・WebP で2MB以下の画像を選択してください。" });
      return;
    }
    try {
      await uploadThumbnail(id, f);
      setMsg({ ok: true, text: "サムネイルを更新しました。" });
      await load();
    } catch (e) {
      report(e, "サムネイルを更新できませんでした。");
    }
  }

  async function onConfirm() {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.type === "video") {
        await adminDeleteVideo(id);
        navigate("/admin");
        return;
      }
      await adminDeleteComment(confirm.c.id);
      setMsg({ ok: true, text: "コメントを削除しました。" });
      await loadComments();
    } catch (e) {
      report(e, "削除できませんでした。");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function toggleHidden(c: Comment) {
    try {
      await adminSetCommentHidden(c.id, !c.hidden);
      await loadComments();
    } catch (e) {
      report(e, "変更できませんでした。");
    }
  }

  if (error) {
    const k = errorKind(error);
    return k === "error" ? <ErrorState error={error} onRetry={() => void load()} /> : <ErrorPage kind={k} />;
  }
  if (!video) return <Loading />;
  const editable = (video.status === "published" || video.status === "hidden") && !video.expired;

  return (
    <section aria-labelledby="av-title" className="narrow">
      <p>
        <a href={href("/admin")}>← 管理ダッシュボード</a>
      </p>
      <div className="row wrap">
        <h1 id="av-title">{video.title}</h1>
        <span className="chip">{statusLabel(video)}</span>
        <span className="spacer" />
        {editable && (
          <a className="btn" href={href(`/watch/${video.id}`)}>
            視聴ページで確認
          </a>
        )}
      </div>
      {msg && (
        <p className={msg.ok ? "form-success" : "form-error"} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </p>
      )}

      <div className="card">
        <dl className="confirm-list">
          <dt>投稿日時</dt>
          <dd>{formatDateTime(video.uploadedAt)}</dd>
          <dt>削除予定日時</dt>
          <dd>
            {formatDateTime(video.expiresAt)} {video.expiresAt && `（${remaining(video.expiresAt)}）`}
          </dd>
          <dt>動画</dt>
          <dd>
            {video.width ?? "?"}×{video.height ?? "?"} / {formatTime(video.durationSeconds)} / {video.videoCodec ?? "?"} / {formatBytes(video.fileSize)}
          </dd>
          <dt>元の動画</dt>
          <dd>
            {video.source?.transcoded
              ? `自動変換済み（元：${video.source.width ?? "?"}×${video.source.height ?? "?"}${video.source.codec ? ` / ${video.source.codec}` : ""}）。元の動画は保存していません。`
              : "変換なし（アップロードされたファイルをそのまま保存）"}
          </dd>
          {video.failureReason && (
            <>
              <dt>失敗の理由</dt>
              <dd className="form-error">{video.failureReason}</dd>
            </>
          )}
          {video.lastDeleteError && (
            <>
              <dt>削除エラー</dt>
              <dd className="form-error">
                {video.lastDeleteError}（{video.deleteAttempts}回試行、自動で再試行されます）
              </dd>
            </>
          )}
        </dl>
        <div className="row wrap">
          <button type="button" className="btn small" onClick={() => void runInspect()} disabled={busy}>
            再生可能か検査
          </button>
          {editable && (
            <>
              <button type="button" className="btn small" onClick={() => void save({ status: video.status === "published" ? "hidden" : "published" }, "公開状態を変更しました。")} disabled={busy}>
                {video.status === "published" ? "非公開にする" : "公開する"}
              </button>
              <button type="button" className="btn small" onClick={() => void save({ commentsEnabled: !video.commentsEnabled }, "コメント受付を変更しました。")} disabled={busy}>
                {video.commentsEnabled ? "コメント受付を停止" : "コメント受付を再開"}
              </button>
              <label className="btn small file-btn">
                サムネイルを変更
                <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => void replaceThumb(e.target.files?.[0] ?? null)} />
              </label>
            </>
          )}
          <span className="spacer" />
          <button type="button" className="btn small danger" onClick={() => setConfirm({ type: "video" })}>
            動画を削除
          </button>
        </div>
        {inspect && (
          <ul className={`inspect ${inspect.ok ? "ok" : "ng"}`}>
            {inspect.checks.map((c) => (
              <li key={c.name}>
                {c.ok ? "✔" : "✖"} {c.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      {editable && (
        <form
          className="card form-card"
          onSubmit={(e) => {
            e.preventDefault();
            void save(form, "動画の情報を保存しました。");
          }}
        >
          <h2 className="section-title">動画の情報</h2>
          <label className="field">
            <span className="label">タイトル</span>
            <input value={form.title} maxLength={LIMITS.titleMaxChars} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </label>
          <label className="field">
            <span className="label">説明文</span>
            <textarea rows={4} value={form.description} maxLength={LIMITS.descriptionMaxChars} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <label className="field">
            <span className="label">カテゴリ</span>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {[...new Set([form.category, ...config.categories])].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <div className="row">
            <span className="spacer" />
            <button type="submit" className="btn primary" disabled={busy}>
              保存
            </button>
          </div>
        </form>
      )}

      <section className="card" aria-labelledby="ac-title">
        <h2 id="ac-title" className="section-title">
          コメント管理 <span className="muted small">{total}件</span>
        </h2>
        {comments.length === 0 ? (
          <p className="muted">コメントはありません。</p>
        ) : (
          <ol className="history-list">
            {comments.map((c) => (
              <li key={c.id} className={`history-item ${c.hidden ? "is-hidden" : ""}`}>
                <span className="time-link static">{formatPlayback(c.playbackTimeSeconds)}</span>
                <div className="history-body">
                  {c.isCommentArt ? <pre className="history-art">{c.text}</pre> : <p className="history-text">{c.text}</p>}
                  <div className="history-meta">
                    <span className="dot" style={{ background: c.color }} />
                    <span>{displayNickname(c.nickname)}</span>
                    <span className="chip small">{MODE_LABELS[c.mode]}</span>
                    {c.hidden && <span className="chip small warn">非表示中</span>}
                    <time className="muted">{formatDateTime(c.createdAt)}</time>
                  </div>
                </div>
                <div className="actions">
                  <button type="button" className="btn small" onClick={() => void toggleHidden(c)}>
                    {c.hidden ? "再表示" : "非表示"}
                  </button>
                  <button type="button" className="btn small danger" onClick={() => setConfirm({ type: "comment", c })}>
                    削除
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
        {total > PAGE && (
          <nav className="pager" aria-label="コメントのページ">
            <button type="button" className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              新しい方へ
            </button>
            <span>
              {offset + 1}–{Math.min(total, offset + PAGE)} / {total}
            </span>
            <button type="button" className="btn small" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
              古い方へ
            </button>
          </nav>
        )}
      </section>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.type === "video" ? "動画を削除しますか？" : "コメントを削除しますか？"}
        message={
          confirm?.type === "video" ? (
            <p>動画ファイル、サムネイル、すべてのコメントを削除します。元に戻せません。</p>
          ) : (
            <p className="pre-wrap">「{confirm?.type === "comment" ? confirm.c.text : ""}」を削除します。元に戻せません。</p>
          )
        }
        confirmLabel="削除する"
        danger
        busy={busy}
        onConfirm={() => void onConfirm()}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}
