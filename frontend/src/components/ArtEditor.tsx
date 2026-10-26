// 文字職人モード：複数行のコメントアートを作成・プレビュー・投稿する
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { DEFAULT_DURATION, LIMITS } from "../../../shared/constants";
import { charLength, validateCommentInput, type ArtLine } from "../../../shared/validation";
import { ApiError } from "../api/client";
import { overflowWarnings, type EngineComment, type Measure } from "../comments/engine";
import { FONT_STACKS } from "../comments/render";
import { StyleControls, type CommentStyle } from "./StyleControls";

interface Props {
  measure: Measure;
  nickname: string;
  disabled: boolean;
  onPreviewChange: (c: EngineComment | null) => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}

const ART_DEFAULT: CommentStyle = {
  mode: "free",
  color: "#FFFFFF",
  fontSize: 20,
  fontFamily: "mono",
  xPercent: 50,
  yPercent: 50,
  durationSeconds: DEFAULT_DURATION.fixed + 2,
  opacity: 1,
  textAlign: "left",
  lineHeight: 1.1,
};

const SAMPLE = "　 ∧＿∧\n　（　´∀｀）＜ こんにちは\n　（　　　　）\n　｜ ｜　|\n　（_＿）＿）";

type LineStyle = { color?: string; fontSize?: number };

export function ArtEditor({ measure, nickname, disabled, onPreviewChange, onSubmit, onClose }: Props) {
  const [text, setText] = useState("");
  const [style, setStyle] = useState<CommentStyle>(ART_DEFAULT);
  const [lineStyles, setLineStyles] = useState<Record<number, LineStyle>>({});
  const [preview, setPreview] = useState(true);
  const [tabInsert, setTabInsert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const rawLines = useMemo(() => text.replace(/\r\n?/g, "\n").split("\n"), [text]);
  const artLines: ArtLine[] = useMemo(
    () =>
      rawLines.map((t, i) => {
        const l: ArtLine = { text: t };
        const s = lineStyles[i];
        if (s?.color) l.color = s.color;
        if (s?.fontSize) l.fontSize = s.fontSize;
        return l;
      }),
    [rawLines, lineStyles],
  );

  const engineComment: EngineComment = useMemo(
    () => ({ id: -1, text, playbackTimeSeconds: 0, isCommentArt: true, artLines, nickname, ...style }),
    [text, artLines, style, nickname],
  );

  const hasContent = text.trim().length > 0;
  useEffect(() => {
    onPreviewChange(preview && hasContent ? engineComment : null);
  }, [preview, hasContent, engineComment, onPreviewChange]);
  useEffect(() => () => onPreviewChange(null), [onPreviewChange]);

  const warnings = useMemo(() => (hasContent ? overflowWarnings(engineComment, measure) : []), [engineComment, measure, hasContent]);
  const longest = Math.max(0, ...rawLines.map((l) => charLength(l)));
  const total = rawLines.reduce((n, l) => n + charLength(l), 0);
  const limitErrors: string[] = [];
  if (rawLines.length > LIMITS.artMaxLines) limitErrors.push(`行数が上限（${LIMITS.artMaxLines}行）を超えています。`);
  if (longest > LIMITS.artMaxLineChars) limitErrors.push(`1行の文字数が上限（${LIMITS.artMaxLineChars}文字）を超えています。`);
  if (total > LIMITS.artMaxTotalChars) limitErrors.push(`合計文字数が上限（${LIMITS.artMaxTotalChars}文字）を超えています。`);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // 「Tabキーで字下げ」が有効なときだけタブ文字を入力する（無効時はフォーカス移動に使える）
    if (e.key === "Tab" && tabInsert && !e.shiftKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: s, selectionEnd: en } = el;
      const next = text.slice(0, s) + "\t" + text.slice(en);
      setText(next);
      requestAnimationFrame(() => el.setSelectionRange(s + 1, s + 1));
    }
    if (e.key === "Escape") setTabInsert(false);
  }

  async function submit() {
    if (busy || disabled) return;
    const body = { ...style, nickname, isCommentArt: true, artLines, playbackTimeSeconds: 0 };
    const check = validateCommentInput(body);
    if (!check.ok) {
      setResult({ ok: false, message: check.errors[0] });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      await onSubmit(body);
      setResult({ ok: true, message: "コメントアートを投稿しました。" });
    } catch (err) {
      setResult({ ok: false, message: err instanceof ApiError ? err.message : "投稿できませんでした。" });
    } finally {
      setBusy(false);
    }
  }

  const setLine = (i: number, s: LineStyle | null) =>
    setLineStyles((prev) => {
      const next = { ...prev };
      if (s === null) delete next[i];
      else next[i] = s;
      return next;
    });

  return (
    <section className="art-editor card" aria-labelledby="art-title">
      <div className="row">
        <h2 id="art-title" className="section-title">
          ✎ 文字職人モード
        </h2>
        <span className="spacer" />
        <button type="button" className="btn small ghost" onClick={onClose}>
          通常コメントに戻る
        </button>
      </div>
      <p className="muted small">
        空白・改行はそのまま表示されます。等幅フォントを使うと形が崩れにくくなります。HTMLは文字として表示されます。
      </p>

      <div className="art-grid">
        <div>
          <label className="field">
            <span className="label">
              コメントアート{" "}
              <span className={`counter ${limitErrors.length ? "over" : ""}`}>
                {rawLines.length}/{LIMITS.artMaxLines}行・最長{longest}/{LIMITS.artMaxLineChars}文字
              </span>
            </span>
            <textarea
              ref={textareaRef}
              className="art-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              rows={10}
              wrap="off"
              spellCheck={false}
              style={{ fontFamily: FONT_STACKS[style.fontFamily], color: style.color === "#000000" ? undefined : style.color }}
              placeholder={SAMPLE}
            />
          </label>
          <div className="row wrap">
            <label className="check">
              <input type="checkbox" checked={tabInsert} onChange={(e) => setTabInsert(e.target.checked)} />
              Tabキーで字下げ（Escで解除）
            </label>
            <label className="check">
              <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
              動画の上でプレビュー
            </label>
            <button type="button" className="btn small ghost" onClick={() => setText(SAMPLE)}>
              見本を入れる
            </button>
          </div>
          {warnings.length > 0 && (
            <ul className="warn-list" role="status">
              {warnings.map((w) => (
                <li key={w}>⚠ {w}</li>
              ))}
            </ul>
          )}
          {limitErrors.length > 0 && (
            <ul className="form-error" role="alert">
              {limitErrors.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <details className="line-styles">
            <summary>行ごとの色・サイズ</summary>
            <ol>
              {rawLines.slice(0, LIMITS.artMaxLines).map((l, i) => {
                const s = lineStyles[i];
                return (
                  <li key={i} className="line-style-row">
                    <span className="mono line-preview" title={l}>
                      {l || "（空行）"}
                    </span>
                    <input
                      type="color"
                      value={(s?.color ?? style.color).toLowerCase()}
                      onChange={(e) => setLine(i, { ...s, color: e.target.value.toUpperCase() })}
                      aria-label={`${i + 1}行目の色`}
                    />
                    <input
                      type="number"
                      className="num"
                      min={LIMITS.fontSizeMin}
                      max={LIMITS.fontSizeMax}
                      value={s?.fontSize ?? style.fontSize}
                      onChange={(e) => {
                        const n = Math.round(Number(e.target.value));
                        if (Number.isFinite(n)) setLine(i, { ...s, fontSize: Math.min(LIMITS.fontSizeMax, Math.max(LIMITS.fontSizeMin, n)) });
                      }}
                      aria-label={`${i + 1}行目の文字サイズ`}
                    />
                    {s && (
                      <button type="button" className="btn small ghost" onClick={() => setLine(i, null)}>
                        戻す
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          </details>
        </div>
        <div>
          <StyleControls value={style} onChange={setStyle} art />
        </div>
      </div>

      <div className="row">
        <p className={result ? (result.ok ? "form-success" : "form-error") : "sr-only"} role={result && !result.ok ? "alert" : "status"}>
          {result?.message ?? ""}
        </p>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={submit} disabled={disabled || busy || !hasContent || limitErrors.length > 0}>
          {busy ? "送信中…" : "今の再生位置に投稿"}
        </button>
      </div>
    </section>
  );
}
