// コメント履歴パネル（クリックでその位置へシーク、並べ替え、ページ送り）
import { useMemo, useState } from "react";
import type { Comment } from "../api/types";
import { config } from "../config";
import { displayNickname } from "../comments/engine";
import { formatDateTime, formatPlayback } from "../util/format";
import { MODE_LABELS } from "./StyleControls";

type Sort = "new" | "old" | "time";

export function CommentHistory({ comments, onSeek, total }: { comments: Comment[]; onSeek: (t: number) => void; total: number }) {
  const [sort, setSort] = useState<Sort>("new");
  const [page, setPage] = useState(0);
  const sorted = useMemo(() => {
    const list = [...comments];
    if (sort === "new") list.sort((a, b) => b.id - a.id);
    else if (sort === "old") list.sort((a, b) => a.id - b.id);
    else list.sort((a, b) => a.playbackTimeSeconds - b.playbackTimeSeconds || a.id - b.id);
    return list;
  }, [comments, sort]);
  const size = config.historyPageSize;
  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const current = Math.min(page, pages - 1);
  // 大量のコメントでも一度に描画するのは1ページ分だけ
  const visible = sorted.slice(current * size, current * size + size);

  return (
    <section className="history card" aria-labelledby="history-title">
      <div className="row">
        <h2 id="history-title" className="section-title">
          コメント履歴 <span className="muted small">{total}件</span>
        </h2>
        <span className="spacer" />
        <label className="field inline">
          <span className="sr-only">並び順</span>
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as Sort);
              setPage(0);
            }}
          >
            <option value="new">新しい順</option>
            <option value="old">古い順</option>
            <option value="time">再生時間順</option>
          </select>
        </label>
      </div>
      {comments.length === 0 ? (
        <p className="muted history-empty">まだコメントはありません。最初のコメントを投稿してみましょう。</p>
      ) : (
        <ol className="history-list">
          {visible.map((c) => (
            <li key={c.id} className="history-item">
              <button type="button" className="time-link" onClick={() => onSeek(c.playbackTimeSeconds)} aria-label={`${formatPlayback(c.playbackTimeSeconds)} へ移動`}>
                {formatPlayback(c.playbackTimeSeconds)}
              </button>
              <div className="history-body">
                {c.isCommentArt ? (
                  <pre className="history-art">{c.text}</pre>
                ) : (
                  <p className="history-text">{c.text}</p>
                )}
                <div className="history-meta">
                  <span className="dot" style={{ background: c.color }} title={c.color} aria-label={`色 ${c.color}`} />
                  <span>{displayNickname(c.nickname)}</span>
                  <span className="chip small">{c.isCommentArt ? "文字職人" : ""}{c.isCommentArt ? "・" : ""}{MODE_LABELS[c.mode]}</span>
                  <time dateTime={c.createdAt} className="muted">
                    {formatDateTime(c.createdAt)}
                  </time>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {pages > 1 && (
        <nav className="pager" aria-label="コメント履歴のページ">
          <button type="button" className="btn small" onClick={() => setPage(current - 1)} disabled={current === 0}>
            前へ
          </button>
          <span>
            {current + 1} / {pages}
          </span>
          <button type="button" className="btn small" onClick={() => setPage(current + 1)} disabled={current >= pages - 1}>
            次へ
          </button>
        </nav>
      )}
    </section>
  );
}
