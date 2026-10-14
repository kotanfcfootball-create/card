// NFCケース台帳 — Cloudflare Worker
//
// シールに書き込むURL:  https://<あなたのドメイン>/t/<タグID>
//   未登録のタグ → 購入者の登録画面
//   登録済みのタグ → カード情報と来歴（誰でも閲覧可・ログイン不要）
//   持ち主 → 暗証番号で編集・譲渡

const PIN_RE = /^\d{4,8}$/;
const TAG_RE = /^[A-Z0-9]{6,16}$/;
const SESSION_MS = 30 * 60 * 1000;          // 持ち主ログインの有効時間 30分
const TRANSFER_MS = 7 * 24 * 60 * 60 * 1000; // 譲渡コードの有効期限 7日
const MAX_FAILS = 5;                          // 暗証番号の失敗許容回数
const LOCK_MS = 15 * 60 * 1000;              // 失敗が続いたときのロック時間
const GRADERS = ["PSA", "BGS", "CGC", "ARS", "その他", "未鑑定"];
const PUBLIC_FIELDS = ["name", "set_no", "grader", "grade", "cert"];
const PRIVATE_FIELDS = ["acquired", "source", "price", "place", "memo"];
const MAXLEN = { name: 80, set_no: 60, grader: 10, grade: 10, cert: 20, acquired: 10, source: 60, price: 20, place: 60, memo: 1000 };

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error(err);
      return page(env, "エラー", `<p>うまく表示できませんでした。少し待ってからもう一度かざしてください。</p>`, 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method;

  if (parts.length === 0) {
    return page(env, "ようこそ", `<p>このページはケースのNFCタグから開きます。スマホをケースにかざしてください。</p>`);
  }
  if (parts[0] !== "t" || !parts[1]) return notFound(env);

  const id = parts[1].toUpperCase();
  if (!TAG_RE.test(id)) return notFound(env);
  const tag = await env.DB.prepare("SELECT * FROM tags WHERE id = ?").bind(id).first();
  if (!tag) return notFound(env);

  const action = parts[2] || "";
  const sub = parts[3] || "";
  const owner = await isOwner(request, env, tag);

  // ---- 未登録のタグ ----
  if (!tag.claimed_at) {
    if (action === "" && method === "GET") return claimForm(env, tag, {}, "");
    if (action === "claim" && method === "POST") return claim(request, env, tag);
    return redirect(`/t/${id}`);
  }

  // ---- 登録済みのタグ ----
  if (action === "" && method === "GET") return viewPage(env, tag, owner, url.searchParams.get("done"));

  if (action === "login") {
    if (method === "GET") return loginForm(env, tag, "");
    if (method === "POST") return login(request, env, tag);
  }
  if (action === "logout" && method === "POST") {
    return redirect(`/t/${id}`, clearCookie(id));
  }
  if (action === "edit") {
    if (!owner) return redirect(`/t/${id}/login`);
    if (method === "GET") return editForm(env, tag, tag, "");
    if (method === "POST") return saveEdit(request, env, tag);
  }
  if (action === "transfer" && method === "POST") {
    if (!owner) return redirect(`/t/${id}/login`);
    if (sub === "cancel") {
      await env.DB.prepare("UPDATE tags SET transfer_hash = NULL, transfer_expires = NULL WHERE id = ?").bind(id).run();
      return redirect(`/t/${id}?done=transfer_cancelled`);
    }
    return issueTransfer(env, tag);
  }
  if (action === "receive") {
    if (method === "GET") return receiveForm(env, tag, {}, "");
    if (method === "POST") return receive(request, env, tag);
  }
  return redirect(`/t/${id}`);
}

// ================= 登録 =================

async function claim(request, env, tag) {
  const form = await request.formData();
  const values = readFields(form, [...PUBLIC_FIELDS, ...PRIVATE_FIELDS]);
  const pin = String(form.get("pin") || "");
  const pin2 = String(form.get("pin2") || "");

  if (!values.name) return claimForm(env, tag, values, "カード名を入力してください。");
  if (!PIN_RE.test(pin)) return claimForm(env, tag, values, "暗証番号は4〜8桁の数字にしてください。");
  if (pin !== pin2) return claimForm(env, tag, values, "確認用の暗証番号が一致しません。");

  const { hash, salt } = await hashPin(pin);
  const now = new Date().toISOString();
  const gen = tag.owner_gen + 1;
  // claimed_at IS NULL を条件にして、同時に2人が登録しても1人だけが通るようにする
  const res = await env.DB.prepare(
    `UPDATE tags SET claimed_at = ?, owner_gen = ?, pin_hash = ?, pin_salt = ?, fail_count = 0, locked_until = 0,
       name = ?, set_no = ?, grader = ?, grade = ?, cert = ?, acquired = ?, source = ?, price = ?, place = ?, memo = ?
     WHERE id = ? AND claimed_at IS NULL`
  ).bind(now, gen, hash, salt, values.name, values.set_no, values.grader, values.grade, values.cert,
    values.acquired, values.source, values.price, values.place, values.memo, tag.id).run();
  if (!res.meta.changes) return redirect(`/t/${tag.id}`);

  await addEvent(env, tag.id, "registered", gen, now);
  return redirect(`/t/${tag.id}?done=registered`, await sessionCookie(env, tag.id, gen));
}

function claimForm(env, tag, v, error) {
  return page(env, "ケースを登録", `
    <h1>ケースを登録</h1>
    <p class="lead">このケースはまだ登録されていません。収めたカードの情報と、編集用の暗証番号を設定してください。</p>
    ${errorBox(error)}
    <form method="post" action="/t/${tag.id}/claim" class="stack">
      ${cardFields(v)}
      <fieldset class="stack">
        <legend>暗証番号（4〜8桁の数字）</legend>
        <p class="hint">情報の編集や、ケースを譲るときに使います。忘れると編集できなくなるので控えておいてください。</p>
        ${input("pin", "暗証番号", "", { type: "password", inputmode: "numeric", autocomplete: "new-password", required: true })}
        ${input("pin2", "暗証番号（確認）", "", { type: "password", inputmode: "numeric", autocomplete: "new-password", required: true })}
      </fieldset>
      <button class="primary" type="submit">登録する</button>
    </form>
    <p class="hint">タグID <span class="mono">${tag.id}</span></p>`);
}

// ================= 閲覧 =================

async function viewPage(env, tag, owner, done) {
  const { results: events } = await env.DB.prepare("SELECT type, gen, at FROM events WHERE tag_id = ? ORDER BY id").bind(tag.id).all();
  const notices = {
    registered: "登録しました。これからはケースをかざすとこの画面が開きます。",
    saved: "保存しました。",
    transfer_cancelled: "譲渡コードを取り消しました。",
    received: "引き継ぎが完了しました。あなたが新しい持ち主です。",
  };
  const notice = notices[done] ? `<div class="notice" role="status">${notices[done]}</div>` : "";
  const grade = [tag.grader, tag.grade].filter(Boolean).join(" ");
  const verify = tag.cert && tag.grader === "PSA"
    ? `<a class="btn" href="https://www.psacard.com/cert/${encodeURIComponent(tag.cert)}" target="_blank" rel="noopener">PSA公式サイトで鑑定番号を照会</a>`
    : "";

  const history = events.map((e) => {
    const label = e.type === "registered" ? (e.gen > 1 ? `${e.gen}代目の持ち主が登録` : "初代の持ち主が登録")
      : e.type === "transferred" ? `${e.gen}代目の持ち主へ譲渡` : "登録をリセット";
    return `<li><time class="mono">${fmtDate(e.at)}</time><span>${label}</span></li>`;
  }).join("");

  const privateBlock = owner ? `
    <section class="panel">
      <h2>持ち主だけに見える情報</h2>
      <dl class="fields">
        ${dl("入手日", tag.acquired, true)}${dl("入手先", tag.source)}${dl("入手価格", tag.price)}${dl("保管場所", tag.place)}
      </dl>
      ${tag.memo ? `<p class="hint">メモ</p><p class="memo">${esc(tag.memo)}</p>` : ""}
      ${!PRIVATE_FIELDS.some((k) => tag[k]) ? `<p class="hint">まだ何も入力されていません。</p>` : ""}
    </section>
    <div class="row">
      <a class="btn primary" href="/t/${tag.id}/edit">情報を編集</a>
      <form method="post" action="/t/${tag.id}/logout"><button type="submit">ログアウト</button></form>
    </div>
    ${transferBlock(tag)}` : `
    <div class="row">
      <a class="btn" href="/t/${tag.id}/login">持ち主の方（編集）</a>
      <a class="btn" href="/t/${tag.id}/receive">このケースを譲り受けた方</a>
    </div>`;

  return page(env, tag.name || "カード情報", `
    ${notice}
    <div class="head"><h1>${esc(tag.name)}</h1>${grade ? `<span class="chip">${esc(grade)}</span>` : ""}</div>
    <section class="panel">
      <dl class="fields">
        ${dl("セット・番号", tag.set_no)}${dl("鑑定会社", tag.grader)}${dl("グレード", tag.grade)}${dl("鑑定番号", tag.cert, true)}
        ${dl("持ち主", `${tag.owner_gen}代目`)}
      </dl>
    </section>
    ${verify}
    <section>
      <h2>来歴</h2>
      <ol class="history">${history}</ol>
    </section>
    ${privateBlock}
    <p class="hint">タグID <span class="mono">${tag.id}</span></p>`);
}

function transferBlock(tag) {
  const active = tag.transfer_hash && tag.transfer_expires > Date.now();
  if (active) {
    return `<section class="panel">
      <h2>譲渡コードを発行中</h2>
      <p>${fmtDate(new Date(tag.transfer_expires).toISOString())} まで有効です。コードを再表示することはできないので、なくした場合は取り消して発行し直してください。</p>
      <form method="post" action="/t/${tag.id}/transfer/cancel"><button type="submit">譲渡コードを取り消す</button></form>
    </section>`;
  }
  return `<section class="panel">
    <h2>ケースを譲る・売る</h2>
    <p>譲渡コードを発行して相手に渡すと、相手がこのケースをかざして引き継げます。引き継がれると、あなたの暗証番号と持ち主だけの情報は消え、カード情報と来歴は残ります。</p>
    <form method="post" action="/t/${tag.id}/transfer"><button type="submit">譲渡コードを発行</button></form>
  </section>`;
}

// ================= 持ち主ログイン =================

function loginForm(env, tag, error) {
  return page(env, "持ち主の確認", `
    <h1>持ち主の確認</h1>
    <p class="lead">登録時に決めた暗証番号を入力してください。</p>
    ${errorBox(error)}
    <form method="post" action="/t/${tag.id}/login" class="stack">
      ${input("pin", "暗証番号", "", { type: "password", inputmode: "numeric", autocomplete: "current-password", required: true })}
      <button class="primary" type="submit">確認する</button>
    </form>
    <p><a href="/t/${tag.id}">← カード情報に戻る</a></p>`);
}

async function login(request, env, tag) {
  const form = await request.formData();
  const pin = String(form.get("pin") || "");
  const check = await checkLock(env, tag);
  if (check) return loginForm(env, tag, check);
  if (!(await verifyPin(pin, tag.pin_hash, tag.pin_salt))) {
    return loginForm(env, tag, await recordFail(env, tag, "暗証番号が違います。"));
  }
  await env.DB.prepare("UPDATE tags SET fail_count = 0, locked_until = 0 WHERE id = ?").bind(tag.id).run();
  return redirect(`/t/${tag.id}`, await sessionCookie(env, tag.id, tag.owner_gen));
}

// ================= 編集 =================

function editForm(env, tag, v, error) {
  return page(env, "情報を編集", `
    <h1>情報を編集</h1>
    ${errorBox(error)}
    <form method="post" action="/t/${tag.id}/edit" class="stack">
      ${cardFields(v)}
      <div class="row"><button class="primary" type="submit">保存する</button><a class="btn" href="/t/${tag.id}">キャンセル</a></div>
    </form>`);
}

async function saveEdit(request, env, tag) {
  const form = await request.formData();
  const v = readFields(form, [...PUBLIC_FIELDS, ...PRIVATE_FIELDS]);
  if (!v.name) return editForm(env, tag, v, "カード名を入力してください。");
  await env.DB.prepare(
    `UPDATE tags SET name = ?, set_no = ?, grader = ?, grade = ?, cert = ?, acquired = ?, source = ?, price = ?, place = ?, memo = ? WHERE id = ?`
  ).bind(v.name, v.set_no, v.grader, v.grade, v.cert, v.acquired, v.source, v.price, v.place, v.memo, tag.id).run();
  return redirect(`/t/${tag.id}?done=saved`);
}

// ================= 譲渡 =================

async function issueTransfer(env, tag) {
  const code = randomCode(10);
  const expires = Date.now() + TRANSFER_MS;
  await env.DB.prepare("UPDATE tags SET transfer_hash = ?, transfer_expires = ? WHERE id = ?")
    .bind(await sha256(code), expires, tag.id).run();
  return page(env, "譲渡コード", `
    <h1>譲渡コード</h1>
    <p class="lead">このコードを新しい持ち主に渡してください。この画面を閉じると再表示できません。</p>
    <p class="code mono">${code.slice(0, 5)}-${code.slice(5)}</p>
    <p class="hint">${fmtDate(new Date(expires).toISOString())} まで有効。相手はケースをかざして「このケースを譲り受けた方」から入力します。</p>
    <p><a class="btn" href="/t/${tag.id}">カード情報に戻る</a></p>`);
}

function receiveForm(env, tag, v, error) {
  return page(env, "ケースを引き継ぐ", `
    <h1>ケースを引き継ぐ</h1>
    <p class="lead">前の持ち主から受け取った譲渡コードを入力し、あなたの暗証番号を決めてください。カード情報と来歴はそのまま引き継がれます。</p>
    ${errorBox(error)}
    <form method="post" action="/t/${tag.id}/receive" class="stack">
      ${input("code", "譲渡コード", v.code || "", { autocomplete: "off", required: true, cls: "mono" })}
      ${input("pin", "新しい暗証番号（4〜8桁の数字）", "", { type: "password", inputmode: "numeric", autocomplete: "new-password", required: true })}
      ${input("pin2", "新しい暗証番号（確認）", "", { type: "password", inputmode: "numeric", autocomplete: "new-password", required: true })}
      <button class="primary" type="submit">引き継ぐ</button>
    </form>
    <p><a href="/t/${tag.id}">← カード情報に戻る</a></p>`);
}

async function receive(request, env, tag) {
  const form = await request.formData();
  const code = String(form.get("code") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const pin = String(form.get("pin") || "");
  const pin2 = String(form.get("pin2") || "");
  const keep = { code: String(form.get("code") || "") };

  const check = await checkLock(env, tag);
  if (check) return receiveForm(env, tag, keep, check);
  if (!tag.transfer_hash || !(tag.transfer_expires > Date.now()) || (await sha256(code)) !== tag.transfer_hash) {
    return receiveForm(env, tag, keep, await recordFail(env, tag, "譲渡コードが違うか、期限が切れています。前の持ち主に確認してください。"));
  }
  if (!PIN_RE.test(pin)) return receiveForm(env, tag, keep, "暗証番号は4〜8桁の数字にしてください。");
  if (pin !== pin2) return receiveForm(env, tag, keep, "確認用の暗証番号が一致しません。");

  const { hash, salt } = await hashPin(pin);
  const now = new Date().toISOString();
  const gen = tag.owner_gen + 1;
  const res = await env.DB.prepare(
    `UPDATE tags SET owner_gen = ?, claimed_at = ?, pin_hash = ?, pin_salt = ?, fail_count = 0, locked_until = 0,
       transfer_hash = NULL, transfer_expires = NULL, acquired = NULL, source = NULL, price = NULL, place = NULL, memo = NULL
     WHERE id = ? AND owner_gen = ? AND transfer_hash = ?`
  ).bind(gen, now, hash, salt, tag.id, tag.owner_gen, tag.transfer_hash).run();
  if (!res.meta.changes) return redirect(`/t/${tag.id}`);

  await addEvent(env, tag.id, "transferred", gen, now);
  return redirect(`/t/${tag.id}?done=received`, await sessionCookie(env, tag.id, gen));
}

// ================= 暗証番号・セッション =================

async function checkLock(env, tag) {
  if (tag.locked_until > Date.now()) {
    const min = Math.ceil((tag.locked_until - Date.now()) / 60000);
    return `入力の失敗が続いたため、一時的にロックしています。${min}分後にもう一度お試しください。`;
  }
  return "";
}

async function recordFail(env, tag, message) {
  const fails = tag.fail_count + 1;
  if (fails >= MAX_FAILS) {
    await env.DB.prepare("UPDATE tags SET fail_count = 0, locked_until = ? WHERE id = ?").bind(Date.now() + LOCK_MS, tag.id).run();
    return `${message} 失敗が${MAX_FAILS}回続いたため、15分間ロックします。`;
  }
  await env.DB.prepare("UPDATE tags SET fail_count = ? WHERE id = ?").bind(fails, tag.id).run();
  return `${message}（あと${MAX_FAILS - fails}回）`;
}

async function hashPin(pin, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}

async function verifyPin(pin, hash, salt) {
  if (!hash || !salt || !PIN_RE.test(pin)) return false;
  const h = await hashPin(pin, salt);
  return timingSafeEqual(h.hash, hash);
}

// セッションは「タグID.持ち主の代.期限」に署名したCookie。譲渡されると代が変わり、前の持ち主のログインは無効になる。
async function sessionCookie(env, id, gen) {
  const exp = Date.now() + SESSION_MS;
  const payload = `${id}.${gen}.${exp}`;
  const sig = await hmac(env.SESSION_SECRET, payload);
  return `s=${payload}.${sig}; Path=/t/${id}; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
}

function clearCookie(id) {
  return `s=; Path=/t/${id}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

async function isOwner(request, env, tag) {
  if (!tag.claimed_at) return false;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)s=([^;]+)/);
  if (!m) return false;
  const [id, gen, exp, sig] = m[1].split(".");
  if (id !== tag.id || Number(gen) !== tag.owner_gen || !(Number(exp) > Date.now())) return false;
  return timingSafeEqual(await hmac(env.SESSION_SECRET, `${id}.${gen}.${exp}`), sig || "");
}

async function hmac(secret, data) {
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))));
}

async function sha256(s) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function randomCode(n) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 0/O, 1/I は紛らわしいので除外
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const hexToBytes = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

async function addEvent(env, id, type, gen, at) {
  await env.DB.prepare("INSERT INTO events (tag_id, type, gen, at) VALUES (?, ?, ?, ?)").bind(id, type, gen, at).run();
}

// ================= HTML =================

function readFields(form, keys) {
  const v = {};
  for (const k of keys) {
    let s = String(form.get(k) || "").trim().slice(0, MAXLEN[k]);
    if (k === "grader" && s && !GRADERS.includes(s)) s = "その他";
    if (k === "acquired" && s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) s = "";
    v[k] = s || null;
  }
  return v;
}

function cardFields(v) {
  return `
    <fieldset class="stack">
      <legend>カード情報（誰でも見られます）</legend>
      ${input("name", "カード名", v.name, { required: true })}
      ${input("set_no", "セット・カード番号", v.set_no)}
      <div class="two">
        <label>鑑定会社<select name="grader">${GRADERS.map((g) => `<option${g === (v.grader || "PSA") ? " selected" : ""}>${g}</option>`).join("")}</select></label>
        ${input("grade", "グレード", v.grade, { inputmode: "decimal", placeholder: "10" })}
      </div>
      ${input("cert", "鑑定番号", v.cert, { inputmode: "numeric", cls: "mono" })}
    </fieldset>
    <fieldset class="stack">
      <legend>持ち主だけが見られる情報（任意）</legend>
      <div class="two">
        ${input("acquired", "入手日", v.acquired, { type: "date" })}
        ${input("price", "入手価格", v.price, { placeholder: "¥" })}
      </div>
      ${input("source", "入手先", v.source)}
      ${input("place", "保管場所", v.place)}
      <label>メモ<textarea name="memo" maxlength="${MAXLEN.memo}">${esc(v.memo)}</textarea></label>
    </fieldset>`;
}

function input(name, label, value, o = {}) {
  const attrs = [
    `name="${name}"`, `type="${o.type || "text"}"`, `value="${esc(value)}"`,
    o.inputmode ? `inputmode="${o.inputmode}"` : "", o.autocomplete ? `autocomplete="${o.autocomplete}"` : "",
    o.placeholder ? `placeholder="${esc(o.placeholder)}"` : "", o.required ? "required" : "",
    o.cls ? `class="${o.cls}"` : "", MAXLEN[name] ? `maxlength="${MAXLEN[name]}"` : "",
  ].filter(Boolean).join(" ");
  return `<label>${label}<input ${attrs}></label>`;
}

const dl = (k, v, mono) => (v ? `<dt>${k}</dt><dd${mono ? ' class="mono"' : ""}>${esc(v)}</dd>` : "");
const errorBox = (e) => (e ? `<div class="error" role="alert">${esc(e)}</div>` : "");

function fmtDate(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000); // 日本時間で表示
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function redirect(location, cookie) {
  const headers = { Location: location, "Cache-Control": "no-store" };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(null, { status: 303, headers });
}

function notFound(env) {
  return page(env, "見つかりません", `<h1>このタグは見つかりません</h1><p>URLが正しくないか、まだ発行されていないタグです。</p>`, 404);
}

function page(env, title, body, status = 200) {
  const brand = esc(env.BRAND_NAME || "カード台帳");
  return new Response(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} | ${brand}</title>
<style>${CSS}</style></head>
<body><header class="top">${brand}</header><main>${body}</main></body></html>`, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const CSS = `
:root{--bg:#F3F4F6;--surface:#fff;--fg:#15171C;--muted:#596070;--line:#DCDFE5;--accent:#1D5BC9;--accent-fg:#fff;--danger:#B42318;--ok:#1E6B46;--chip:#E7EDF8;
  --mono:ui-monospace,Menlo,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#121418;--surface:#1B1E24;--fg:#E8EAEE;--muted:#A0A7B4;--line:#2E333C;--accent:#7DA6F0;--accent-fg:#0E1420;--danger:#F08A80;--ok:#7CC4A0;--chip:#232C3D;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 "Hiragino Sans","Noto Sans JP","Yu Gothic",system-ui,sans-serif}
.top{padding:12px 16px;font-weight:700;font-size:13px;letter-spacing:.08em;color:var(--muted);border-bottom:1px solid var(--line);background:var(--surface)}
main{max-width:520px;margin:0 auto;padding:20px 16px 48px;display:flex;flex-direction:column;gap:18px}
h1{font-size:21px;line-height:1.35;margin:0}
h2{font-size:16px;margin:0 0 8px}
p{margin:0}
.lead{color:var(--muted)}
.hint{font-size:13px;color:var(--muted)}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.chip{background:var(--chip);font-size:13px;font-weight:700;padding:2px 10px;border-radius:999px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px}
.fields{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;margin:0}
.fields dt{color:var(--muted);font-size:13px}
.fields dd{margin:0;min-width:0;overflow-wrap:anywhere}
.memo{white-space:pre-wrap;overflow-wrap:anywhere}
.history{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.history li{display:flex;gap:16px;padding:10px 0;border-bottom:1px solid var(--line)}
.history time{color:var(--muted);font-size:13px;padding-top:2px}
.row{display:flex;gap:8px;flex-wrap:wrap}
.stack{display:flex;flex-direction:column;gap:12px}
fieldset{border:1px solid var(--line);border-radius:10px;padding:14px;margin:0;background:var(--surface)}
legend{font-weight:700;font-size:14px;padding:0 4px}
label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
input,select,textarea{font:inherit;font-size:16px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;min-height:44px;width:100%}
textarea{min-height:90px;resize:vertical}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:360px){.two{grid-template-columns:1fr}}
button,.btn{font:inherit;font-size:14px;font-weight:500;min-height:44px;padding:0 16px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--fg);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.error{border:1px solid var(--danger);color:var(--danger);border-radius:8px;padding:10px 12px;font-size:14px}
.notice{border:1px solid var(--ok);color:var(--ok);border-radius:8px;padding:10px 12px;font-size:14px}
.code{font-size:28px;letter-spacing:.12em;text-align:center;background:var(--surface);border:1px dashed var(--line);border-radius:10px;padding:18px}
`;
