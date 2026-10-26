# School NICO（学校専用 ニコニコ風動画共有サイト）

学校の生徒・先生が、動画の再生位置に合わせてコメントを流しながら視聴できる動画共有サイトです。

- 動画の視聴とコメント投稿：共通の **閲覧用合言葉** を入力した人
- 動画のアップロード・削除・管理：別の **管理者用合言葉** を入力した人
- 動画は **アップロード完了から14日後に自動で削除** されます（動画ファイル・サムネイル・コメント・メタデータをすべて削除）
- 保存される動画は **MP4（H.264 + AAC）、1280×720（縦長は720×1280）以下**。1080p・HEVC・MOV・WebM などは、アップロード前に管理者のブラウザ内で **自動的に720p以下へ変換** します
- 右から左へ流れるコメント、上・下・中央・座標指定の固定コメント、色・サイズ・フォント指定
- 改行・空白をそのまま使える **文字職人モード（コメントアート）**

公開先は GitHub Pages（画面）と Cloudflare の無料枠（Workers・D1・R2）で、初期費用0円を目標にしています。

> [!IMPORTANT]
> **このサイトのアクセス制限は「共有合言葉による簡易アクセス制御」です。利用者個人の本人確認ではありません。**
> 合言葉を知っている人は誰でも閲覧できます。合言葉が学校外に漏れた場合は、すぐに合言葉と `SESSION_SECRET` を変更してください（[15. 合言葉の変更方法](#15-合言葉の変更方法)）。
> 個人情報や外部に出してはいけない映像は扱わないでください。

---

## 目次

- [構成](#構成)
- [セキュリティの仕組み](#セキュリティの仕組み)
- [動画の自動変換（720p）](#動画の自動変換720p)
- [1. 必要なアカウント](#1-必要なアカウント)
- [2. Node.js と npm の準備](#2-nodejs-と-npm-の準備)
- [3. ローカル開発環境の起動](#3-ローカル開発環境の起動)
- [4. テスト・ビルド方法](#4-テストビルド方法)
- [5. Cloudflare アカウントの準備](#5-cloudflare-アカウントの準備)
- [6. R2 バケットの作成](#6-r2-バケットの作成)
- [7. D1 データベースの作成](#7-d1-データベースの作成)
- [8. Worker のデプロイ（GitHub Actions）](#8-worker-のデプロイgithub-actions)
- [9. Workers Secrets の設定](#9-workers-secrets-の設定)
- [10. Cron Trigger の設定と動作確認](#10-cron-trigger-の設定と動作確認)
- [11. GitHub リポジトリの設定](#11-github-リポジトリの設定)
- [12. GitHub Actions による GitHub Pages の公開](#12-github-actions-による-github-pages-の公開)
- [13. API 接続先の設定](#13-api-接続先の設定)
- [14. 動作確認手順](#14-動作確認手順)
- [15. 合言葉の変更方法](#15-合言葉の変更方法)
- [16. 動画とコメントの自動削除を確認する方法](#16-動画とコメントの自動削除を確認する方法)
- [17. 無料枠と料金発生条件](#17-無料枠と料金発生条件)
- [18. バックアップと障害発生時の対応](#18-バックアップと障害発生時の対応)
- [API 一覧](#api-一覧)
- [データベース](#データベース)
- [設定値の一覧](#設定値の一覧)
- [制限事項・今後の課題](#制限事項今後の課題)

---

## 構成

```
ブラウザ ──(HTTPS)──► GitHub Pages（画面：Vite + React + TypeScript）
   │
   └──(HTTPS / Authorization: Bearer トークン)──► Cloudflare Workers（API・認証・動画配信・自動削除）
                                                      ├─ D1：動画情報・コメント・管理用データ
                                                      ├─ R2：動画ファイル・サムネイル（非公開）
                                                      └─ Cron Trigger：5分ごとに期限切れデータを削除
```

| フォルダー | 内容 |
| --- | --- |
| `frontend/` | 画面（GitHub Pages に公開）。React、HTML5 video、Canvas によるコメント描画 |
| `worker/` | API（Cloudflare Workers）。`src/` がプログラム、`migrations/` が D1 のテーブル定義、`test/` がテスト |
| `shared/` | 画面と API の両方で使う共通処理（入力検証、MP4 解析、定数） |
| `.github/workflows/` | CI（テスト）、GitHub Pages 公開、（任意）Worker デプロイ |

動画ファイルは GitHub リポジトリには保存しません（`.gitignore` で `*.mp4` などを除外しています）。

## セキュリティの仕組み

- 合言葉の確認は必ず Worker（サーバー側）で行います。合言葉はハッシュ化して定数時間で比較します。
- 合言葉が正しいと、有効期限付きの **署名済みトークン**（HMAC-SHA256）を発行します。ブラウザは `sessionStorage` にトークンだけを保存し、**合言葉そのものは保存しません**。タブを閉じると消えます。
- 閲覧用トークン（初期値8時間）と管理者用トークン（初期値2時間）は別物です。管理者用 API はすべてサーバー側で管理者トークンかを確認し、閲覧用トークンでは **403** で拒否します（画面のボタンを隠すだけの実装ではありません）。
- 合言葉を続けて間違えると一時的に制限します（閲覧用：10分間に10回、管理者用：15分間に5回）。
- 動画は R2 の **非公開オブジェクト** です。公開 URL は作りません。動画の URL は「その動画だけに使える、15分で切れる署名付き URL」です。期限が切れると画面が自動で取り直します。
- 動画配信・一覧・詳細・コメントのすべての API で、毎回 D1 の `expiresAt` を確認します。**R2 にファイルが残っていても、期限を過ぎた動画は管理者でも再生できません**（Cron が止まっていても有効）。
- API の応答は `Cache-Control: no-store`、動画は `private, no-store` で、キャッシュから期限切れ動画が見られないようにしています。
- CORS は `ALLOWED_ORIGINS` に書いたサイトだけに許可します。CORS は認証の代わりではなく、認証は必ずトークンで行います。
- コメントは React のテキスト表示と Canvas の `fillText` で描画するため、HTML や JavaScript は実行されません。色はサーバー側で `#RRGGBB` 形式のみ受け付けます。
- 連続投稿（同じブラウザから2秒以内・30秒に6回超、同じIPアドレス全体で30秒に120回超）、同一内容の連投、巨大なリクエスト（16KB超）、不正な色・サイズ・位置・表示時間を拒否します。IP アドレスやトークンは秘密鍵付きハッシュでのみ扱い、生の値は保存しません。

## 動画の自動変換（720p）

1080p の動画、スマートフォンの HEVC（H.265）動画、MOV・WebM などをアップロードしようとすると、**アップロード前に管理者のブラウザ内で自動的に変換** します。

| 項目 | 内容 |
| --- | --- |
| 変換後の形式 | MP4（映像 H.264 / 音声 AAC 128kbps / 先頭に再生情報を配置） |
| 変換後の解像度 | 横長は最大 1280×720、縦長は最大 720×1280。**元の縦横比を維持** し、小さい動画は拡大しません。スマートフォンの回転情報も反映します |
| 変換する条件 | 720p を超える／H.264 以外の映像／AAC 以外の音声／MP4 以外の形式／保存できる大きさを超える。条件を満たす動画も、任意で「再エンコードする」を選べます |
| 変換の場所 | 管理者のブラウザ（FFmpeg の WebAssembly 版）。サーバーの費用はかかりません |
| 元の動画 | **アップロードしません。** ブラウザ内で読み込むだけで、変換後に作業ファイルを削除し、変換プログラムを終了してメモリを解放します |
| 変換中の表示 | 進み具合（%）と経過時間を表示し、キャンセルできます。変換後は確認画面で **実際に再生して確認** してからアップロードします |
| 失敗したとき | 理由を表示し、何もアップロード・公開しません。「もう一度変換する」「入力に戻る」を選べます |
| 上限 | 変換元 1GB まで・30分までの動画・処理時間2時間まで・同時に1件。サーバー側でも同時に進行できるアップロードを3件までに制限 |

**サーバーが保証すること**：ブラウザの変換結果は信用せず、Worker が R2 に保存されたファイルそのものを解析し、720p 以下・H.264・AAC（または音声なし）の MP4 でなければ保存せず、公開もしません。ブラウザ側を改造して 1080p のファイルを送っても保存されません。

**サーバー側で変換しない理由**（2026年10月時点で調べた結果。最新情報は公式ページで確認してください）：

| 方式 | 結果 |
| --- | --- |
| Cloudflare Workers だけで変換 | 1回あたりの CPU 時間・メモリの上限があり、FFmpeg のような重い変換は動かせません |
| Cloudflare Stream | 動画の保存・配信の分数に応じた有料サービスで、無料枠では使えません |
| Cloudflare Media Transformations | 入力は100MBまで、出力は最長60秒までのため、授業動画全体の変換には使えません |
| Cloudflare Containers | Workers の有料プラン（月額5ドル〜）が必要です |
| GitHub Actions で変換 | 公開リポジトリなら無料で動きますが、GitHub の利用規約上、サービス本体の処理に Actions を使うことは認められていない可能性が高いため採用していません |

将来、費用をかけてサーバー側で変換したい場合は、Cloudflare Containers や Stream を有効にする前に、料金と支払い方法を確認してください（このリポジトリが勝手に有料サービスを有効にすることはありません）。

**変換の速さの目安**：パソコンの性能によりますが、1080p の動画で「動画の長さの数倍」かかることがあります。長い動画は、パソコンの動画編集ソフトや HandBrake で 720p・H.264 に書き出してからアップロードすると早く済みます（その場合は変換されずにそのままアップロードされます）。

**ライセンス**：変換に使う `@ffmpeg/core`（FFmpeg・x264 を含む）は GPL-2.0-or-later です。改変せずにサイトと一緒に配布し、公開サイトの `ffmpeg/LICENSE.txt` に入手元を記載しています。

---

## 1. 必要なアカウント

| アカウント | 用途 | 費用 |
| --- | --- | --- |
| [GitHub](https://github.com/) | ソースコードの保管、GitHub Actions によるデプロイ、GitHub Pages での画面の公開 | 無料（公開リポジトリ） |
| [Cloudflare](https://dash.cloudflare.com/sign-up) | Workers（API）、D1（データベース）、R2（動画保存） | 無料枠あり（R2 の有効化には支払い方法の登録が求められる場合があります） |

> GitHub Pages を **非公開リポジトリ** で使うには GitHub の有料プランが必要です。無料プランでは **公開リポジトリ** を使います。ソースコードは公開されますが、合言葉や秘密鍵はリポジトリに含まれないため問題ありません。

## 2. Node.js と npm の準備

> ブラウザだけで作業する（デプロイを GitHub Actions に任せる）場合、この章と3章・4章は不要です。[5章](#5-cloudflare-アカウントの準備) へ進んでください。

1. <https://nodejs.org/ja> から **Node.js 22（LTS）** をインストールします（20 以上で動作します）。
2. ターミナル（Windows は「PowerShell」、Mac は「ターミナル」）を開き、次を実行してバージョンが表示されることを確認します。

   ```bash
   node -v
   npm -v
   ```

3. このリポジトリをダウンロード（`git clone` または GitHub の「Code → Download ZIP」）し、フォルダーに移動して依存関係をインストールします。

   ```bash
   cd UedaTube
   npm run install:all
   ```

## 3. ローカル開発環境の起動

自分のパソコンだけで動作を試せます（Cloudflare アカウントは不要です。D1 と R2 はパソコン内に模擬環境が作られます）。

1. ローカル用の秘密情報ファイルを作ります。

   ```bash
   cp worker/.dev.vars.example worker/.dev.vars
   ```

   `worker/.dev.vars` をテキストエディターで開き、値を自分で決めて書き込みます（このファイルは GitHub にコミットされません）。

   ```
   VIEWER_PASSPHRASE=試験用の閲覧合言葉
   ADMIN_PASSPHRASE=試験用の管理者合言葉
   SESSION_SECRET=32文字以上のランダムな文字列
   ```

   見本ファイルには `ALLOWED_ORIGINS=http://localhost:5173` も入っています。ローカルの画面から API を呼ぶために必要なので、そのまま残してください（本番の値は `wrangler.jsonc` にあります）。

   ランダムな文字列は次のコマンドで作れます。

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

2. ローカルのデータベースにテーブルを作ります。

   ```bash
   npm run db:migrate:local
   ```

3. ターミナルを2つ開き、それぞれで起動します。

   ```bash
   # 1つ目：API（http://localhost:8787）
   npm run dev:api

   # 2つ目：画面（http://localhost:5173）
   npm run dev:web
   ```

4. ブラウザで <http://localhost:5173> を開き、閲覧用合言葉を入力します。管理画面は <http://localhost:5173/#/admin> です。

## 4. テスト・ビルド方法

```bash
npm test         # すべてのテスト（画面・共通処理・Worker API）
npm run build    # 型チェック + 画面の本番ビルド + Worker のビルド確認（--dry-run）
```

- `npm run test:api` … Worker のテスト。Cloudflare の実行環境（workerd）とローカルの D1・R2 を使って、実際の API に HTTP リクエストを送って確認します。
- `npm run test:shared-and-web` … コメント描画エンジン、入力検証、MP4 解析、720p 変換、画面部品のテスト。720p 変換のテストは `ffmpeg` コマンド（または環境変数 `FFMPEG_PATH` で指定した ffmpeg）があるときに実行されます。GitHub Actions の CI では固定バージョンの静的ビルド（npm の `ffmpeg-static`、キャッシュあり）を使い、`REQUIRE_FFMPEG=1` を指定しているため、ffmpeg が使えない場合はスキップせずに失敗します。

主なテスト内容：

| 分類 | 確認していること |
| --- | --- |
| アクセス制御 | 間違った合言葉の拒否／正しい合言葉でトークン発行／閲覧用トークンで管理者 API が 403／期限切れ・改ざんトークンの拒否／連続失敗の制限／CORS |
| コメント | 正しい動画に保存・再生位置の保存／一時停止中に時間が進まない／シーク後の再計算／再生速度を変えても同期／衝突回避（どの時刻でも重ならない）／色・位置・サイズ／コメントアートの改行・先頭空白／HTML・スクリプトが実行されない／連投・重複・サイズ制限 |
| 動画 | 管理者以外のアップロード拒否／720p 超・MP4 以外・H.265 のファイルを保存しない（変換済みと申告されても実ファイルで判定）／同時アップロード数の制限／分割アップロード／Range によるシーク再生／期限切れ動画の視聴不可／自動削除でファイル・メタデータ・コメントを削除／削除失敗後の再試行／孤立ファイルの削除 |
| 自動変換 | 実際の FFmpeg で、ブラウザと同じ引数を使って変換：1080p 横長 → 1280×720、1080p 縦長 → 720×1280、4:3・シネスコの縦横比維持、HEVC・WebM → H.264/AAC、回転情報付き動画、壊れたファイルは失敗して出力なし／変換後のファイルがデコードできること／変換した動画も14日後に削除 |
| 画面 | 空の一覧・API エラー・ネットワーク切断の表示 |

## 5. Cloudflare アカウントの準備

> この章から13章までは、**パソコンにプロジェクトを保存せず、ブラウザだけで作業する手順**です（GitHub Actions がデプロイを行います）。
> パソコンで `wrangler` コマンドを使う場合の手順は、各章の「（参考）コマンドで行う場合」を見てください。

1. <https://dash.cloudflare.com/sign-up> でアカウントを作成し、届いたメールで確認を済ませます。
2. 左メニューの「**Workers & Pages**」を開きます。初めて開くと **workers.dev のサブドメイン**（例：`kurobune`）を決める画面が出るので、名前を決めて登録します。
   - Worker の URL は `https://school-nico-api.<このサブドメイン>.workers.dev` になります（`school-nico-api` は `worker/wrangler.jsonc` の `name`）。
3. **アカウントID** を控えます。「Workers & Pages」の画面右側、またはダッシュボードのアカウントのホーム画面に「Account ID」として表示されています。

## 6. R2 バケットの作成

1. 左メニューの「**R2 オブジェクトストレージ**」を開き、案内に従って R2 を有効にします。無料枠の範囲でも **支払い方法（クレジットカードなど）の登録を求められる** ことがあります（[17. 無料枠と料金発生条件](#17-無料枠と料金発生条件)）。
2. 「**バケットを作成**」を押し、名前に **`school-nico-videos`** と入力して作成します（`worker/wrangler.jsonc` の `bucket_name` と同じ名前にする必要があります）。場所（ロケーション）は自動のままで構いません。
3. **バケットを公開しないでください。**「パブリックアクセス」「r2.dev サブドメイン」「カスタムドメイン」は **無効のまま** にします。動画は必ず Worker を通して配信します。

（参考）コマンドで行う場合：`cd worker && npx wrangler r2 bucket create school-nico-videos`

## 7. D1 データベースの作成

1. 左メニューの「**ストレージとデータベース**」→「**D1 SQL データベース**」を開きます。
2. 「**作成**」を押し、名前に **`school-nico-db`** と入力して作成します（`wrangler.jsonc` の `database_name` と同じ名前）。
3. 作成したデータベースの画面に表示される **Database ID**（`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` の形）を控えます。秘密情報ではありません。
4. テーブルは、次の章のワークフローが `worker/migrations/` のファイルから自動で作ります（手作業は不要です）。

（参考）コマンドで行う場合：`npx wrangler d1 create school-nico-db`

## 8. Worker のデプロイ（GitHub Actions）

### 8-1. Cloudflare の API トークンを作る

1. Cloudflare ダッシュボード右上の人のアイコン →「**My Profile（プロフィール）**」→「**API Tokens（API トークン）**」→「**Create Token（トークンを作成する）**」。
2. テンプレート「**Edit Cloudflare Workers（Cloudflare Workers を編集する）**」の「Use template」を押します。
3. 「Permissions（権限）」に次が含まれていることを確認し、足りないものは「+ Add more」で追加します。
   - Account ／ **Workers Scripts** ／ Edit
   - Account ／ **Workers R2 Storage** ／ Edit
   - Account ／ **D1** ／ Edit（テンプレートに無い場合は追加）
4. 「Account Resources」で自分のアカウントを選び、「Continue to summary」→「Create Token」。
5. 表示されたトークンを **すぐに次の手順で GitHub に貼り付けます。トークンは一度しか表示されません。** チャット・メール・ファイル・GitHub のコードには絶対に貼らないでください。

### 8-2. GitHub に登録する

GitHub のリポジトリ画面 →「**Settings**」→「**Secrets and variables**」→「**Actions**」を開きます。

| タブ | 名前 | 値 | 種類 |
| --- | --- | --- | --- |
| **Secrets** →「New repository secret」 | `CLOUDFLARE_API_TOKEN` | 8-1 のトークン | 秘密情報 |
| **Secrets** →「New repository secret」 | `CLOUDFLARE_ACCOUNT_ID` | 5章のアカウントID | 秘密情報として扱う |
| **Variables** →「New repository variable」 | `CLOUDFLARE_D1_DATABASE_ID` | 7章の Database ID | 公開してよい値 |

`CLOUDFLARE_D1_DATABASE_ID` は、デプロイ時にワークフローが `worker/wrangler.jsonc` の `database_id` に書き込みます（リポジトリのファイルは変更しません）。

### 8-3. ワークフローを実行する

1. リポジトリの「**Actions**」タブ → 左の一覧から「**Deploy Worker (manual)**」→「**Run workflow**」→ ブランチ `main` を選んで「Run workflow」。
2. ワークフローは次の順に実行されます。途中で失敗した場合、それ以降は実行されません。
   1. 必要な Secrets が登録されているか確認（値は表示しません）
   2. 依存関係のインストールとテスト
   3. D1 の Database ID を設定（形式が正しいか検査）
   4. R2 バケット `school-nico-videos` が存在するか確認
   5. D1 マイグレーション（テーブルの作成・更新）
   6. Worker のデプロイ（R2・D1 のバインディング、5分ごとの Cron Trigger を含む）
3. 緑のチェックになったら完了です。Cloudflare の「Workers & Pages」に `school-nico-api` が表示されます。
4. ブラウザで `https://school-nico-api.<サブドメイン>.workers.dev/api/health` を開き、`{"ok":true}` と表示されることを確認します。

> この時点では合言葉が未登録のため、ログインすると「サーバーの設定が完了していません」と表示されます。次の9章で登録してください。

CORS を許可するサイト（`ALLOWED_ORIGINS`）は `worker/wrangler.jsonc` に `https://kurobunelio0809.github.io` と設定済みです。**ブラウザが送るオリジンはすべて小文字** になるため、GitHub のユーザー名に大文字が含まれていても小文字で書きます。別の場所で公開する場合はこの値を変更してください。

（参考）コマンドで行う場合：`wrangler.jsonc` の `database_id` を書き換えてから、`npx wrangler d1 migrations apply school-nico-db --remote` → `npx wrangler deploy`

## 9. Workers Secrets の設定

合言葉と署名鍵は、**Cloudflare の管理画面で Worker の「Secret」として登録します**。GitHub（Secrets・Variables を含む）やソースコードには保存しません。

1. 登録する値を決めます。
   - `VIEWER_PASSPHRASE`：生徒・先生に配る閲覧用の合言葉（**8文字以上**）
   - `ADMIN_PASSPHRASE`：管理者用の合言葉（**8文字以上、閲覧用と違うもの**）
   - `SESSION_SECRET`：トークン署名用の **32文字以上のランダムな文字列**。パスワード管理アプリ（ブラウザのパスワード生成機能など）で「40文字・英数字」のように作ると簡単です。人に教える必要はありません。
2. Cloudflare ダッシュボード →「**Workers & Pages**」→「**school-nico-api**」→「**設定（Settings）**」→「**変数とシークレット（Variables and Secrets）**」→「**追加（Add）**」。
3. 「種類（Type）」で **「シークレット（Secret）」** を選び、「変数名」に `VIEWER_PASSPHRASE`、「値」に合言葉を入力します。
   - **「テキスト（Text / Plaintext）」は選ばないでください。** テキストにすると管理画面で値が見えてしまい、次回のデプロイで消えます。
4. 同じように `ADMIN_PASSPHRASE` と `SESSION_SECRET` も追加し、「**デプロイ（Deploy）**」を押して保存します。
5. 登録後は値を見ることはできません（一覧には名前だけが表示されます）。合言葉は学校内で安全に共有してください。
6. サイトを開き、合言葉でログインできることを確認します。

- Secret は `wrangler deploy`（8章のワークフロー）を再実行しても削除されません。
- 未設定・短すぎる・閲覧用と管理者用が同じ、のいずれかの場合、API は「サーバーの設定が完了していません」と応答し、ログインできません（安全側に倒しています）。

（参考）コマンドで行う場合：`npx wrangler secret put VIEWER_PASSPHRASE`（`ADMIN_PASSPHRASE`、`SESSION_SECRET` も同様）

## 10. Cron Trigger の設定と動作確認

`worker/wrangler.jsonc` に5分ごとの Cron Trigger（`"crons": ["*/5 * * * *"]`）が設定済みで、8章のデプロイで自動的に登録されます。

1. Cloudflare ダッシュボード →「Workers & Pages」→ `school-nico-api` →「設定」→「トリガー（Trigger Events / Cron Triggers）」に `*/5 * * * *` があることを確認します。
2. 数分待ってから、サイトの管理画面（`#/admin`）の「自動削除の実行記録」に記録が増えていることを確認します。
3. ログは Cloudflare ダッシュボードの `school-nico-api` →「ログ（Logs / Observability）」で見られます。`{"event":"cleanup", ...}` という行が5分ごとに出力されます（秘密情報は含まれません）。

（参考）ローカルで Cron を試す場合：`npx wrangler dev --test-scheduled` を起動し、`curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`

## 11. GitHub リポジトリの設定

1. リポジトリ →「**Settings**」→「**General**」→「**Default branch**」が **`main`** になっているか確認します。違う場合は切り替えボタンを押して `main` を選び、「Update」を押します（GitHub Pages の公開は既定ブランチから行うため）。
2. 無料プランで GitHub Pages を使うにはリポジトリが **Public（公開）** である必要があります。合言葉・API トークンなどの秘密情報はリポジトリに含まれていません。
3. `worker/.dev.vars`、`.env.local`、動画ファイル（`*.mp4` など）は `.gitignore` で除外済みです。

## 12. GitHub Actions による GitHub Pages の公開

1. リポジトリ →「**Settings**」→「**Pages**」→「Build and deployment」の「**Source**」を **GitHub Actions** にします。
2. 次の13章で `VITE_API_BASE_URL` を登録します（未登録だとワークフローが「API接続先が設定されているか確認」で止まります）。
3. 「Actions」→「**Deploy to GitHub Pages**」→「Run workflow」で公開します。以後は `main` が更新されるたびに自動で公開されます。
4. 公開 URL は `https://kurobunelio0809.github.io/UedaTube/` です（`https://<ユーザー名を小文字にしたもの>.github.io/<リポジトリ名>/`）。

ビルド時のパス（`/UedaTube/`）はワークフローが自動で設定します。カスタムドメインなどで公開する場合は、Variables に `VITE_BASE_PATH` = `/` を追加してください。画面はハッシュ方式（`#/watch/...`）の URL を使うので、ページを再読み込みしても 404 になりません。

> 動画変換用の FFmpeg（約32MB）もビルド時に一緒に公開されます（管理者が変換するときだけ読み込まれます）。ライセンスは GPL-2.0-or-later で、公開サイトの `ffmpeg/LICENSE.txt` に入手元を記載しています。

## 13. API 接続先の設定

リポジトリ →「Settings」→「Secrets and variables」→「Actions」→「**Variables**」タブ →「New repository variable」で登録します。

| 名前 | 値 | 必須 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `https://school-nico-api.<5章のサブドメイン>.workers.dev`（8-3 で `{"ok":true}` が表示された URL の `/api/health` より前） | ○ |
| `VITE_SITE_NAME` | `School NICO`（サイト名を変えたいとき） | |
| `VITE_CATEGORIES` | `授業,行事,部活動,お知らせ,その他` | |
| `VITE_BASE_PATH` | `/`（カスタムドメインのときのみ） | |

これらはビルド結果に含まれる **公開情報** です。合言葉などの秘密情報は絶対にここへ登録しないでください。登録後、「Actions」→「Deploy to GitHub Pages」→「Run workflow」で再公開します。

## 14. 動作確認手順

1. `https://ユーザー名.github.io/リポジトリ名/` を開き、わざと間違った合言葉を入力 →「合言葉が違います」と表示されること。
2. 正しい閲覧用合言葉を入力 → 動画一覧（最初は「公開中の動画はまだありません」）が表示されること。
3. 右上の「管理」→ 管理者用合言葉を入力 → 管理ダッシュボードが表示されること。
4. 「＋ 動画をアップロード」→ 720p 以下の MP4 を選ぶ →「✔ そのままアップロードできます」と表示されること。
5. 1080p の動画（スマートフォンで撮った動画など）を選ぶ →「アップロード前に、このブラウザで自動変換します」と表示 →「変換を開始」→ 進み具合が表示され、確認画面のプレビューで再生でき、解像度が 1280×720（縦長は 720×1280）以下になっていること。
6. タイトル等を入力 → 削除予定日時を確認 →「アップロードを開始」→ 完了すること。管理画面の動画詳細に「自動変換済み（元：1920×1080 …）」と表示されること。
7. 「動画を確認する」→ 再生・シーク・音量・全画面・再生速度・コメント表示切替が動くこと。
8. コメントを投稿 → 右から左へ流れ、別のブラウザ（またはスマートフォン）で同じ動画の同じ位置を再生したときにも表示されること（最大10秒程度で他の人の画面に反映されます）。
9. 「文字職人モード」→「見本を入れる」→ 動画の上にプレビューが出ること → 投稿できること。
10. 管理画面でコメントの非表示・削除、動画のコメント受付停止ができること。

## 15. 合言葉の変更方法

1. Cloudflare ダッシュボード →「Workers & Pages」→ `school-nico-api` →「設定」→「変数とシークレット」を開きます。
2. 変更したい Secret（`VIEWER_PASSPHRASE` など）の「編集」→ 新しい値を入力 →「デプロイ」。
3. **すぐに全員を締め出したいとき（合言葉が漏れたときなど）は、`SESSION_SECRET` も新しいランダムな文字列に変更してください。** 変更すると、発行済みのトークンがすべて無効になります。

- 保存するとすぐに反映されます（GitHub 側の作業は不要です）。
- 合言葉だけを変えた場合、既にログイン中の人のトークンは有効期限（閲覧用8時間）まで使えます。
- トークンの有効期間は `wrangler.jsonc` の `VIEWER_TOKEN_TTL_SECONDS` などで変更できます（変更後に8章のワークフローを実行）。

（参考）コマンドで行う場合：`npx wrangler secret put VIEWER_PASSPHRASE`

## 16. 動画とコメントの自動削除を確認する方法

自動削除の仕組み：

1. アップロード完了時刻を `uploadedAt`、その14日後（UTC）を `expiresAt` として D1 に保存します（データベースの CHECK 制約で「ちょうど14日後」以外は保存できません）。
2. 期限を過ぎた瞬間から、一覧・詳細・コメント・動画配信・サムネイルの API がすべて **410（期限切れ）** を返します。Cron が動く前でも視聴できません。
3. 5分ごとの Cron Trigger が、期限切れ動画の R2 ファイル（動画・サムネイル）、D1 のコメント、D1 の動画情報を削除します。1回に最大10本ずつ処理します。
4. 削除の途中で失敗した場合は「削除処理中」の状態で残り（視聴不可のまま）、次回の Cron で再試行します。既に消えたファイルを消そうとしても失敗しません。
5. 期限切れの動画は「公開する」操作でも再公開できません（410 で拒否）。期限の延長機能もありません。
6. 完了しなかったアップロード・検査に失敗したアップロードは24時間後に、D1 に対応する動画が無い R2 上の孤立ファイルは6時間後に自動で削除します。

確認手順（本番で試す場合は、必ずテスト用の動画で行ってください）。SQL は Cloudflare ダッシュボードの「D1 SQL データベース」→ `school-nico-db` →「コンソール（Console）」に貼り付けて実行できます。

1. 動画の ID を確認します（管理画面の動画詳細ページの URL `#/admin/videos/<ID>` でも分かります）。

   ```sql
   SELECT id, title, datetime(expiresAt/1000,'unixepoch') AS expires_utc FROM videos;
   ```

2. テスト用の動画を「15日前にアップロードされた」ことにします（ID を置き換え）。

   ```sql
   UPDATE videos SET uploadedAt = (strftime('%s','now')*1000 - 15*86400000), expiresAt = (strftime('%s','now')*1000 - 86400000) WHERE id = 'ここに動画ID';
   ```

3. 画面でその動画を開く →「公開期限が過ぎました」と表示され、一覧からも消えていること。
4. 最大5分待つか、管理ダッシュボードの「今すぐ自動削除を実行」を押す。
5. 動画情報・コメントが消えたことを D1 のコンソールで確認します（どちらも 0 になれば削除済み）。

   ```sql
   SELECT (SELECT COUNT(*) FROM videos WHERE id='ここに動画ID') AS videos, (SELECT COUNT(*) FROM comments WHERE videoId='ここに動画ID') AS comments;
   ```

6. Cloudflare ダッシュボードの「R2」→ `school-nico-videos` → `videos/` フォルダーに、その動画 ID のフォルダー（変換後の動画 `video.mp4` とサムネイル）が無いことを確認します。自動変換した動画も同じ場所に保存されているため、同じように削除されます（元の動画はもともと保存されていません）。

## 17. 無料枠と料金発生条件

> 以下は執筆時点で一般に公開されている値です。**料金・無料枠は変更されることがあるため、必ず公式ページで最新の値を確認してください。**
> [Workers の制限](https://developers.cloudflare.com/workers/platform/limits/) / [Workers の料金](https://developers.cloudflare.com/workers/platform/pricing/) / [D1 の料金](https://developers.cloudflare.com/d1/platform/pricing/) / [R2 の料金](https://developers.cloudflare.com/r2/pricing/) / [GitHub Pages の制限](https://docs.github.com/ja/pages/getting-started-with-github-pages/github-pages-limits)

| サービス | 無料枠の目安 | このサイトでの使われ方 |
| --- | --- | --- |
| Workers（Free） | 1日10万リクエスト、1回あたりの CPU 時間に上限、リクエスト本文は最大100MB | API 呼び出し、動画の Range 配信（シークごとに1リクエスト）、10秒ごとのコメント取得。**無料プランは上限を超えると課金ではなくエラーになります** |
| D1（Free） | 1日あたり 読み取り500万行・書き込み10万行、合計5GB | コメントの保存・取得、レート制限 |
| R2 | 毎月 10GB-月の保存、Class A 操作100万回、Class B 操作1000万回、**転送量（エグレス）無料** | 動画の保存（アップロード1パートごとに Class A、再生の Range ごとに Class B） |
| GitHub Pages | 公開サイト1GB程度、月100GB程度の転送の目安 | 画面ファイル（約0.3MB）と動画変換用の FFmpeg（約32MB、管理者が変換するときだけ読み込み） |
| GitHub Actions | 公開リポジトリは標準のランナーを無料で利用可能 | テスト・Worker のデプロイ・Pages の公開（動画の変換には使いません） |
| 動画の自動変換 | 管理者のブラウザで実行するため **無料** | 変換中は管理者のパソコンの CPU・メモリを使います |

料金が発生する・止まる主な条件：

- **R2 の保存容量が 10GB を超えると課金対象**（超過分 1GB あたり月額数セント程度）。動画は14日で消えるため、「14日間にアップロードする動画の合計」を 10GB 未満に保てば無料枠内に収まります。管理ダッシュボードの「動画の保存容量」で確認できます。1本の上限は `MAX_UPLOAD_BYTES`（初期値500MB）で調整できます。
- Workers を有料プラン（Workers Paid）に変更した場合は月額料金がかかります。無料プランのままなら、1日10万リクエストを超えると当日中はエラーになり、翌日（UTC 0時）に回復します。
- 全校で同時に視聴するなど利用が多い場合、コメントのポーリング（1人10秒ごと）でリクエストが増えます。`frontend/src/config.ts` の `commentPollMs` を長くすると減らせます。
- Cloudflare ダッシュボードの「請求」で利用状況と、R2 の使用量の通知を設定しておくことをおすすめします。
- サーバー側で動画を変換する Cloudflare Stream・Containers は有料です。このサイトは使っていません（[動画の自動変換](#動画の自動変換720p)）。

## 18. バックアップと障害発生時の対応

**バックアップ**

- D1：Cloudflare の Time Travel 機能で過去の時点に戻せます（無料プランで戻せる期間は公式ページで確認してください。コマンド：`npx wrangler d1 time-travel info school-nico-db`）。手動で保存する場合は：
  ```bash
  npx wrangler d1 export school-nico-db --remote --output backup.sql
  ```
  （`backup.sql` にはコメント本文が含まれるため、取り扱いに注意し、GitHub にコミットしないでください。）
- R2：動画は14日で消える前提のため、自動バックアップはしていません。元の動画ファイルは各先生の手元に保管してください。

**よくある障害と対応**

| 症状 | 確認・対応 |
| --- | --- |
| 「サーバーに接続できませんでした」 | `…workers.dev/api/health` が開けるか確認。開けない場合は Cloudflare のステータス（<https://www.cloudflarestatus.com/>）を確認 |
| 「サーバーの設定が完了していません」 | Cloudflare の `school-nico-api` →「設定」→「変数とシークレット」に3つの Secret があるか確認（短すぎる・閲覧用と管理者用が同じ場合も表示） |
| 画面は出るが API がすべて失敗（ブラウザのコンソールに CORS エラー） | `wrangler.jsonc` の `ALLOWED_ORIGINS` が **小文字の** `https://ユーザー名.github.io` になっているか確認し、8章のワークフローを再実行 |
| Deploy Worker が「CLOUDFLARE_D1_DATABASE_ID が未設定」で失敗 | 8-2 の Variables を確認（Secrets ではなく Variables タブ） |
| Deploy Worker が「R2 バケットが見つかりません」で失敗 | 6章のバケット名 `school-nico-videos` と、API トークンの R2 権限を確認 |
| Deploy Worker が認証エラー（Authentication error など）で失敗 | API トークンの権限（Workers Scripts・Workers R2 Storage・D1 の Edit）とアカウントID を確認。トークンを作り直して Secrets を更新 |
| 動画の変換が終わらない・失敗する | 長い動画・大きい動画はブラウザのメモリが足りないことがあります。動画を短く分けるか、パソコンで 720p に書き出してからアップロードしてください |
| GitHub Pages の画面が真っ白 | Actions のログを確認。Variables の `VITE_API_BASE_URL` 未設定だとビルドが止まります |
| 動画が再生できない | 管理画面の動画詳細で「再生可能か検査」を実行。H.264 以外のコーデックや壊れたファイルの可能性 |
| 自動削除が動いていない | 管理ダッシュボードの「自動削除の実行記録」と Cloudflare の Worker の「ログ」を確認。止まっていても期限切れ動画は視聴できません。「今すぐ自動削除を実行」で手動実行できます |
| 削除処理中のまま残る | 次回の Cron で自動的に再試行されます。エラー内容は管理ダッシュボードに表示されます |
| 1日のリクエスト上限に達した | 翌日 UTC 0時（日本時間 9時）に回復します |
| 合言葉が漏れた | [15. 合言葉の変更方法](#15-合言葉の変更方法) で合言葉と `SESSION_SECRET` をすぐに変更 |
| 不適切なコメント | 管理画面の動画詳細で非表示・削除。荒れている場合は「コメント受付を停止」 |

---

## API 一覧

すべての API は `Authorization: Bearer <トークン>` が必要です（合言葉の確認と動画・サムネイル配信を除く。配信は短期署名 URL で認証）。

| メソッド・パス | 権限 | 内容 |
| --- | --- | --- |
| `POST /api/access/verify` | なし | 閲覧用合言葉の確認 → 閲覧用トークン |
| `POST /api/admin/verify` | なし | 管理者用合言葉の確認 → 管理者トークン |
| `GET /api/session` | 閲覧 | トークンの有効性確認 |
| `GET /api/videos?q=&category=&sort=new\|old` | 閲覧 | 公開中（期限内）の動画一覧 |
| `GET /api/videos/:id` | 閲覧 | 動画の詳細と短期視聴 URL |
| `GET /api/videos/:id/playback` | 閲覧 | 短期視聴 URL の再発行 |
| `GET /api/videos/:id/stream?st=` | 署名 URL | 期限確認・Range 対応の動画配信 |
| `GET /api/videos/:id/thumbnail?st=` | 署名 URL | サムネイル |
| `GET /api/videos/:id/comments?after=` | 閲覧 | コメント一覧（`after` で差分取得） |
| `POST /api/videos/:id/comments` | 閲覧 | コメント投稿 |
| `GET /api/admin/dashboard` | 管理者 | 統計・期限間近・失敗・自動削除の記録 |
| `GET /api/admin/videos` | 管理者 | 全動画（非公開・失敗含む） |
| `POST /api/admin/videos` | 管理者 | アップロード開始（R2 マルチパート作成） |
| `PUT /api/admin/videos/:id/parts/:n` | 管理者 | 分割アップロードの1パート |
| `POST /api/admin/videos/:id/complete` | 管理者 | 結合・MP4 検査・公開 |
| `PUT /api/admin/videos/:id/thumbnail` | 管理者 | サムネイル登録（JPEG/PNG/WebP、2MB まで） |
| `POST /api/admin/videos/:id/inspect` | 管理者 | 保存済みファイルの検査 |
| `GET /api/admin/videos/:id` / `PATCH` / `DELETE` | 管理者 | 取得・タイトル等/公開状態/コメント受付の変更・削除（アップロード中なら中止） |
| `GET /api/admin/videos/:id/comments` | 管理者 | 非表示を含むコメント一覧 |
| `PATCH /api/admin/comments/:id` / `DELETE` | 管理者 | コメントの非表示切替・削除 |
| `POST /api/admin/cleanup` | 管理者 | 自動削除の手動実行 |

**アップロードの方式**：Workers 無料プランのリクエスト本文の上限（100MB）を超えられるよう、動画を `UPLOAD_PART_BYTES`（初期値10MiB）ごとに分割して送り、R2 のマルチパートアップロードで結合します。結合後、Worker が R2 から範囲読み込みして MP4 の構造（形式・コーデック・解像度・長さ）を **サーバー側でも検査** し、条件を満たさなければファイルを削除して失敗として記録します（公開されません）。720p への変換はアップロード前にブラウザで行います（[動画の自動変換](#動画の自動変換720p)）。同時に進行できるアップロードは3件までです。

## データベース

テーブル定義は `worker/migrations/` にあります（`0001_init.sql`、`0002_transcode_source.sql`）。

- `videos`：id, title, description, category, r2Key, thumbnailKey, durationSeconds, width, height, createdAt, uploadedAt, expiresAt, status（uploading / published / hidden / failed / deleting）, commentsEnabled ほか
- `comments`：id, videoId（`ON DELETE CASCADE`）, nickname, text, playbackTimeSeconds, mode, color, fontSize, fontFamily, xPercent, yPercent, durationSeconds, opacity, isCommentArt, artLines（行ごとの文字列・色・サイズの JSON）, textAlign, lineHeight, hidden, createdAt ほか
- `videos` の `sourceWidth`, `sourceHeight`, `sourceCodec`, `transcoded`：自動変換した場合の **元動画の参考情報**（保存される動画の解像度・コーデックは `width`・`height`・`videoCodec` で、サーバーが実ファイルを検査した値）
- `rate_limits`、`meta`、`cleanup_runs`：連続試行の制限、定期処理の状態、自動削除の記録

テーブルを変更するときは `worker/migrations/0003_xxx.sql` のように新しいファイルを追加し、8章の「Deploy Worker」ワークフローを実行します（マイグレーションが自動で適用されます）。

## 設定値の一覧

| 場所 | 名前 | 初期値 | 内容 |
| --- | --- | --- | --- |
| Workers Secrets（Cloudflare 管理画面） | `VIEWER_PASSPHRASE` / `ADMIN_PASSPHRASE` / `SESSION_SECRET` | なし | 合言葉と署名鍵 |
| GitHub Secrets | `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | なし | Worker のデプロイ用 |
| GitHub Variables | `CLOUDFLARE_D1_DATABASE_ID` | なし | D1 の Database ID（デプロイ時に設定） |
| `wrangler.jsonc` | `ALLOWED_ORIGINS` | `https://kurobunelio0809.github.io` | CORS を許可するサイト（小文字） |
| 〃 | `MAX_UPLOAD_BYTES` | 524288000（500MB） | 動画1本の最大サイズ |
| 〃 | `UPLOAD_PART_BYTES` | 10485760（10MiB） | 分割アップロードの1回のサイズ（5MiB〜95MiB） |
| 〃 | `VIEWER_TOKEN_TTL_SECONDS` / `ADMIN_TOKEN_TTL_SECONDS` | 28800 / 7200 | トークンの有効期間（秒） |
| 〃 | `MEDIA_TOKEN_TTL_SECONDS` | 900 | 動画・サムネイルの署名 URL の有効期間（秒） |
| GitHub Variables | `VITE_API_BASE_URL` / `VITE_SITE_NAME` / `VITE_CATEGORIES` / `VITE_BASE_PATH` | — | 画面の設定 |
| `shared/constants.ts` | 文字数・行数・サイズの上限、色のプリセット | — | 画面と API の両方に反映 |
| `shared/transcode.ts` | `TRANSCODE_LIMITS` / `TRANSCODE_OUTPUT` | 1GB・30分・2時間 / CRF 23・veryfast・AAC 128kbps | ブラウザ内変換の上限と画質 |
| `worker/src/routes/admin.ts` | `MAX_CONCURRENT_UPLOADS` | 3 | 同時に進行できるアップロード数 |
| `frontend/src/config.ts` | `commentPollMs` など | 10秒 | コメント取得間隔など |

保存期間（14日）と最大解像度（720p）は仕様として `shared/constants.ts` に固定しています。

## 制限事項・今後の課題

- 動画の変換はサーバーではなく管理者のブラウザで行います（無料で運用するため）。変換中はタブを開いたままにする必要があり、長い動画は時間がかかります。変換元は1GB・30分までです。
- スマートフォン（特に iPhone）のブラウザはメモリが少ないため、変換はパソコンのブラウザ（Chrome・Edge・Firefox など）で行うことをおすすめします。
- コメントは10秒ごとのポーリングで共有します（WebSocket などのリアルタイム通信は使っていません）。
- 1本の動画で一度に読み込むコメントは最新2000件まで、保存できるのは20000件までです。
- iPhone の Safari は要素の全画面表示に対応していないため、全画面時は動画だけの表示になり、コメントは表示されません（通常表示ではコメントが表示されます）。
- コメントアートの見た目は端末にあるフォントに左右されます。等幅フォントを選ぶと崩れにくくなります。
- 連投制限は主にブラウザのセッション単位です。合言葉を入力し直すと新しいセッションになるため、厳密な個人単位の制限ではありません。同じIPアドレス全体にも上限（30秒に120回）があり、学校全体で一斉に投稿するような使い方では `worker/src/routes/comments.ts` の `COMMENT_RATE.ipBurstMax` を調整してください。
