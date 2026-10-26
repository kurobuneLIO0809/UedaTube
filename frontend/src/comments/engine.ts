// ニコニコ風コメントのレイアウトエンジン（DOMやCanvasに依存しない純粋な計算）
//
// ・すべての計算は仮想ステージ（854×480）の座標で行い、描画時に実際のプレイヤーサイズへ拡大縮小する。
//   そのため画面サイズが変わってもコメントの配置（とコメントアートの形）は変わらない。
// ・表示位置は「動画の再生位置 t（video.currentTime）」だけで決まる。
//   一時停止中は t が変わらないので動かず、シーク・再生速度変更にも自動的に追従する。
// ・コメントを (再生位置, ID) の順に処理する決定的なアルゴリズムなので、
//   同じコメント集合・同じ条件なら誰の画面でも同じ配置になる。
import { DEFAULT_NICKNAME, TAB_WIDTH, type CommentMode, type FontFamilyKey, type TextAlign } from "../../../shared/constants";
import type { ArtLine } from "../../../shared/validation";

export const STAGE_W = 854;
export const STAGE_H = 480;
/** 同じ段で前後のコメントとの間に空ける最小の距離（ステージ座標） */
const SCROLL_GAP = 8;
/** 配置できないときに表示開始を遅らせる幅と上限（秒） */
const DELAY_STEP = 0.3;
const MAX_DELAY = 0.9;

export interface EngineComment {
  id: number;
  text: string;
  playbackTimeSeconds: number;
  mode: CommentMode;
  color: string;
  fontSize: number;
  fontFamily: FontFamilyKey;
  xPercent: number;
  yPercent: number;
  durationSeconds: number;
  opacity: number;
  isCommentArt: boolean;
  artLines: ArtLine[] | null;
  textAlign: TextAlign;
  lineHeight: number;
  nickname?: string | null;
}

/** 文字列の幅を測る関数（ステージ座標の px を返す） */
export type Measure = (text: string, fontSize: number, fontFamily: FontFamilyKey) => number;

export interface PreparedLine {
  text: string;
  color: string;
  fontSize: number;
  width: number;
  /** ブロック上端からの位置 */
  offsetY: number;
  height: number;
}

export interface Block {
  lines: PreparedLine[];
  width: number;
  height: number;
}

export interface Placed {
  comment: EngineComment;
  lines: PreparedLine[];
  /** 拡大縮小後の幅・高さ */
  width: number;
  height: number;
  scale: number;
  /** 表示開始・終了（動画の再生位置、秒） */
  start: number;
  end: number;
  /** 固定表示の左上 x（scroll の場合は時間で決まる） */
  x: number;
  y: number;
  delayed: boolean;
}

export interface Layout {
  items: Placed[];
  dropped: number[];
  /** 最長の表示時間（フレーム計算の探索範囲に使う） */
  maxSpan: number;
}

export interface LayoutOptions {
  measure: Measure;
  /** 同時に表示する最大数（超えた分は間引く） */
  maxOnScreen?: number;
  width?: number;
  height?: number;
}

export interface FrameItem {
  placed: Placed;
  x: number;
  y: number;
}

/** タブを空白に展開する（列位置を考慮） */
export function expandTabs(s: string, tabWidth = TAB_WIDTH): string {
  if (!s.includes("\t")) return s;
  let out = "";
  let col = 0;
  for (const ch of s) {
    if (ch === "\t") {
      const n = tabWidth - (col % tabWidth);
      out += " ".repeat(n);
      col += n;
    } else {
      out += ch;
      col += 1;
    }
  }
  return out;
}

/** コメントを行に分割し、各行の大きさを求める */
export function prepareBlock(c: EngineComment, measure: Measure): Block {
  const sourceLines: ArtLine[] =
    c.isCommentArt && c.artLines && c.artLines.length > 0 ? c.artLines : c.text.split("\n").map((text) => ({ text }));
  let offsetY = 0;
  let width = 0;
  const lines = sourceLines.map((l) => {
    const text = expandTabs(l.text);
    const fontSize = l.fontSize ?? c.fontSize;
    const height = fontSize * c.lineHeight;
    const w = text.length === 0 ? 0 : measure(text, fontSize, c.fontFamily);
    const line: PreparedLine = { text, color: l.color ?? c.color, fontSize, width: w, offsetY, height };
    offsetY += height;
    width = Math.max(width, w);
    return line;
  });
  return { lines, width, height: offsetY };
}

/** スクロールコメントの時刻 t における左端の x 座標 */
export function scrollX(p: Pick<Placed, "start" | "end" | "width">, t: number, stageW = STAGE_W): number {
  return stageW - ((stageW + p.width) * (t - p.start)) / (p.end - p.start);
}

/**
 * 同じ段にある先行コメント a と、後から入ってくるコメント b が重なるか。
 * 位置は時間に対して一次関数なので、重なる時間帯の両端で間隔を調べれば十分。
 * ・b が右端から入る瞬間に a の末尾が画面に入りきっていること
 * ・a が画面から出ていく（または b が消える）までに b が a に追いつかないこと
 */
export function scrollCollides(a: Placed, b: Pick<Placed, "start" | "end" | "width">, stageW = STAGE_W): boolean {
  if (b.start >= a.end || a.start >= b.end) return false;
  const t1 = Math.max(a.start, b.start);
  const t2 = Math.min(a.end, b.end);
  const gap = (t: number) => {
    const first = a.start <= b.start ? a : b;
    const second = first === a ? b : a;
    return scrollX(second, t, stageW) - (scrollX(first, t, stageW) + first.width);
  };
  return gap(t1) < SCROLL_GAP || gap(t2) < SCROLL_GAP;
}

function overlapsY(a: { y: number; height: number }, y: number, h: number): boolean {
  return y < a.y + a.height && a.y < y + h;
}

function timeOverlaps(a: { start: number; end: number }, start: number, end: number): boolean {
  return start < a.end && a.start < end;
}

export function sortComments<T extends Pick<EngineComment, "playbackTimeSeconds" | "id">>(comments: T[]): T[] {
  return [...comments].sort((a, b) => a.playbackTimeSeconds - b.playbackTimeSeconds || a.id - b.id);
}

/** すべてのコメントの配置を決める */
export function layoutComments(comments: EngineComment[], opts: LayoutOptions): Layout {
  const W = opts.width ?? STAGE_W;
  const H = opts.height ?? STAGE_H;
  const maxOnScreen = opts.maxOnScreen ?? 80;
  const items: Placed[] = [];
  const dropped: number[] = [];
  // 現在表示中の可能性があるもの（モード別）
  const active: Record<CommentMode, Placed[]> = { scroll: [], top: [], bottom: [], center: [], free: [] };
  let maxSpan = 0;

  for (const c of sortComments(comments)) {
    const block = prepareBlock(c, opts.measure);
    if (block.width === 0 && block.height === 0) {
      dropped.push(c.id);
      continue;
    }

    // 大きすぎるものは縮小する（スクロールは縦のみ、free はコメントアートの形を保つため縮小しない）
    let scale = 1;
    if (c.mode === "scroll") {
      if (block.height > H) scale = H / block.height;
    } else if (c.mode !== "free") {
      scale = Math.min(1, (W * 0.98) / Math.max(1, block.width), H / Math.max(1, block.height));
    }
    const width = block.width * scale;
    const height = block.height * scale;

    // 表示が終わったものを整理（処理順に単調増加する元の再生位置を基準にする）
    for (const m of Object.keys(active) as CommentMode[]) {
      active[m] = active[m].filter((p) => p.end > c.playbackTimeSeconds);
    }

    let placed: Placed | null = null;
    for (let delay = 0; delay <= MAX_DELAY + 1e-9 && !placed; delay += DELAY_STEP) {
      const start = c.playbackTimeSeconds + delay;
      const end = start + c.durationSeconds;
      // 同時表示数の上限
      let onScreen = 0;
      for (const list of Object.values(active)) for (const p of list) if (p.start <= start && p.end > start) onScreen++;
      if (onScreen >= maxOnScreen) continue;

      const y = findY(c.mode, active, { start, end, width }, height, W, H, c.yPercent);
      if (y === null) continue;
      const x = c.mode === "free" ? (c.xPercent / 100) * W - width / 2 : (W - width) / 2;
      placed = { comment: c, lines: block.lines, width, height, scale, start, end, x, y, delayed: delay > 0 };
    }

    if (!placed) {
      dropped.push(c.id);
      continue;
    }
    active[c.mode].push(placed);
    items.push(placed);
    maxSpan = Math.max(maxSpan, placed.end - c.playbackTimeSeconds);
  }

  items.sort((a, b) => a.start - b.start || a.comment.id - b.comment.id);
  return { items, dropped, maxSpan };
}

function findY(
  mode: CommentMode,
  active: Record<CommentMode, Placed[]>,
  cand: { start: number; end: number; width: number },
  h: number,
  W: number,
  H: number,
  yPercent: number,
): number | null {
  if (mode === "free") return (yPercent / 100) * H - h / 2;

  if (mode === "scroll") {
    let y = 0;
    while (y + h <= H + 0.5) {
      const conflict = active.scroll.find((a) => overlapsY(a, y, h) && scrollCollides(a, cand, W));
      if (!conflict) return y;
      y = conflict.y + conflict.height;
    }
    return null;
  }

  const others = active[mode].filter((a) => timeOverlaps(a, cand.start, cand.end));
  if (mode === "top") {
    let y = 0;
    while (y + h <= H + 0.5) {
      const conflict = others.find((a) => overlapsY(a, y, h));
      if (!conflict) return y;
      y = conflict.y + conflict.height;
    }
    return null;
  }
  if (mode === "bottom") {
    let y = H - h;
    while (y >= -0.5) {
      const conflict = others.find((a) => overlapsY(a, y, h));
      if (!conflict) return y;
      y = conflict.y - h;
    }
    return null;
  }
  // center：中央から上下交互に空きを探す
  const center = (H - h) / 2;
  for (let k = 0; k < 2 * Math.ceil(H / Math.max(1, h)) + 1; k++) {
    const step = Math.ceil(k / 2) * (k % 2 === 1 ? 1 : -1);
    const y = center + step * h;
    if (y < -0.5 || y + h > H + 0.5) continue;
    if (!others.some((a) => overlapsY(a, y, h))) return y;
  }
  return null;
}

/** 二分探索：start <= t となる最後の要素の次の位置 */
function upperBound(items: Placed[], t: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  return hi;
}

/** 再生位置 t で表示するコメントとその座標 */
export function getFrame(layout: Layout, t: number, stageW = STAGE_W): FrameItem[] {
  const out: FrameItem[] = [];
  const hi = upperBound(layout.items, t);
  const minStart = t - layout.maxSpan - MAX_DELAY - 1;
  for (let i = hi - 1; i >= 0; i--) {
    const p = layout.items[i];
    if (p.start < minStart) break;
    if (t >= p.end || t < p.start) continue;
    const x = p.comment.mode === "scroll" ? scrollX(p, t, stageW) : p.x;
    // 画面外に出たものは描画しない
    if (x + p.width < 0 || x > stageW) continue;
    out.push({ placed: p, x, y: p.y });
  }
  return out.reverse();
}

/** 行内の文字配置に応じた x のずれ */
export function alignOffset(align: TextAlign, blockWidth: number, lineWidth: number): number {
  if (align === "center") return (blockWidth - lineWidth) / 2;
  if (align === "right") return blockWidth - lineWidth;
  return 0;
}

/** ブロックがステージからはみ出すかどうか（文字職人モードのプレビュー警告用） */
export function overflowWarnings(c: EngineComment, measure: Measure): string[] {
  const block = prepareBlock(c, measure);
  const warnings: string[] = [];
  if (c.mode === "free") {
    const left = (c.xPercent / 100) * STAGE_W - block.width / 2;
    const top = (c.yPercent / 100) * STAGE_H - block.height / 2;
    if (left < 0) warnings.push("左側が表示領域からはみ出しています。");
    if (left + block.width > STAGE_W) warnings.push("右側が表示領域からはみ出しています。");
    if (top < 0) warnings.push("上側が表示領域からはみ出しています。");
    if (top + block.height > STAGE_H) warnings.push("下側が表示領域からはみ出しています。");
  } else if (c.mode === "scroll") {
    if (block.height > STAGE_H) warnings.push("高さが表示領域を超えるため縮小して表示されます。");
  } else if (block.width > STAGE_W * 0.98 || block.height > STAGE_H) {
    warnings.push("表示領域に収まらないため縮小して表示されます。");
  }
  return warnings;
}

export function displayNickname(n: string | null | undefined): string {
  return n && n.trim() ? n : DEFAULT_NICKNAME;
}

/**
 * 再生中に video.currentTime の更新が粗いブラウザ向けに、前回の値から経過時間で補間する。
 * 一時停止中・シーク中は currentTime をそのまま使う（時間が進まない）。
 */
export interface TimeSample {
  mediaTime: number;
  wallTime: number;
}

export function estimateTime(sample: TimeSample | null, currentTime: number, nowMs: number, playing: boolean, rate: number): number {
  if (!playing || !sample || sample.mediaTime !== currentTime) return currentTime;
  const elapsed = ((nowMs - sample.wallTime) / 1000) * rate;
  // 補間は最大0.25秒まで（それ以上は currentTime の更新を待つ）
  return currentTime + Math.max(0, Math.min(0.25, elapsed));
}
