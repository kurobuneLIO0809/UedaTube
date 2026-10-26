// デプロイ時に wrangler.jsonc の D1 database_id を設定するスクリプト（GitHub Actions 用）。
// 値は環境変数 D1_DATABASE_ID（GitHub Actions の Variables「CLOUDFLARE_D1_DATABASE_ID」）から受け取る。
// Database ID は秘密情報ではないが、リポジトリのファイルは書き換えずに CI 上の作業コピーだけを変更する。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = "REPLACE_WITH_YOUR_D1_DATABASE_ID";
const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const id = (process.env.D1_DATABASE_ID ?? "").trim();

if (!id) {
  console.error(
    "::error::D1 の Database ID が未設定です。GitHub の Settings → Secrets and variables → Actions → Variables に CLOUDFLARE_D1_DATABASE_ID を登録してください。",
  );
  process.exit(1);
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
  console.error(
    "::error::CLOUDFLARE_D1_DATABASE_ID の形式が正しくありません（xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx の形）。Cloudflare の D1 画面に表示される Database ID をそのまま登録してください。",
  );
  process.exit(1);
}

const text = readFileSync(configPath, "utf8");
const count = text.split(`"${PLACEHOLDER}"`).length - 1;
if (count !== 1) {
  console.error(`::error::wrangler.jsonc に database_id のプレースホルダーが ${count} 個あります（1個である必要があります）。`);
  process.exit(1);
}
writeFileSync(configPath, text.replace(`"${PLACEHOLDER}"`, JSON.stringify(id.toLowerCase())));
console.log("wrangler.jsonc に D1 の Database ID を設定しました。");
