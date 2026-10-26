import { useState, type FormEvent } from "react";
import { ApiError, verifyPassphrase } from "../api/client";
import type { Role } from "../api/session";
import { config } from "../config";

export function PassphrasePage({ role, notice }: { role: Role; notice?: string | null }) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = role === "admin";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!value) {
      setError("合言葉を入力してください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await verifyPassphrase(role, value);
      setValue("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "確認できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="gate" aria-labelledby="gate-title">
      <form className="card gate-card" onSubmit={submit} noValidate>
        <div className="gate-logo" aria-hidden="true">
          ▶
        </div>
        <h1 id="gate-title">{isAdmin ? "管理者ログイン" : config.siteName}</h1>
        <p className="muted">
          {isAdmin ? "管理者用の合言葉を入力してください。" : "学校から配布された閲覧用の合言葉を入力してください。"}
        </p>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <div className="field">
          <label className="label" htmlFor="passphrase-input">
            {isAdmin ? "管理者用の合言葉" : "合言葉"}
          </label>
          <div className="input-row">
            <input
              id="passphrase-input"
              type={show ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={256}
              aria-invalid={!!error}
              aria-describedby={error ? "gate-error" : undefined}
              autoFocus
            />
            <button type="button" className="btn ghost small" onClick={() => setShow((s) => !s)} aria-pressed={show} aria-label="合言葉を表示">
              {show ? "隠す" : "表示"}
            </button>
          </div>
        </div>
        {error && (
          <p id="gate-error" className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn primary block" disabled={busy}>
          {busy ? "確認中…" : "入る"}
        </button>
        <p className="fine-print">
          共通の合言葉による簡易的なアクセス制限です。合言葉を学校外の人に教えないでください。
        </p>
      </form>
    </section>
  );
}
