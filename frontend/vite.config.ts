/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

/**
 * 本番ビルドの index.html に Content-Security-Policy を追加する。
 * API のオリジン（公開設定値）だけに通信・動画読み込みを許可する。
 * 開発サーバーではViteが inline script を使うため適用しない。
 */
function cspPlugin(apiBase: string): Plugin {
  let origin = "http://localhost:8787";
  try {
    origin = new URL(apiBase).origin;
  } catch {
    // 既定値を使用
  }
  return {
    name: "school-nico-csp",
    apply: "build",
    transformIndexHtml: (html) => {
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        `img-src 'self' data: blob: ${origin}`,
        `media-src 'self' blob: ${origin}`,
        `connect-src 'self' ${origin}`,
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; ");
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  // GitHub Pages のプロジェクトURL（https://<user>.github.io/<repo>/）に対応するためのベースパス
  let base = env.VITE_BASE_PATH || "/";
  if (!base.startsWith("/")) base = `/${base}`;
  if (!base.endsWith("/")) base = `${base}/`;
  return {
    base,
    plugins: [react(), cspPlugin(env.VITE_API_BASE_URL || "http://localhost:8787")],
    server: { port: 5173, fs: { allow: [".."] } },
    build: { target: "es2022", sourcemap: false },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}", "../shared/**/*.test.ts"],
    },
  };
});
