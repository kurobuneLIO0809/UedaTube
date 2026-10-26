import { useCallback, useEffect, useState } from "react";
import { listVideos } from "../api/client";
import type { Video } from "../api/types";
import { EmptyState, ErrorState, Loading } from "../components/Status";
import { href } from "../router";
import { formatDateTime, formatTime, remaining } from "../util/format";

export function VideoCard({ v }: { v: Video }) {
  const [imgError, setImgError] = useState(false);
  return (
    <li className="video-card">
      <a href={href(`/watch/${v.id}`)} className="video-card-link">
        <div className="thumb">
          {v.thumbnailUrl && !imgError ? (
            <img src={v.thumbnailUrl} alt="" loading="lazy" decoding="async" onError={() => setImgError(true)} />
          ) : (
            <div className="thumb-placeholder" aria-hidden="true">
              ▶
            </div>
          )}
          <span className="duration">{formatTime(v.durationSeconds)}</span>
        </div>
        <div className="video-card-body">
          <h2 className="video-title">{v.title}</h2>
          {v.description && <p className="video-desc">{v.description}</p>}
          <div className="chips">
            <span className="chip">{v.category}</span>
            <span className="chip">コメント {v.commentCount}</span>
          </div>
          <dl className="meta">
            <div>
              <dt>投稿</dt>
              <dd>{formatDateTime(v.uploadedAt)}</dd>
            </div>
            <div>
              <dt>削除予定</dt>
              <dd>
                {formatDateTime(v.expiresAt)} <span className="expiry">（{remaining(v.expiresAt)}）</span>
              </dd>
            </div>
          </dl>
        </div>
      </a>
    </li>
  );
}

export function VideoListPage() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<"new" | "old">("new");
  const [state, setState] = useState<{ loading: boolean; error: unknown; videos: Video[]; categories: string[] }>({
    loading: true,
    error: null,
    videos: [],
    categories: [],
  });
  const [reload, setReload] = useState(0);

  // 入力のたびにAPIを呼ばないよう少し待つ
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const ac = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    listVideos({ q: query, category, sort }, ac.signal)
      .then((r) => setState({ loading: false, error: null, videos: r.videos, categories: r.categories }))
      .catch((error) => {
        if (!ac.signal.aborted) setState((s) => ({ ...s, loading: false, error }));
      });
    return () => ac.abort();
  }, [query, category, sort, reload]);

  const retry = useCallback(() => setReload((n) => n + 1), []);

  return (
    <section aria-labelledby="list-title">
      <div className="page-head">
        <h1 id="list-title">動画一覧</h1>
        <p className="muted">動画は投稿から14日後に自動で削除されます。</p>
      </div>
      <form className="toolbar" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="field grow">
          <span className="label">タイトル検索</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="キーワード" maxLength={100} />
        </label>
        <label className="field">
          <span className="label">カテゴリ</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">すべて</option>
            {state.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">並び順</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as "new" | "old")}>
            <option value="new">新着順</option>
            <option value="old">古い順</option>
          </select>
        </label>
      </form>

      {state.loading && state.videos.length === 0 ? (
        <Loading label="動画を読み込み中…" />
      ) : state.error ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : state.videos.length === 0 ? (
        <EmptyState title={query || category ? "条件に合う動画がありません" : "公開中の動画はまだありません"}>
          {(query || category) && <p className="muted">検索条件を変えてお試しください。</p>}
        </EmptyState>
      ) : (
        <ul className="video-grid" aria-busy={state.loading}>
          {state.videos.map((v) => (
            <VideoCard key={v.id} v={v} />
          ))}
        </ul>
      )}
    </section>
  );
}
