// コメントの装飾（色・サイズ・フォント・位置・表示時間・不透明度）の入力部品
import { useId } from "react";
import {
  COLOR_PRESETS,
  DEFAULT_DURATION,
  FONT_FAMILIES,
  FONT_SIZE_PRESETS,
  LIMITS,
  TEXT_ALIGNS,
  type CommentMode,
  type FontFamilyKey,
  type TextAlign,
} from "../../../shared/constants";
import { FONT_LABELS } from "../comments/render";

export interface CommentStyle {
  mode: CommentMode;
  color: string;
  fontSize: number;
  fontFamily: FontFamilyKey;
  xPercent: number;
  yPercent: number;
  durationSeconds: number;
  opacity: number;
  textAlign: TextAlign;
  lineHeight: number;
}

export const DEFAULT_STYLE: CommentStyle = {
  mode: "scroll",
  color: "#FFFFFF",
  fontSize: FONT_SIZE_PRESETS.medium,
  fontFamily: "gothic",
  xPercent: 50,
  yPercent: 50,
  durationSeconds: DEFAULT_DURATION.scroll,
  opacity: 1,
  textAlign: "center",
  lineHeight: 1.2,
};

export const MODE_LABELS: Record<CommentMode, string> = {
  scroll: "流れる",
  top: "上に固定",
  bottom: "下に固定",
  center: "中央に固定",
  free: "位置を指定",
};

const ALIGN_LABELS: Record<TextAlign, string> = { left: "左揃え", center: "中央揃え", right: "右揃え" };

interface Props {
  value: CommentStyle;
  onChange: (v: CommentStyle) => void;
  /** 文字職人モードでは行間・文字配置も表示する */
  art?: boolean;
}

export function StyleControls({ value, onChange, art = false }: Props) {
  const id = useId();
  const set = <K extends keyof CommentStyle>(k: K, v: CommentStyle[K]) => onChange({ ...value, [k]: v });
  const setMode = (mode: CommentMode) => {
    // モードに応じて既定の表示時間に切り替える（利用者が変更済みの場合はそのまま）
    const wasDefault = value.durationSeconds === DEFAULT_DURATION.scroll || value.durationSeconds === DEFAULT_DURATION.fixed;
    const durationSeconds = wasDefault ? (mode === "scroll" ? DEFAULT_DURATION.scroll : DEFAULT_DURATION.fixed) : value.durationSeconds;
    onChange({ ...value, mode, durationSeconds });
  };

  return (
    <div className="style-controls">
      <fieldset className="field-group">
        <legend>表示モード</legend>
        <div className="segmented" role="radiogroup">
          {(Object.keys(MODE_LABELS) as CommentMode[]).map((m) => (
            <label key={m} className={`seg ${value.mode === m ? "on" : ""}`}>
              <input type="radio" name={`${id}-mode`} value={m} checked={value.mode === m} onChange={() => setMode(m)} />
              {MODE_LABELS[m]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="field-group">
        <legend>文字色</legend>
        <div className="swatches">
          {COLOR_PRESETS.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`swatch ${value.color.toUpperCase() === c.value ? "on" : ""}`}
              style={{ background: c.value }}
              onClick={() => set("color", c.value)}
              aria-label={c.name}
              aria-pressed={value.color.toUpperCase() === c.value}
              title={c.name}
            />
          ))}
          <label className="color-picker">
            <input type="color" value={value.color.toLowerCase()} onChange={(e) => set("color", e.target.value.toUpperCase())} aria-label="任意の色" />
            <span className="mono">{value.color.toUpperCase()}</span>
          </label>
        </div>
      </fieldset>

      <fieldset className="field-group">
        <legend>文字サイズ</legend>
        <div className="row wrap">
          {(
            [
              ["小", FONT_SIZE_PRESETS.small],
              ["標準", FONT_SIZE_PRESETS.medium],
              ["大", FONT_SIZE_PRESETS.large],
            ] as const
          ).map(([label, size]) => (
            <button key={size} type="button" className={`btn small ${value.fontSize === size ? "primary" : ""}`} onClick={() => set("fontSize", size)} aria-pressed={value.fontSize === size}>
              {label}
            </button>
          ))}
          <input
            type="range"
            min={LIMITS.fontSizeMin}
            max={LIMITS.fontSizeMax}
            step={1}
            value={value.fontSize}
            onChange={(e) => set("fontSize", Number(e.target.value))}
            aria-label="文字サイズ（スライダー）"
            className="grow"
          />
          <input
            type="number"
            min={LIMITS.fontSizeMin}
            max={LIMITS.fontSizeMax}
            value={value.fontSize}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n)) set("fontSize", Math.min(LIMITS.fontSizeMax, Math.max(LIMITS.fontSizeMin, n)));
            }}
            className="num"
            aria-label="文字サイズ（px）"
          />
        </div>
      </fieldset>

      <div className="row wrap">
        <label className="field">
          <span className="label">フォント</span>
          <select value={value.fontFamily} onChange={(e) => set("fontFamily", e.target.value as FontFamilyKey)}>
            {FONT_FAMILIES.map((f) => (
              <option key={f} value={f}>
                {FONT_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span className="label">表示時間 {value.durationSeconds.toFixed(1)}秒</span>
          <input type="range" min={LIMITS.durationMin} max={LIMITS.durationMax} step={0.5} value={value.durationSeconds} onChange={(e) => set("durationSeconds", Number(e.target.value))} />
        </label>
        <label className="field grow">
          <span className="label">不透明度 {Math.round(value.opacity * 100)}%</span>
          <input type="range" min={LIMITS.opacityMin} max={LIMITS.opacityMax} step={0.05} value={value.opacity} onChange={(e) => set("opacity", Number(e.target.value))} />
        </label>
      </div>

      {value.mode === "free" && (
        <div className="row wrap">
          <label className="field grow">
            <span className="label">横位置（X）{value.xPercent}%</span>
            <input type="range" min={0} max={100} step={0.5} value={value.xPercent} onChange={(e) => set("xPercent", Number(e.target.value))} />
          </label>
          <label className="field grow">
            <span className="label">縦位置（Y）{value.yPercent}%</span>
            <input type="range" min={0} max={100} step={0.5} value={value.yPercent} onChange={(e) => set("yPercent", Number(e.target.value))} />
          </label>
        </div>
      )}

      {art && (
        <div className="row wrap">
          <fieldset className="field-group">
            <legend>文字の配置</legend>
            <div className="segmented">
              {TEXT_ALIGNS.map((a) => (
                <label key={a} className={`seg ${value.textAlign === a ? "on" : ""}`}>
                  <input type="radio" name={`${id}-align`} value={a} checked={value.textAlign === a} onChange={() => set("textAlign", a)} />
                  {ALIGN_LABELS[a]}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field grow">
            <span className="label">行間 {value.lineHeight.toFixed(2)}</span>
            <input type="range" min={LIMITS.lineHeightMin} max={LIMITS.lineHeightMax} step={0.05} value={value.lineHeight} onChange={(e) => set("lineHeight", Number(e.target.value))} />
          </label>
        </div>
      )}
    </div>
  );
}
