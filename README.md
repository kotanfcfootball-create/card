# NFCケース台帳（試作）

ケースのNFCシールをかざすと開くWebページです。

- 初めてかざした人 → カード情報と暗証番号を登録
- 登録後は誰がかざしてもカード情報と来歴が見える（ログイン不要）
- 持ち主は暗証番号で編集、譲渡コードで次の持ち主へ引き継ぎ

Cloudflare Workers（ページ）と D1（データベース）の無料枠で動きます。

## 公開手順（PCで、最初の1回だけ）

事前に [Node.js](https://nodejs.org/ja)（LTS版）を入れておきます。このフォルダでターミナルを開いて、上から順に実行します。

```bash
# 1. 必要な道具を入れる
npm install

# 2. Cloudflareにログイン（ブラウザが開くので許可する）
npx wrangler login

# 3. データベースを作る → 出てきた database_id を wrangler.toml に貼り付ける
npx wrangler d1 create nfc-case-ledger

# 4. データベースに表を作る
npm run db:init

# 5. ログイン用の秘密の文字列を設定（聞かれたら、長くてランダムな英数字を貼り付ける）
npx wrangler secret put SESSION_SECRET

# 6. 公開する → 「https://nfc-case-ledger.<あなたの名前>.workers.dev」のようなURLが出る
npm run deploy
```

## シール用のURLを発行する

```bash
# 例：10枚分。最後は手順6で出たURL
npm run issue -- 10 https://nfc-case-ledger.xxxx.workers.dev

# 出てきた .sql をデータベースに登録（ファイル名は表示されたものに置き換える）
npx wrangler d1 execute nfc-case-ledger --remote --file out/tags-XXXXXXXX.sql
```

`out/` の `.csv` にURLの一覧が入っています。NFC Toolsの「書く」→「URL/URI」で1枚ずつ書き込みます。テスト中はロックしないでください。出荷するものはロックしてから箱に入れます。

## 変えたいとき

- 画面上部の名前：`wrangler.toml` の `BRAND_NAME`
- 公開・非公開にする項目：`src/index.js` の `PUBLIC_FIELDS` / `PRIVATE_FIELDS`
- 変更したら `npm run deploy` で反映

## 動作テスト

```bash
node test/flow.test.mjs
```

登録・閲覧・編集・ロック・譲渡の流れを、本番と同じコードで確認します（Node.js 22以上）。

## ファイル

| ファイル | 中身 |
|---|---|
| `src/index.js` | ページとすべての処理 |
| `schema.sql` | データベースの表 |
| `scripts/issue-tags.mjs` | シール用URLの一括発行 |
| `test/flow.test.mjs` | 通しの動作テスト |
| `wrangler.toml` | Cloudflareの設定 |
