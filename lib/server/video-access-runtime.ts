import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { getRedisClient } from './redis';
import { appendVideoAccessLog, queryVideoAccessLog, clearVideoAccessLog } from './video-access-log';
import { createD1VideoAccessStorage, type AccessLogDatabase, type VideoAccessStorage } from './video-access-storage';

export function getVideoAccessStorage(): VideoAccessStorage | null {
  const env = getOptionalRequestContext()?.env as unknown as Record<string, unknown> | undefined;
  const db = env?.VIDEO_ACCESS_DB as AccessLogDatabase | undefined;
  if (db) return createD1VideoAccessStorage(db);
  const redis = getRedisClient();
  return redis ? { clear: () => clearVideoAccessLog(redis), append: record => appendVideoAccessLog(redis, record), query: (params, now) => queryVideoAccessLog(redis, params, now) } : null;
}
