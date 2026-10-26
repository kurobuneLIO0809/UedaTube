// HTML5 video を使った視聴プレイヤー（独自コントロール + コメントオーバーレイ）
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CommentLayer } from "../comments/CommentLayer";
import type { EngineComment, Measure } from "../comments/engine";
import { formatTime } from "../util/format";

interface Props {
  src: string;
  poster?: string | null;
  comments: EngineComment[];
  measure: Measure;
  preview?: EngineComment | null;
  /** 視聴URLの期限切れなどで再生できなくなったときに新しいURLを取得する */
  onRefreshSource: () => Promise<string>;
  onVideoElement?: (v: HTMLVideoElement | null) => void;
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = window.localStorage.getItem(`snico.pref.${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function savePref(key: string, value: unknown) {
  try {
    window.localStorage.setItem(`snico.pref.${key}`, JSON.stringify(value));
  } catch {
    // 保存できなくても動作に影響しない
  }
}

export function VideoPlayer({ src, poster, comments, measure, preview, onRefreshSource, onVideoElement }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [currentSrc, setCurrentSrc] = useState(src);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(() => loadPref("volume", 1));
  const [muted, setMuted] = useState(() => loadPref("muted", false));
  const [rate, setRate] = useState(1);
  const [showComments, setShowComments] = useState(() => loadPref("showComments", true));
  const [commentOpacity, setCommentOpacity] = useState(() => loadPref("commentOpacity", 1));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [announce, setAnnounce] = useState("");
  const refreshing = useRef(false);
  const retries = useRef<number[]>([]);

  const videoRef = useCallback(
    (el: HTMLVideoElement | null) => {
      setVideo(el);
      onVideoElement?.(el);
    },
    [onVideoElement],
  );

  useEffect(() => setCurrentSrc(src), [src]);
  useEffect(() => savePref("volume", volume), [volume]);
  useEffect(() => savePref("muted", muted), [muted]);
  useEffect(() => savePref("showComments", showComments), [showComments]);
  useEffect(() => savePref("commentOpacity", commentOpacity), [commentOpacity]);

  useEffect(() => {
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
  }, [video, volume, muted]);

  useEffect(() => {
    if (video) video.playbackRate = rate;
  }, [video, rate]);

  // 視聴URLの期限切れ（または一時的な通信エラー）から復帰する
  const recover = useCallback(async () => {
    if (!video || refreshing.current) return;
    const now = Date.now();
    retries.current = retries.current.filter((t) => now - t < 60_000);
    if (retries.current.length >= 3) {
      setError("動画を再生できませんでした。ページを再読み込みしてください。");
      setLoading(false);
      return;
    }
    retries.current.push(now);
    refreshing.current = true;
    const resumeAt = video.currentTime;
    const wasPlaying = !video.paused;
    try {
      const url = await onRefreshSource();
      setCurrentSrc(url);
      const onMeta = () => {
        video.currentTime = resumeAt;
        if (wasPlaying) void video.play().catch(() => undefined);
        video.removeEventListener("loadedmetadata", onMeta);
      };
      video.addEventListener("loadedmetadata", onMeta);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "動画を再生できませんでした。");
      setLoading(false);
    } finally {
      refreshing.current = false;
    }
  }, [video, onRefreshSource]);

  useEffect(() => {
    if (!video) return;
    const onTime = () => setTime(video.currentTime);
    const onMeta = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setLoading(false);
    };
    const onProgress = () => {
      if (video.buffered.length) setBuffered(video.buffered.end(video.buffered.length - 1));
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onWaiting = () => setLoading(true);
    const onPlaying = () => {
      setLoading(false);
      setError(null);
    };
    const onCanPlay = () => setLoading(false);
    const onError = () => {
      const code = video.error?.code;
      // ネットワークエラー・読み込み不可（期限切れトークンによる401を含む）は再取得を試みる
      if (code === MediaError.MEDIA_ERR_NETWORK || code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) void recover();
      else {
        setError(code === MediaError.MEDIA_ERR_DECODE ? "動画をデコードできませんでした。" : "動画を再生できませんでした。");
        setLoading(false);
      }
    };
    const map: [string, () => void][] = [
      ["timeupdate", onTime],
      ["seeked", onTime],
      ["loadedmetadata", onMeta],
      ["durationchange", onMeta],
      ["progress", onProgress],
      ["play", onPlay],
      ["pause", onPause],
      ["ended", onPause],
      ["waiting", onWaiting],
      ["playing", onPlaying],
      ["canplay", onCanPlay],
      ["error", onError],
    ];
    map.forEach(([e, f]) => video.addEventListener(e, f));
    return () => map.forEach(([e, f]) => video.removeEventListener(e, f));
  }, [video, recover]);

  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  const togglePlay = useCallback(() => {
    if (!video) return;
    if (video.paused || video.ended) void video.play().catch(() => setError("再生を開始できませんでした。もう一度お試しください。"));
    else video.pause();
  }, [video]);

  const seekBy = useCallback(
    (delta: number) => {
      if (!video) return;
      const d = Number.isFinite(video.duration) ? video.duration : Infinity;
      video.currentTime = Math.max(0, Math.min(d, video.currentTime + delta));
      setTime(video.currentTime);
      setAnnounce(`${formatTime(video.currentTime)} に移動しました`);
    },
    [video],
  );

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (el.requestFullscreen) await el.requestFullscreen();
      else {
        // iPhone の Safari は要素の全画面表示に未対応のため、動画だけを全画面にする（コメントは表示されない）
        (video as HTMLVideoElement & { webkitEnterFullscreen?: () => void })?.webkitEnterFullscreen?.();
      }
    } catch {
      // 全画面にできない環境では何もしない
    }
  }, [video]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select")) return;
    const key = e.key.toLowerCase();
    const handled = (() => {
      switch (key) {
        case " ":
          if (target.closest("button")) return false;
          togglePlay();
          return true;
        case "k":
          togglePlay();
          return true;
        case "arrowleft":
        case "j":
          seekBy(-10);
          return true;
        case "arrowright":
        case "l":
          seekBy(10);
          return true;
        case "arrowup":
          setVolume((v: number) => Math.min(1, Math.round((v + 0.1) * 10) / 10));
          setMuted(false);
          return true;
        case "arrowdown":
          setVolume((v: number) => Math.max(0, Math.round((v - 0.1) * 10) / 10));
          return true;
        case "m":
          setMuted((m: boolean) => !m);
          return true;
        case "f":
          void toggleFullscreen();
          return true;
        case "c":
          setShowComments((s: boolean) => !s);
          return true;
        case "home":
          if (video) video.currentTime = 0;
          return true;
        default:
          return false;
      }
    })();
    if (handled) e.preventDefault();
  };

  const progressMax = duration || 0;

  return (
    <div
      className={`player ${fullscreen ? "is-fullscreen" : ""}`}
      ref={containerRef}
      onKeyDown={onKeyDown}
      tabIndex={-1}
      role="region"
      aria-label="動画プレイヤー（Kで再生/停止、J/Lで10秒移動、Cでコメント表示切替、Fで全画面）"
    >
      <div className="player-stage" onClick={togglePlay}>
        <video
          ref={videoRef}
          src={currentSrc}
          poster={poster ?? undefined}
          preload="metadata"
          playsInline
          controlsList="nodownload"
          onContextMenu={(e) => e.preventDefault()}
        />
        <CommentLayer video={video} comments={comments} visible={showComments} opacity={commentOpacity} measure={measure} preview={preview} />
        {loading && !error && (
          <div className="player-overlay" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span className="sr-only">読み込み中</span>
          </div>
        )}
        {error && (
          <div className="player-overlay error" role="alert" onClick={(e) => e.stopPropagation()}>
            <p>{error}</p>
            <button
              type="button"
              className="btn"
              onClick={() => {
                retries.current = [];
                setError(null);
                setLoading(true);
                void recover();
              }}
            >
              再試行
            </button>
          </div>
        )}
        {!playing && !loading && !error && (
          <div className="big-play" aria-hidden="true">
            ▶
          </div>
        )}
      </div>

      <div className="controls" onClick={(e) => e.stopPropagation()}>
        <div className="seek">
          <div className="seek-buffer" style={{ width: progressMax ? `${(buffered / progressMax) * 100}%` : 0 }} aria-hidden="true" />
          <input
            type="range"
            className="seek-range"
            min={0}
            max={progressMax || 0}
            step={0.1}
            value={Math.min(time, progressMax || 0)}
            onChange={(e) => {
              if (!video) return;
              video.currentTime = Number(e.target.value);
              setTime(video.currentTime);
            }}
            aria-label="再生位置"
            aria-valuetext={`${formatTime(time)} / ${formatTime(duration)}`}
            disabled={!progressMax}
          />
        </div>
        <div className="control-row">
          <button type="button" className="icon-btn" onClick={togglePlay} aria-label={playing ? "一時停止" : "再生"}>
            {playing ? "❚❚" : "▶"}
          </button>
          <button type="button" className="icon-btn" onClick={() => seekBy(-10)} aria-label="10秒戻す">
            ⟲10
          </button>
          <button type="button" className="icon-btn" onClick={() => seekBy(10)} aria-label="10秒進める">
            10⟳
          </button>
          <span className="time" aria-hidden="true">
            {formatTime(time)} / {formatTime(duration)}
          </span>
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={() => setMuted((m: boolean) => !m)} aria-label={muted ? "ミュート解除" : "ミュート"} aria-pressed={muted}>
            {muted || volume === 0 ? "🔇" : "🔊"}
          </button>
          <input
            type="range"
            className="volume"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => {
              setVolume(Number(e.target.value));
              setMuted(Number(e.target.value) === 0);
            }}
            aria-label="音量"
          />
          <button
            type="button"
            className={`icon-btn text ${showComments ? "on" : ""}`}
            onClick={() => setShowComments((s: boolean) => !s)}
            aria-pressed={showComments}
            aria-label="コメント表示"
          >
            コメ
          </button>
          <div className="settings-wrap">
            <button type="button" className="icon-btn" onClick={() => setSettingsOpen((o) => !o)} aria-expanded={settingsOpen} aria-label="プレイヤー設定">
              ⚙
            </button>
            {settingsOpen && (
              <div className="settings-panel" role="group" aria-label="プレイヤー設定">
                <label className="field">
                  <span className="label">再生速度</span>
                  <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
                    {RATES.map((r) => (
                      <option key={r} value={r}>
                        {r === 1 ? "標準" : `${r}倍`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="label">コメントの不透明度 {Math.round(commentOpacity * 100)}%</span>
                  <input type="range" min={0.1} max={1} step={0.05} value={commentOpacity} onChange={(e) => setCommentOpacity(Number(e.target.value))} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={showComments} onChange={(e) => setShowComments(e.target.checked)} />
                  コメントを表示する
                </label>
              </div>
            )}
          </div>
          <button type="button" className="icon-btn" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "全画面を終了" : "全画面表示"}>
            ⛶
          </button>
        </div>
      </div>
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}
