import type { Redis } from '@upstash/redis/cloudflare';
import type { ServerAuthSession, AccountInfo } from './auth';

export const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const LOG_MAX_RECORDS = 10_000;
const LOG_KEY = 'video:access:v1';

export async function clearVideoAccessLog(redis: Redis): Promise<void> {
  await redis.del(LOG_KEY);
}

export interface VideoAccessInput {
  videoId: string;
  title: string;
  source: string;
  episodeIndex: number;
  episodeName: string;
  premium: boolean;
}

export interface VideoAccessRecord extends VideoAccessInput {
  id: string;
  ip: string;
  playedAt: number;
}

export function normalizeIp(value: string | null): string | null {
  if (!value || value.length > 64) return null;
  if (value.includes(':')) {
    if (!/^[0-9a-f:.]+$/i.test(value)) return null;
    try {
      return new URL(`http://[${value}]/`).hostname.slice(1, -1);
    } catch { return null; }
  }
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
    ? value : null;
}

export function readCloudflareIp(headers: Headers): string | null {
  return normalizeIp(headers.get('cf-connecting-ipv6')) || normalizeIp(headers.get('cf-connecting-ip'));
}

export function parseVideoAccessInput(body: unknown): VideoAccessInput | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  for (const key of ['videoId', 'title', 'source', 'episodeName']) {
    const value = input[key];
    if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f]/.test(value)) return null;
  }
  if (!(input.videoId as string).trim() || !(input.title as string).trim() || !(input.source as string).trim()) return null;
  if (!Number.isInteger(input.episodeIndex) || Number(input.episodeIndex) < 0 || Number(input.episodeIndex) > 100_000) return null;
  if (typeof input.premium !== 'boolean') return null;
  // Whitelist fields: IP, timestamp, identity and role never come from the browser.
  return {
    videoId: (input.videoId as string).trim(), title: (input.title as string).trim(),
    source: (input.source as string).trim(), episodeName: (input.episodeName as string).trim(),
    episodeIndex: input.episodeIndex as number, premium: input.premium,
  };
}

export function canReadVideoAccessLog(session: ServerAuthSession | null, accounts: AccountInfo[], now: number): boolean {
  if (!session || !Number.isFinite(session.iat) || session.iat > now || now - session.iat > LOG_RETENTION_MS) return false;
  if (session.role !== 'admin' && session.role !== 'super_admin') return false;
  const current = accounts.find(account => account.id === session.accountId ||
    (session.mode === 'legacy' && account.username === session.username && session.accountId === `legacy:${account.username}`));
  return !!current && (current.role === 'admin' || current.role === 'super_admin');
}

// Rate limiting, append and pruning happen atomically, including on concurrent edge requests.
export const APPEND_ACCESS_LOG_SCRIPT = `
local count = redis.call('INCR', KEYS[2])
if count == 1 then redis.call('EXPIRE', KEYS[2], 120) end
if count > 60 then return 0 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -10001)
redis.call('EXPIRE', KEYS[1], 2592000)
return 1
`;

export async function appendVideoAccessLog(redis: Redis, record: VideoAccessRecord): Promise<boolean> {
  const minute = Math.floor(record.playedAt / 60_000);
  const result = await redis.eval(APPEND_ACCESS_LOG_SCRIPT,
    [LOG_KEY, `video:access:rate:${record.ip}:${minute}`],
    [record.playedAt, JSON.stringify(record), record.playedAt - LOG_RETENTION_MS]);
  return result === 1;
}

export async function queryVideoAccessLog(redis: Redis, params: URLSearchParams, now: number) {
  const ipFilter = params.get('ip')?.trim() || '';
  const ip = ipFilter ? normalizeIp(ipFilter) : null;
  if (ipFilter && !ip) throw new Error('请输入完整的 IPv4 或 IPv6 地址');
  const title = (params.get('title') || '').trim().slice(0, 200).toLowerCase();
  const page = Math.max(1, Math.min(200, Math.floor(Number(params.get('page')) || 1)));
  const records = await redis.zrange<VideoAccessRecord[]>(LOG_KEY, now - LOG_RETENTION_MS + 1, '+inf', { byScore: true });
  const filtered = records.filter(record => (!ip || record.ip === ip) && (!title || record.title.toLowerCase().includes(title)))
    .sort((a, b) => b.playedAt - a.playedAt || b.id.localeCompare(a.id));
  return { records: filtered.slice((page - 1) * 50, page * 50), total: filtered.length, page, pageSize: 50 };
}
