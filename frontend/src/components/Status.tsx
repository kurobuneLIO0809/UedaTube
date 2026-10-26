import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { href } from "../router";

export function Loading({ label = "読み込み中…" }: { label?: string }) {
  return (
    <div className="status-view" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="status-view empty">
      <svg width="56" height="56" viewBox="0 0 24 24" aria-hidden="true" className="status-icon">
        <path fill="currentColor" d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm0 2v10h16V7H4Zm6 2 5 3-5 3V9Z" />
      </svg>
      <p className="status-title">{title}</p>
      {children}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof ApiError ? error.message : "予期しないエラーが発生しました。";
  return (
    <div className="status-view error" role="alert">
      <p className="status-title">読み込みに失敗しました</p>
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          再読み込み
        </button>
      )}
    </div>
  );
}

/** アクセス拒否・期限切れ・見つからない などの全画面エラー */
export function ErrorPage({ kind, message }: { kind: "denied" | "expired" | "notFound" | "error"; message?: string }) {
  const titles = {
    denied: "アクセスできません",
    expired: "公開期限が過ぎました",
    notFound: "ページが見つかりません",
    error: "エラーが発生しました",
  } as const;
  const defaults = {
    denied: "このページを表示する権限がありません。",
    expired: "この動画は投稿から14日が経過したため、視聴できなくなりました。",
    notFound: "動画が削除されたか、URLが間違っている可能性があります。",
    error: "時間をおいて再度お試しください。",
  } as const;
  return (
    <section className="error-page" aria-labelledby="error-title">
      <div className={`error-badge ${kind}`} aria-hidden="true">
        {kind === "expired" ? "⏱" : kind === "denied" ? "🔒" : kind === "notFound" ? "?" : "!"}
      </div>
      <h1 id="error-title">{titles[kind]}</h1>
      <p>{message ?? defaults[kind]}</p>
      <a className="btn primary" href={href("/")}>
        動画一覧へ戻る
      </a>
    </section>
  );
}

export function errorKind(err: unknown): "denied" | "expired" | "notFound" | "error" {
  if (err instanceof ApiError) {
    if (err.status === 410) return "expired";
    if (err.status === 404) return "notFound";
    if (err.status === 403) return "denied";
  }
  return "error";
}

/** 確認ダイアログ（削除操作などで使用） */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "実行する",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      // フォーカスをダイアログ内に閉じ込める
      if (e.key === "Tab" && dialogRef.current) {
        const items = dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled])");
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-msg" ref={dialogRef}>
        <h2 id="confirm-title">{title}</h2>
        <div id="confirm-msg" className="modal-body">
          {message}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} ref={cancelRef} disabled={busy}>
            キャンセル
          </button>
          <button type="button" className={`btn ${danger ? "danger" : "primary"}`} onClick={onConfirm} disabled={busy}>
            {busy ? "処理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function OfflineBanner() {
  const [offline, setOffline] = useState(typeof navigator !== "undefined" && navigator.onLine === false);
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  if (!offline) return null;
  return (
    <div className="offline-banner" role="alert">
      インターネットに接続されていません。接続が戻ると自動的に再開します。
    </div>
  );
}
