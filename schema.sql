-- hfpc-feedback D1 schema(可重複執行)
CREATE TABLE IF NOT EXISTS likes (
  g TEXT PRIMARY KEY,            -- 作品 id(同 play-stats 的 g,詩歌 = hymn-<slug>)
  n INTEGER NOT NULL DEFAULT 0,
  title TEXT                     -- 後台顯示用(widget 帶 data-title)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  g TEXT NOT NULL,
  title TEXT,
  name TEXT,                     -- 暱稱(自由模式才有,最多 20 字)
  text TEXT NOT NULL,            -- 留言(最多 300 字)
  preset INTEGER NOT NULL DEFAULT 0,   -- 1 = 預設短語(兒童站)
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_g_status ON comments(g, status, id);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status, id);
-- 防灌:同 IP 雜湊的短期鎖(只存雜湊 + 到期秒,不存 IP)
CREATE TABLE IF NOT EXISTS rate (
  k TEXT PRIMARY KEY,
  exp INTEGER NOT NULL
);
