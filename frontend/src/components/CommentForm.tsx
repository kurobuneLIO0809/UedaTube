// 通常コメントの入力フォーム
import { useState, type FormEvent } from "react";
import { LIMITS } from "../../../shared/constants";
import { charLength, validateCommentInput } from "../../../shared/validation";
import { ApiError } from "../api/client";
import { DEFAULT_STYLE, StyleControls, type CommentStyle } from "./StyleControls";

export interface SubmitResult {
  ok: boolean;
  message: string;
}

interface Props {
  disabled: boolean;
  disabledReason?: string;
  nickname: string;
  onNicknameChange: (v: string) => void;
  /** 投稿処理。再生位置は送信時に video.currentTime から取得する */
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
  onOpenArt: () => void;
}

export function CommentForm({ disabled, disabledReason, nickname, onNicknameChange, onSubmit, onOpenArt }: Props) {
  const [text, setText] = useState("");
  const [style, setStyle] = useState<CommentStyle>(DEFAULT_STYLE);
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || disabled) return;
    const body = { ...style, text, nickname, isCommentArt: false, playbackTimeSeconds: 0 };
    const check = validateCommentInput(body);
    if (!check.ok) {
      setResult({ ok: false, message: check.errors[0] });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      await onSubmit(body);
      setText("");
      setResult({ ok: true, message: "コメントを投稿しました。" });
    } catch (err) {
      setResult({ ok: false, message: err instanceof ApiError ? err.message : "投稿できませんでした。" });
    } finally {
      setBusy(false);
    }
  }

  const len = charLength(text.trim());
  return (
    <form className="comment-form card" onSubmit={submit} aria-label="コメント投稿">
      {disabled && disabledReason && <p className="notice">{disabledReason}</p>}
      <div className="comment-input-row">
        <label className="field nickname">
          <span className="label">ニックネーム（任意）</span>
          <input value={nickname} onChange={(e) => onNicknameChange(e.target.value)} maxLength={LIMITS.nicknameMaxChars} placeholder="名無し" />
        </label>
        <label className="field grow">
          <span className="label">
            コメント <span className={`counter ${len > LIMITS.commentMaxChars ? "over" : ""}`}>{len}/{LIMITS.commentMaxChars}</span>
          </span>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="動画の今の場面にコメントする"
            disabled={disabled}
            enterKeyHint="send"
            aria-describedby="comment-result"
          />
        </label>
        <button type="submit" className="btn primary" disabled={disabled || busy || len === 0}>
          {busy ? "送信中…" : "投稿"}
        </button>
      </div>
      <div className="row wrap">
        <button type="button" className="btn small ghost" onClick={() => setPanelOpen((o) => !o)} aria-expanded={panelOpen} aria-controls="comment-style-panel">
          装飾 {panelOpen ? "▲" : "▼"}
        </button>
        <span className="style-summary" aria-label="現在の装飾">
          <span className="dot" style={{ background: style.color }} aria-hidden="true" /> {style.fontSize}px
        </span>
        <span className="spacer" />
        <button type="button" className="btn small accent" onClick={onOpenArt} disabled={disabled}>
          ✎ 文字職人モード
        </button>
      </div>
      {panelOpen && (
        <div id="comment-style-panel" className="style-panel">
          <StyleControls value={style} onChange={setStyle} />
        </div>
      )}
      <p id="comment-result" className={result ? (result.ok ? "form-success" : "form-error") : "sr-only"} role={result && !result.ok ? "alert" : "status"}>
        {result?.message ?? ""}
      </p>
    </form>
  );
}
