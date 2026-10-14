// 本番と同じ src/index.js を、Node内蔵SQLiteでD1を再現して通しで動かすテスト。
// 実行: node test/flow.test.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const DB = {
  prepare(sql) {
    let args = [];
    const st = sqlite.prepare(sql);
    const api = {
      bind(...a) { args = a.map((x) => (x === undefined ? null : x)); return api; },
      async first() { return st.get(...args) ?? null; },
      async all() { return { results: st.all(...args) }; },
      async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes) } }; },
    };
    return api;
  },
};
const env = { DB, SESSION_SECRET: "test-secret", BRAND_NAME: "テスト台帳" };
sqlite.prepare("INSERT INTO tags (id, created_at) VALUES ('ABCD2345', ?)").run(new Date().toISOString());

function client() {
  let cookie = "";
  return async function req(path, form) {
    const init = { method: form ? "POST" : "GET", headers: {} };
    if (cookie) init.headers.Cookie = cookie;
    if (form) init.body = new URLSearchParams(form);
    const res = await worker.fetch(new Request("https://example.test" + path, init), env);
    const set = res.headers.get("Set-Cookie");
    if (set) cookie = set.split(";")[0] === "s=" ? "" : set.split(";")[0];
    return { status: res.status, location: res.headers.get("Location"), text: await res.text() };
  };
}

const ok = (name) => console.log("✔ " + name);
const buyer = client();
const stranger = client();

let r = await stranger("/t/ZZZZ9999");
assert.equal(r.status, 404); ok("存在しないタグは404");

r = await buyer("/t/ABCD2345");
assert.match(r.text, /ケースを登録/); ok("未登録タグは登録画面");

r = await buyer("/t/ABCD2345/claim", { name: "テストカード", grader: "PSA", grade: "10", cert: "12345678", price: "50000", pin: "1234", pin2: "9999" });
assert.match(r.text, /一致しません/); ok("暗証番号の確認ミスを検出");

r = await buyer("/t/ABCD2345/claim", { name: "テストカード<script>", grader: "PSA", grade: "10", cert: "12345678", price: "50000", memo: "秘密のメモ", pin: "1234", pin2: "1234" });
assert.equal(r.status, 303); assert.equal(r.location, "/t/ABCD2345?done=registered"); ok("登録できる");

r = await buyer("/t/ABCD2345?done=registered");
assert.match(r.text, /登録しました/); assert.match(r.text, /50000/); assert.match(r.text, /秘密のメモ/);
assert.ok(!r.text.includes("<script>")); ok("持ち主には非公開情報も表示・HTMLはエスケープ");

r = await stranger("/t/ABCD2345");
assert.match(r.text, /テストカード/); assert.match(r.text, /初代の持ち主が登録/);
assert.ok(!r.text.includes("50000") && !r.text.includes("秘密のメモ")); ok("他人には公開情報と来歴だけ表示（ログイン不要）");

r = await stranger("/t/ABCD2345/claim", { name: "乗っ取り", pin: "0000", pin2: "0000" });
r = await stranger("/t/ABCD2345");
assert.ok(!r.text.includes("乗っ取り")); ok("登録済みタグは再登録できない");

r = await stranger("/t/ABCD2345/edit");
assert.equal(r.location, "/t/ABCD2345/login"); ok("他人は編集画面に入れない");

for (let i = 0; i < 4; i++) r = await stranger("/t/ABCD2345/login", { pin: "0000" });
assert.match(r.text, /あと1回/);
r = await stranger("/t/ABCD2345/login", { pin: "0000" });
assert.match(r.text, /15分間ロック/);
r = await stranger("/t/ABCD2345/login", { pin: "1234" });
assert.match(r.text, /一時的にロック/); ok("暗証番号5回失敗でロック（正しい番号も受け付けない）");
sqlite.prepare("UPDATE tags SET locked_until = 0").run();

r = await buyer("/t/ABCD2345/edit", { name: "テストカード改", grader: "PSA", grade: "9", cert: "12345678", price: "50000" });
assert.equal(r.location, "/t/ABCD2345?done=saved");
r = await stranger("/t/ABCD2345");
assert.match(r.text, /テストカード改/); ok("持ち主は編集できる");

r = await buyer("/t/ABCD2345/transfer", {});
const code = r.text.match(/class="code mono">([A-Z0-9-]+)</)[1];
assert.ok(code.length === 11); ok("譲渡コードを発行");

const newOwner = client();
r = await newOwner("/t/ABCD2345/receive", { code: "WRONG-CODE1", pin: "5678", pin2: "5678" });
assert.match(r.text, /譲渡コードが違う/);
r = await newOwner("/t/ABCD2345/receive", { code: code.toLowerCase(), pin: "5678", pin2: "5678" });
assert.equal(r.location, "/t/ABCD2345?done=received"); ok("新しい持ち主が引き継げる（小文字入力も可）");

r = await newOwner("/t/ABCD2345?done=received");
assert.match(r.text, /2代目の持ち主へ譲渡/); assert.match(r.text, /初代の持ち主が登録/);
assert.ok(!r.text.includes("50000")); ok("来歴は残り、前の持ち主の非公開情報は消える");

r = await buyer("/t/ABCD2345/edit");
assert.equal(r.location, "/t/ABCD2345/login"); ok("前の持ち主のログインは無効になる");
r = await buyer("/t/ABCD2345/login", { pin: "1234" });
assert.match(r.text, /暗証番号が違います/); ok("前の持ち主の暗証番号も使えない");

r = await newOwner("/t/ABCD2345/receive", { code, pin: "1111", pin2: "1111" });
assert.match(r.text, /譲渡コードが違う/); ok("使用済みの譲渡コードは再利用できない");

console.log("\nすべて通過");
