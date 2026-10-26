// 動画の上に重ねるコメント描画レイヤー（requestAnimationFrame + Canvas）
import { useEffect, useMemo, useRef } from "react";
import {
  STAGE_H,
  STAGE_W,
  estimateTime,
  getFrame,
  layoutComments,
  prepareBlock,
  scrollX,
  type EngineComment,
  type FrameItem,
  type Measure,
  type TimeSample,
} from "./engine";
import { drawFrame } from "./render";

interface Props {
  video: HTMLVideoElement | null;
  comments: EngineComment[];
  visible: boolean;
  opacity: number;
  measure: Measure;
  /** 文字職人モードのプレビュー（動画の時刻に関係なく表示し続ける） */
  preview?: EngineComment | null;
}

function isSmallScreen() {
  return typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)").matches;
}

export function CommentLayer({ video, comments, visible, opacity, measure, preview }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layout = useMemo(
    // スマートフォンでは描画負荷を抑えるため同時表示数を少なくする
    () => layoutComments(comments, { measure, maxOnScreen: isSmallScreen() ? 40 : 80 }),
    [comments, measure],
  );
  const previewBlock = useMemo(() => (preview ? prepareBlock(preview, measure) : null), [preview, measure]);

  // 最新の値を描画ループから参照する
  const state = useRef({ layout, opacity, preview, previewBlock });
  state.current = { layout, opacity, preview, previewBlock };
  const redrawRef = useRef<() => void>(() => undefined);
  const hasPreview = !!preview;

  useEffect(() => {
    redrawRef.current();
  }, [layout, opacity, preview, previewBlock]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 非表示のときは描画ループを止めて消去する
    if (!visible && !hasPreview) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      redrawRef.current = () => undefined;
      return;
    }

    let raf = 0;
    let sample: TimeSample | null = null;
    let lastKey = "";

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, isSmallScreen() ? 1.5 : 2);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        lastKey = "";
      }
    };

    const previewFrame = (): FrameItem[] => {
      const { preview: pv, previewBlock: pb } = state.current;
      if (!pv || !pb) return [];
      let scale = 1;
      if (pv.mode !== "free" && pv.mode !== "scroll") scale = Math.min(1, (STAGE_W * 0.98) / Math.max(1, pb.width), STAGE_H / Math.max(1, pb.height));
      const width = pb.width * scale;
      const height = pb.height * scale;
      const span = pv.durationSeconds;
      const start = 0;
      const placed = { comment: pv, lines: pb.lines, width, height, scale, start, end: span, x: 0, y: 0, delayed: false };
      let x = (STAGE_W - width) / 2;
      let y = (STAGE_H - height) / 2;
      if (pv.mode === "free") {
        x = (pv.xPercent / 100) * STAGE_W - width / 2;
        y = (pv.yPercent / 100) * STAGE_H - height / 2;
      } else if (pv.mode === "top") y = 0;
      else if (pv.mode === "bottom") y = STAGE_H - height;
      else if (pv.mode === "scroll") {
        y = Math.min(STAGE_H - height, 20);
        // プレビューのスクロールは実時間で繰り返し再生する
        x = scrollX(placed, (performance.now() / 1000) % span);
      }
      return [{ placed, x, y }];
    };

    const draw = () => {
      raf = 0;
      if (!video) return;
      resize();
      const playing = !video.paused && !video.seeking && !video.ended;
      const now = performance.now();
      if (!sample || sample.mediaTime !== video.currentTime) sample = { mediaTime: video.currentTime, wallTime: now };
      const t = estimateTime(sample, video.currentTime, now, playing, video.playbackRate);
      const key = `${t}|${canvas.width}|${canvas.height}`;
      const animatePreview = !!state.current.preview && state.current.preview.mode === "scroll";
      if (key !== lastKey || animatePreview) {
        const frame = visible ? getFrame(state.current.layout, t) : [];
        drawFrame(ctx, [...frame, ...previewFrame()], canvas.width, canvas.height, state.current.opacity);
        lastKey = key;
      }
      // 再生中（またはプレビューのアニメーション中）のみ次のフレームを要求する
      if (playing || animatePreview) raf = requestAnimationFrame(draw);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    redrawRef.current = () => {
      lastKey = "";
      schedule();
    };

    const events = ["play", "playing", "pause", "seeking", "seeked", "timeupdate", "ratechange", "loadeddata", "ended"];
    events.forEach((e) => video?.addEventListener(e, schedule));
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => redrawRef.current()) : null;
    ro?.observe(canvas);
    schedule();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      events.forEach((e) => video?.removeEventListener(e, schedule));
      ro?.disconnect();
      redrawRef.current = () => undefined;
    };
  }, [video, visible, hasPreview]);

  return <canvas ref={canvasRef} className="comment-layer" aria-hidden="true" />;
}
