import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVideo, postComment, refreshPlayback } from "../api/client";
import type { VideoDetail } from "../api/types";
import { ArtEditor } from "../components/ArtEditor";
import { CommentForm } from "../components/CommentForm";
import { CommentHistory } from "../components/CommentHistory";
import { ErrorPage, ErrorState, Loading, errorKind } from "../components/Status";
import { VideoPlayer } from "../components/VideoPlayer";
import type { EngineComment } from "../comments/engine";
import { createCanvasMeasure } from "../comments/render";
import { useComments } from "../comments/useComments";
import { formatDateTime, formatTime, remaining } from "../util/format";

function loadNickname(): string {
  try {
    return window.localStorage.getItem("snico.nickname") ?? "";
  } catch {
    return "";
  }
}

export function WatchPage({ id }: { id: string }) {
  const [video, setVideo] = useState<VideoDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [artOpen, setArtOpen] = useState(false);
  const [preview, setPreview] = useState<EngineComment | null>(null);
  const [nickname, setNickname] = useState(loadNickname);
  const videoEl = useRef<HTMLVideoElement | null>(null);
  const [fontsVersion, setFontsVersion] = useState(0);
  // フォントの読み込みが終わったら文字幅の計測をやり直す（キャッシュを捨てる）
  const measure = useMemo(() => {
    void fontsVersion;
    return createCanvasMeasure();
  }, [fontsVersion]);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    setVideo(null);
    getVideo(id, ac.signal)
      .then(setVideo)
      .catch((e) => !ac.signal.aborted && setError(e));
    return () => ac.abort();
  }, [id, reload]);

  // Webフォントの読み込み後に文字幅を測り直す
  useEffect(() => {
    document.fonts?.ready.then(() => setFontsVersion((v) => v + 1)).catch(() => undefined);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("snico.nickname", nickname);
    } catch {
      // 保存できなくても問題ない
    }
  }, [nickname]);

  const comments = useComments(video ? video.id : null, !!video);
  const engineComments: EngineComment[] = comments.comments;

  const onRefreshSource = useCallback(async () => (await refreshPlayback(id)).streamUrl, [id]);
  const onVideoElement = useCallback((el: HTMLVideoElement | null) => {
    videoEl.current = el;
  }, []);

  const submit = useCallback(
    async (body: Record<string, unknown>) => {
      // 投稿した瞬間の再生位置を記録する
      const t = videoEl.current?.currentTime ?? 0;
      const c = await postComment(id, { ...body, playbackTimeSeconds: Math.max(0, Math.round(t * 1000) / 1000) });
      comments.addLocal(c);
    },
    [id, comments],
  );

  const seek = useCallback((t: number) => {
    const v = videoEl.current;
    if (!v) return;
    v.currentTime = Math.max(0, t - 0.5);
    v.closest<HTMLElement>(".player")?.focus();
  }, []);

  if (error) {
    const kind = errorKind(error);
    if (kind === "error") return <ErrorState error={error} onRetry={() => setReload((n) => n + 1)} />;
    return <ErrorPage kind={kind} />;
  }
  if (!video) return <Loading label="動画を読み込み中…" />;

  return (
    <article className="watch">
      <div className="watch-main">
        <VideoPlayer
          src={video.streamUrl}
          poster={video.thumbnailUrl}
          comments={engineComments}
          measure={measure}
          preview={artOpen ? preview : null}
          onRefreshSource={onRefreshSource}
          onVideoElement={onVideoElement}
        />
        {artOpen ? (
          <ArtEditor
            measure={measure}
            nickname={nickname}
            disabled={!video.commentsEnabled}
            onPreviewChange={setPreview}
            onSubmit={submit}
            onClose={() => setArtOpen(false)}
          />
        ) : (
          <CommentForm
            disabled={!video.commentsEnabled}
            disabledReason="この動画は現在コメントの受付を停止しています。"
            nickname={nickname}
            onNicknameChange={setNickname}
            onSubmit={submit}
            onOpenArt={() => setArtOpen(true)}
          />
        )}
        <section className="video-info card" aria-labelledby="video-title">
          <h1 id="video-title">{video.title}</h1>
          <div className="chips">
            <span className="chip">{video.category}</span>
            <span className="chip">{formatTime(video.durationSeconds)}</span>
            {video.width && video.height && (
              <span className="chip">
                {video.width}×{video.height}
              </span>
            )}
            {video.status === "hidden" && <span className="chip warn">非公開（管理者のみ表示）</span>}
          </div>
          <dl className="meta">
            <div>
              <dt>投稿日時</dt>
              <dd>{formatDateTime(video.uploadedAt)}</dd>
            </div>
            <div>
              <dt>削除予定日時</dt>
              <dd>
                {formatDateTime(video.expiresAt)}（{remaining(video.expiresAt)}）
              </dd>
            </div>
          </dl>
          {video.description && <p className="description">{video.description}</p>}
        </section>
      </div>
      <aside className="watch-side">
        {comments.loading ? (
          <Loading label="コメントを読み込み中…" />
        ) : comments.error ? (
          <ErrorState error={comments.error} onRetry={comments.retry} />
        ) : (
          <>
            {comments.stale && (
              <p className="notice small" role="status">
                コメントの自動更新に失敗しました。接続が戻ると再開します。
              </p>
            )}
            <CommentHistory comments={comments.comments} total={comments.total} onSeek={seek} />
          </>
        )}
      </aside>
    </article>
  );
}
