import { LOG_RETENTION_MS, type VideoAccessRecord } from './video-access-log';

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
}
export interface AccessLogDatabase {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<Array<{ meta: { changes?: number } }>>;
}

export interface VideoAccessStorage {
  clear(): Promise<void>;
  append(record: VideoAccessRecord): Promise<boolean>;
  query(params: URLSearchParams, now: number): Promise<{ records: VideoAccessRecord[]; total: number; page: number; pageSize: number }>;
}

export function createD1VideoAccessStorage(db: AccessLogDatabase): VideoAccessStorage {
  return {
    async clear() {
      // Retain rate-limit counters so deletion cannot bypass write limits.
      await db.batch([db.prepare('DELETE FROM video_access_log')]);
    },
    async append(record) {
      const minute = Math.floor(record.playedAt / 60_000);
      const statements = [
        db.prepare('INSERT INTO video_access_rate (ip, minute, count) VALUES (?, ?, 1) ON CONFLICT(ip, minute) DO UPDATE SET count = count + 1').bind(record.ip, minute),
        db.prepare(`INSERT INTO video_access_log (id, ip, video_id, title, source, episode_index, episode_name, premium, played_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count FROM video_access_rate WHERE ip = ? AND minute = ?) <= 60`)
          .bind(record.id, record.ip, record.videoId, record.title, record.source, record.episodeIndex, record.episodeName, record.premium ? 1 : 0, record.playedAt, record.ip, minute),
        db.prepare('DELETE FROM video_access_log WHERE played_at <= ?').bind(record.playedAt - LOG_RETENTION_MS),
        db.prepare('DELETE FROM video_access_log WHERE id IN (SELECT id FROM video_access_log ORDER BY played_at DESC, id DESC LIMIT -1 OFFSET 10000)'),
        db.prepare('DELETE FROM video_access_rate WHERE minute < ?').bind(minute - 1),
      ];
      // D1 batch is transactional: concurrent requests cannot bypass the rate limit.
      const results = await db.batch(statements);
      return results[1].meta.changes === 1;
    },
    async query(params, now) {
      const ip = (params.get('ip') || '').trim();
      const title = (params.get('title') || '').trim().slice(0, 200);
      const page = Math.max(1, Math.min(200, Math.floor(Number(params.get('page')) || 1)));
      const where = 'played_at > ? AND (? = \'\' OR ip = ?) AND (? = \'\' OR instr(lower(title), lower(?)) > 0)';
      const values = [now - LOG_RETENTION_MS, ip, ip, title, title];
      const count = await db.prepare(`SELECT COUNT(*) AS total FROM video_access_log WHERE ${where}`).bind(...values).first<{ total: number }>();
      const rows = await db.prepare(`SELECT id, ip, video_id AS videoId, title, source, episode_index AS episodeIndex,
        episode_name AS episodeName, premium, played_at AS playedAt FROM video_access_log WHERE ${where}
        ORDER BY played_at DESC, id DESC LIMIT 50 OFFSET ?`).bind(...values, (page - 1) * 50).all<Omit<VideoAccessRecord, 'premium'> & { premium: number }>();
      return { records: rows.results.map(row => ({ ...row, premium: row.premium === 1 })), total: count?.total || 0, page, pageSize: 50 };
    },
  };
}

