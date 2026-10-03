CREATE TABLE IF NOT EXISTS video_access_log (
  id TEXT PRIMARY KEY,
  ip TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  episode_index INTEGER NOT NULL,
  episode_name TEXT NOT NULL,
  premium INTEGER NOT NULL DEFAULT 0,
  played_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS video_access_log_time ON video_access_log (played_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS video_access_log_ip_time ON video_access_log (ip, played_at DESC);
CREATE TABLE IF NOT EXISTS video_access_rate (
  ip TEXT NOT NULL,
  minute INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (ip, minute)
);
