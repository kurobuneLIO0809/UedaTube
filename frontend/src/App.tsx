import { useEffect, useState, useSyncExternalStore } from "react";
import { AUTH_EXPIRED_EVENT } from "./api/client";
import { clearToken, getToken, subscribe } from "./api/session";
import { ErrorPage, OfflineBanner } from "./components/Status";
import { config } from "./config";
import { AdminDashboardPage } from "./pages/AdminDashboardPage";
import { AdminVideoPage } from "./pages/AdminVideoPage";
import { PassphrasePage } from "./pages/PassphrasePage";
import { UploadPage } from "./pages/UploadPage";
import { VideoListPage } from "./pages/VideoListPage";
import { WatchPage } from "./pages/WatchPage";
import { href, useRoute } from "./router";

function useTokens() {
  // sessionStorage の変化（ログイン・期限切れ）を購読する
  const snapshot = () => `${getToken("viewer") ?? ""}|${getToken("admin") ?? ""}`;
  const key = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [viewer, admin] = key.split("|");
  return { viewer: viewer || null, admin: admin || null };
}

export function App() {
  const route = useRoute();
  const tokens = useTokens();
  const [notice, setNotice] = useState<string | null>(null);
  const isAdminRoute = route.name.startsWith("admin");

  useEffect(() => {
    const on = () => setNotice("セッションの有効期限が切れました。もう一度合言葉を入力してください。");
    window.addEventListener(AUTH_EXPIRED_EVENT, on);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, on);
  }, []);

  useEffect(() => {
    document.title = config.siteName;
  }, []);

  // 有効期限の監視（期限が来たら自動的に合言葉画面へ）
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const canView = !!(tokens.viewer || tokens.admin);
  let page;
  if (isAdminRoute) {
    if (!tokens.admin) page = <PassphrasePage role="admin" notice={notice} />;
    else if (route.name === "admin") page = <AdminDashboardPage />;
    else if (route.name === "adminUpload") page = <UploadPage />;
    else if (route.name === "adminVideo") page = <AdminVideoPage id={route.id} />;
  } else if (!canView) {
    page = <PassphrasePage role="viewer" notice={notice} />;
  } else if (route.name === "list") page = <VideoListPage />;
  else if (route.name === "watch") page = <WatchPage key={route.id} id={route.id} />;
  else page = <ErrorPage kind="notFound" message="お探しのページは見つかりませんでした。" />;

  return (
    <div className="app">
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>
        本文へ移動
      </a>
      <header className="site-header">
        <a className="brand" href={href("/")}>
          <span className="brand-mark" aria-hidden="true">
            ▶
          </span>
          {config.siteName}
        </a>
        <nav aria-label="メイン">
          {canView && <a href={href("/")}>動画一覧</a>}
          <a href={href("/admin")}>管理</a>
          {(tokens.viewer || tokens.admin) && (
            <button
              type="button"
              className="btn small ghost"
              onClick={() => {
                clearToken("viewer");
                clearToken("admin");
                setNotice(null);
              }}
            >
              退出
            </button>
          )}
        </nav>
      </header>
      <OfflineBanner />
      <main id="main" tabIndex={-1}>
        {page}
      </main>
      <footer className="site-footer">
        <p>
          {config.siteName} — 校内専用。動画は投稿から14日後に自動削除されます。共通の合言葉による簡易アクセス制限のため、合言葉は学校外に共有しないでください。
        </p>
      </footer>
    </div>
  );
}
