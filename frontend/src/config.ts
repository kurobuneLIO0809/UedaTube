// サイト全体の設定。値はビルド時の環境変数（.env.local や GitHub Actions の Variables）から読み込みます。
// ここには秘密情報を置かないでください（ビルド結果に含まれ、誰でも閲覧できます）。

function list(v: string | undefined, fallback: string[]): string[] {
  const items = (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

export const config = {
  siteName: import.meta.env.VITE_SITE_NAME || "School NICO",
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL || "http://localhost:8787").replace(/\/+$/, ""),
  categories: list(import.meta.env.VITE_CATEGORIES, ["授業", "行事", "部活動", "お知らせ", "その他"]),
  /** 他の人のコメントを取り込む間隔 */
  commentPollMs: 10_000,
  /** コメント全件を取り直す間隔（管理者の削除・非表示を反映するため） */
  commentFullRefreshMs: 60_000,
  /** 履歴パネルの1ページあたりの件数 */
  historyPageSize: 50,
};
