-- NFCケース台帳 データベース定義（Cloudflare D1 / SQLite）

-- タグ1枚 = ケース1個。出荷前に id だけ入れておき、購入者が初回タップで登録する。
CREATE TABLE IF NOT EXISTS tags (
  id               TEXT PRIMARY KEY,          -- シールに書き込むURLの末尾（例 7F3K9QHM）
  created_at       TEXT NOT NULL,             -- タグ発行日時
  claimed_at       TEXT,                      -- 今の持ち主が登録した日時（NULL = 未登録）
  owner_gen        INTEGER NOT NULL DEFAULT 0,-- 何代目の持ち主か
  pin_hash         TEXT,                      -- 暗証番号のハッシュ
  pin_salt         TEXT,
  fail_count       INTEGER NOT NULL DEFAULT 0,-- 暗証番号の連続失敗回数
  locked_until     INTEGER NOT NULL DEFAULT 0,-- ロック解除時刻（ミリ秒）
  transfer_hash    TEXT,                      -- 譲渡コードのハッシュ
  transfer_expires INTEGER,                   -- 譲渡コードの期限（ミリ秒）

  -- 公開情報（誰がかざしても見える）
  name     TEXT,   -- カード名
  set_no   TEXT,   -- セット・カード番号
  grader   TEXT,   -- 鑑定会社
  grade    TEXT,   -- グレード
  cert     TEXT,   -- 鑑定番号

  -- 持ち主だけが見られる情報
  acquired TEXT,   -- 入手日
  source   TEXT,   -- 入手先
  price    TEXT,   -- 入手価格
  place    TEXT,   -- 保管場所
  memo     TEXT
);

-- 来歴（登録・譲渡の記録）。誰がかざしても日付と代数が見える。
CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id TEXT NOT NULL,
  type   TEXT NOT NULL,   -- registered / transferred / reset
  gen    INTEGER,
  at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_tag ON events(tag_id, id);
