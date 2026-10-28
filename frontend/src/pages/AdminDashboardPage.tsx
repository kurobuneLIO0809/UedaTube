import { useCallback, useEffect, useState } from "react";
import { ApiError, adminDeleteVideo, adminListVideos, adminRunCleanup, adminUpdateVideo, getDashboard } from "../api/client";
import type { AdminVideo, Dashboard } from "../api/types";
import { ConfirmDialog, EmptyState, ErrorState, Loading } from "../components/Status";
import { href } from "../router";
import { formatBytes, formatDateTime, remaining } from "../util/format";

export const STATUS_LABELS: Record<string, string> = {
  published: "公開中",
  hidden: "非公開",
  uploading: "アップロード中",
  failed: "失敗",
  deleting: "削除処理中",
  expired: "期限切れ（削除待ち）",
};

export function statusLabel(v: AdminVideo): string {
  return v.expired && (v.status === "published" || v.status === "hidden") ? STATUS_LABELS.expired : STATUS_LABELS[v.status];
}

function UsageBar({ label, used, limit, format }: { label: string; used: number; limit: number; format: (n: number) => string }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="usage">
      <div className="row">
        <span>{label}</span>
        <span className="spacer" />
        <span className={pct >= 90 ? "form-error small" : "muted small"}>
          {format(used)} / {format(limit)}（{pct}%）
        </span>
      </div>
      <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className={`progress-bar ${pct >= 90 ? "danger" : ""}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function AdminDashboardPage() {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [videos, setVideos] = useState<AdminVideo[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<AdminVideo | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, v] = await Promise.all([getDashboard(), adminListVideos()]);
      setDash(d);
      setVideos(v);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function togglePublish(v: AdminVideo) {
    try {
      await adminUpdateVideo(v.id, { status: v.status === "published" ? "hidden" : "published" });
      setMessage({ ok: true, text: `「${v.title}」を${v.status === "published" ? "非公開" : "公開"}にしました。` });
      await load();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError ? e.message : "変更できませんでした。" });
    }
  }

  async function doDelete() {
    if (!confirm) return;
    setBusy(true);
    try {
      await adminDeleteVideo(confirm.id);
      setMessage({ ok: true, text: `「${confirm.title}」を削除しました。` });
      setConfirm(null);
      await load();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError ? e.message : "削除できませんでした。" });
    } finally {
      setBusy(false);
    }
  }

  async function runCleanup() {
    setBusy(true);
    try {
      const { summary } = await adminRunCleanup();
      setMessage({
        ok: summary.failedVideos === 0,
        text: `自動削除を実行しました：削除 ${summary.deletedVideos}件、失敗 ${summary.failedVideos}件、孤立ファイル ${summary.orphanObjects}件`,
      });
      await load();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError ? e.message : "実行できませんでした。" });
    } finally {
      setBusy(false);
    }
  }

  if (error && !dash) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!dash || !videos) return <Loading label="管理情報を読み込み中…" />;

  const count = (k: string) => dash.videos[k] ?? 0;
  return (
    <section aria-labelledby="admin-title">
      <div className="page-head row wrap">
        <h1 id="admin-title">管理ダッシュボード</h1>
        <span className="spacer" />
        <a className="btn primary" href={href("/admin/upload")}>
          ＋ 動画をアップロード
        </a>
      </div>
      {message && (
        <p className={message.ok ? "form-success" : "form-error"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      )}

      <div className="stats">
        <div className="stat card">
          <span className="stat-num">{count("published")}</span>
          <span>公開中</span>
        </div>
        <div className="stat card">
          <span className="stat-num">{count("hidden")}</span>
          <span>非公開</span>
        </div>
        <div className="stat card">
          <span className="stat-num">{dash.comments.total}</span>
          <span>コメント（非表示 {dash.comments.hidden}）</span>
        </div>
        <div className="stat card">
          <span className="stat-num">{formatBytes(dash.kv.usedBytes)}</span>
          <span>動画の保存容量（上限 {formatBytes(dash.kv.limitBytes)}）</span>
        </div>
      </div>

      <section className="card" aria-labelledby="kv-title">
        <h2 id="kv-title" className="section-title">
          動画の保存領域（Cloudflare Workers KV・無料プラン）
        </h2>
        <UsageBar label="保存容量" used={dash.kv.usedBytes} limit={dash.kv.limitBytes} format={formatBytes} />
        <UsageBar label="今日の書き込み回数" used={dash.kv.opsToday.write} limit={dash.kv.opsLimits.write} format={(n) => `${n}回`} />
        <UsageBar label="今日の削除回数" used={dash.kv.opsToday.delete} limit={dash.kv.opsLimits.delete} format={(n) => `${n}回`} />
        <p className="muted small">
          無料プランの上限（合計1GB、1日あたり書き込み・削除 各1,000回）を超えないよう、手前で受け付けを止めます。上限を超えても料金は発生しません。
          回数は {formatDateTime(dash.kv.resetsAt)} に戻ります。今アップロードできる大きさ：最大 {formatBytes(dash.limits.availableBytes)}
        </p>
      </section>

      <div className="admin-grid">
        <section className="card" aria-labelledby="exp-title">
          <h2 id="exp-title" className="section-title">
            48時間以内に削除される動画
          </h2>
          {dash.expiringSoon.length === 0 ? (
            <p className="muted">ありません。</p>
          ) : (
            <ul className="simple-list">
              {dash.expiringSoon.map((v) => (
                <li key={v.id}>
                  <a href={href(`/admin/videos/${v.id}`)}>{v.title}</a> — {formatDateTime(v.expiresAt)}（{remaining(v.expiresAt)}）
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card" aria-labelledby="prob-title">
          <h2 id="prob-title" className="section-title">
            アップロード失敗・削除処理中
          </h2>
          {dash.problems.length === 0 ? (
            <p className="muted">問題はありません。</p>
          ) : (
            <ul className="simple-list">
              {dash.problems.map((p) => (
                <li key={p.id}>
                  <strong>{p.title}</strong> <span className="chip small warn">{STATUS_LABELS[p.status]}</span>
                  <div className="muted small">
                    {p.failureReason ?? p.lastDeleteError ?? "完了していないアップロード"}
                    {p.deleteAttempts > 0 && `（削除の試行 ${p.deleteAttempts}回）`}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">失敗・放置されたアップロードは24時間後に自動で削除されます。</p>
        </section>
        <section className="card" aria-labelledby="cron-title">
          <h2 id="cron-title" className="section-title">
            自動削除の実行記録
          </h2>
          {dash.cleanupRuns.length === 0 ? (
            <p className="muted">まだ実行されていません（Cron Triggerの設定を確認してください）。</p>
          ) : (
            <ul className="simple-list small">
              {dash.cleanupRuns.slice(0, 5).map((r) => (
                <li key={r.id}>
                  {formatDateTime(r.ranAt)} — 削除 {r.deletedVideos} / 失敗 {r.failedVideos} / 孤立 {r.orphanObjects}
                  {r.errors.length > 0 && <div className="form-error small">{r.errors.join(" / ")}</div>}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn small" onClick={() => void runCleanup()} disabled={busy}>
            今すぐ自動削除を実行
          </button>
        </section>
      </div>

      <section className="card" aria-labelledby="videos-title">
        <h2 id="videos-title" className="section-title">
          動画の管理
        </h2>
        {videos.length === 0 ? (
          <EmptyState title="動画はまだありません">
            <a className="btn primary" href={href("/admin/upload")}>
              動画をアップロード
            </a>
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">タイトル</th>
                  <th scope="col">状態</th>
                  <th scope="col">投稿日時</th>
                  <th scope="col">削除予定日時</th>
                  <th scope="col">コメント</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {videos.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <a href={href(`/admin/videos/${v.id}`)}>{v.title}</a>
                      <div className="muted small">{v.category}</div>
                    </td>
                    <td>
                      <span className={`chip small ${v.status === "published" && !v.expired ? "ok" : "warn"}`}>{statusLabel(v)}</span>
                    </td>
                    <td>{formatDateTime(v.uploadedAt ?? v.createdAt)}</td>
                    <td>
                      {formatDateTime(v.expiresAt)}
                      {v.expiresAt && <div className="muted small">{remaining(v.expiresAt)}</div>}
                    </td>
                    <td>{v.commentCount}</td>
                    <td>
                      <div className="actions">
                        {(v.status === "published" || v.status === "hidden") && !v.expired && (
                          <button type="button" className="btn small" onClick={() => void togglePublish(v)}>
                            {v.status === "published" ? "非公開にする" : "公開する"}
                          </button>
                        )}
                        <button type="button" className="btn small danger" onClick={() => setConfirm(v)}>
                          削除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={!!confirm}
        title="動画を削除しますか？"
        message={
          <p>
            「{confirm?.title}」の動画ファイル、サムネイル、コメント（{confirm?.commentCount}件）をすべて削除します。元に戻すことはできません。
          </p>
        }
        confirmLabel="削除する"
        danger
        busy={busy}
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}
