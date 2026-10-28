// デプロイ時に wrangler.jsonc の D1 database_id と KV namespace id を設定するスクリプト（GitHub Actions 用）。
// 値は環境変数 D1_DATABASE_ID / KV_NAMESPACE_ID（GitHub Actions の Variables
// 「CLOUDFLARE_D1_DATABASE_ID」「CLOUDFLARE_KV_NAMESPACE_ID」）から受け取る。
// どちらも秘密情報ではないが、リポジトリのファイルは書き換えずに CI 上の作業コピーだけを変更する。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

const resources = [
  {
    label: "D1 の Database ID",
    variable: "CLOUDFLARE_D1_DATABASE_ID",
    env: "D1_DATABASE_ID",
    placeholder: "REPLACE_WITH_YOUR_D1_DATABASE_ID",
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    shape: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    where: "Cloudflare の D1 画面に表示される Database ID",
  },
  {
    label: "KV の Namespace ID",
    variable: "CLOUDFLARE_KV_NAMESPACE_ID",
    env: "KV_NAMESPACE_ID",
    placeholder: "REPLACE_WITH_YOUR_KV_NAMESPACE_ID",
    pattern: /^[0-9a-f]{32}$/i,
    shape: "0〜9 と a〜f の32文字",
    where: "Cloudflare の KV 画面に表示される Namespace ID",
  },
];

let text = readFileSync(configPath, "utf8");
let failed = false;
const done = [];
for (const r of resources) {
  const value = (process.env[r.env] ?? "").trim();
  if (!value) {
    console.error(`::error::${r.label}が未設定です。GitHub の Settings → Secrets and variables → Actions → Variables に ${r.variable} を登録してください。`);
    failed = true;
    continue;
  }
  if (!r.pattern.test(value)) {
    console.error(`::error::${r.variable} の形式が正しくありません（${r.shape}）。${r.where}をそのまま登録してください。`);
    failed = true;
    continue;
  }
  const count = text.split(`"${r.placeholder}"`).length - 1;
  if (count !== 1) {
    console.error(`::error::wrangler.jsonc に ${r.label}のプレースホルダーが ${count} 個あります（1個である必要があります）。`);
    failed = true;
    continue;
  }
  text = text.replace(`"${r.placeholder}"`, JSON.stringify(value.toLowerCase()));
  done.push(r.label);
}
if (failed) process.exit(1);
writeFileSync(configPath, text);
for (const label of done) console.log(`wrangler.jsonc に${label}を設定しました。`);
