// Canvas へのコメント描画。fillText を使うため、コメントの内容がHTMLとして解釈されることはない。
import type { FontFamilyKey } from "../../../shared/constants";
import { STAGE_W, alignOffset, type FrameItem, type Measure } from "./engine";

/** 端末にフォントが無い場合に備えたフォールバック付きのフォント指定 */
export const FONT_STACKS: Record<FontFamilyKey, string> = {
  gothic: '"Hiragino Kaku Gothic ProN", "Hiragino Sans", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif',
  mincho: '"Hiragino Mincho ProN", "Noto Serif JP", "Noto Serif CJK JP", "Yu Mincho", "YuMincho", "MS PMincho", serif',
  mono: '"Noto Sans Mono CJK JP", "MS Gothic", "Osaka-Mono", "Source Han Code JP", ui-monospace, Menlo, Consolas, "Courier New", monospace',
};

export const FONT_LABELS: Record<FontFamilyKey, string> = { gothic: "ゴシック体", mincho: "明朝体", mono: "等幅フォント" };

export function cssFont(size: number, family: FontFamilyKey): string {
  return `bold ${size}px ${FONT_STACKS[family]}`;
}

/** Canvas が使えない環境（テストなど）向けの概算：全角1文字=1em、半角=0.55em */
export const approximateMeasure: Measure = (text, fontSize, family) => {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const full = code > 0xff && !(code >= 0xff61 && code <= 0xff9f);
    w += full ? 1 : family === "mono" ? 0.5 : 0.55;
  }
  return w * fontSize;
};

/** Canvas の measureText を使い、結果をキャッシュする */
export function createCanvasMeasure(): Measure {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return approximateMeasure;
  const cache = new Map<string, number>();
  return (text, fontSize, family) => {
    const key = `${family}|${fontSize}|${text}`;
    let w = cache.get(key);
    if (w === undefined) {
      ctx!.font = cssFont(fontSize, family);
      w = ctx!.measureText(text).width;
      if (cache.size > 20000) cache.clear();
      cache.set(key, w);
    }
    return w;
  };
}

function outlineColor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  // 暗い文字色には白、明るい文字色には黒の縁取り
  return 0.299 * r + 0.587 * g + 0.114 * b < 70 ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.8)";
}

/**
 * フレームを描画する。canvasWidth はデバイスピクセルでの幅。
 * ステージ座標（854×480）→ 実際の大きさへの倍率は canvasWidth / STAGE_W。
 */
export function drawFrame(ctx: CanvasRenderingContext2D, frame: FrameItem[], canvasWidth: number, canvasHeight: number, globalOpacity: number) {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  if (globalOpacity <= 0) return;
  const k = canvasWidth / STAGE_W;
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  for (const { placed: p, x, y } of frame) {
    const c = p.comment;
    ctx.globalAlpha = Math.max(0, Math.min(1, c.opacity * globalOpacity));
    for (const line of p.lines) {
      if (!line.text) continue;
      const size = line.fontSize * p.scale * k;
      ctx.font = cssFont(size, c.fontFamily);
      const lx = (x + alignOffset(c.textAlign, p.width, line.width * p.scale)) * k;
      // 行の高さの中で文字を縦中央に置く
      const ly = (y + line.offsetY * p.scale + (line.height - line.fontSize) * p.scale * 0.5) * k;
      ctx.lineWidth = Math.max(2, size * 0.14);
      ctx.strokeStyle = outlineColor(line.color);
      ctx.strokeText(line.text, lx, ly);
      ctx.fillStyle = line.color;
      ctx.fillText(line.text, lx, ly);
    }
  }
  ctx.globalAlpha = 1;
}
