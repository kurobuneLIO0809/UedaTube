import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // テスト専用の値。本番の合言葉・秘密鍵ではありません。
          bindings: {
            TEST_MIGRATIONS: migrations,
            VIEWER_PASSPHRASE: "test-viewer-passphrase",
            ADMIN_PASSPHRASE: "test-admin-passphrase",
            SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
            ALLOWED_ORIGINS: "https://example.github.io,http://localhost:5173",
            UPLOAD_PART_BYTES: String(5 * 1024 * 1024),
            MAX_UPLOAD_BYTES: String(64 * 1024 * 1024),
            KV_STORAGE_LIMIT_BYTES: String(512 * 1024 * 1024),
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
