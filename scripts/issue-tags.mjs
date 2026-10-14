// タグIDを発行する。
// 使い方: npm run issue -- <枚数> <ドメイン>
//   例:   npm run issue -- 100 https://nfc-case-ledger.example.workers.dev
//
// 出力:
//   out/tags-<日時>.sql … データベースに登録するSQL（下のコマンドで流し込む）
//   out/tags-<日時>.csv … シールに書き込むURLの一覧（NFC Toolsで1枚ずつ書く）
//
// 流し込み: npx wrangler d1 execute nfc-case-ledger --remote --file out/tags-<日時>.sql

import { randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const count = Number(process.argv[2] || 10);
const base = (process.argv[3] || "https://YOUR-DOMAIN").replace(/\/$/, "");
if (!Number.isInteger(count) || count < 1 || count > 10000) {
  console.error("枚数は1〜10000で指定してください");
  process.exit(1);
}

const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 紛らわしい 0/O, 1/I を除外
const ids = new Set();
while (ids.size < count) {
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[randomInt(chars.length)];
  ids.add(s);
}

const now = new Date().toISOString();
const stamp = now.replace(/[-:]/g, "").slice(0, 15);
mkdirSync("out", { recursive: true });
const sql = [...ids].map((id) => `INSERT INTO tags (id, created_at) VALUES ('${id}', '${now}');`).join("\n");
const csv = "tag_id,url\n" + [...ids].map((id) => `${id},${base}/t/${id}`).join("\n") + "\n";
writeFileSync(`out/tags-${stamp}.sql`, sql + "\n");
writeFileSync(`out/tags-${stamp}.csv`, csv);
console.log(`${count}件発行しました: out/tags-${stamp}.sql / out/tags-${stamp}.csv`);
