-- SwimTrack D1 初始化
-- 按账号存储（每条账号一行），避免单值超过 D1 的 1MB 限制；store 内存模型为 { users: { [account]: {...} } }
CREATE TABLE IF NOT EXISTS accounts (
  account TEXT PRIMARY KEY,
  data    TEXT NOT NULL
);
