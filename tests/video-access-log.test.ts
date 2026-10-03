import test from 'node:test';
import assert from 'node:assert/strict';
import type { Redis } from '@upstash/redis/cloudflare';
import type { AccountInfo, ServerAuthSession } from '@/lib/server/auth';
import {
  canReadVideoAccessLog, LOG_RETENTION_MS, normalizeIp, parseVideoAccessInput,
  readCloudflareIp, queryVideoAccessLog, type VideoAccessRecord,
} from '@/lib/server/video-access-log';

const now = Date.now();
const session: ServerAuthSession = {
  accountId: 'a', profileId: 'a', role: 'admin', name: 'Admin', customPermissions: [], mode: 'managed', iat: now,
};
const account: AccountInfo = { id: 'a', username: 'admin', name: 'Admin', role: 'admin', customPermissions: [], createdAt: now, updatedAt: now };

test('access logs reject anonymous, viewers, expired sessions and demoted/deleted admins', () => {
  assert.equal(canReadVideoAccessLog(null, [account], now), false);
  assert.equal(canReadVideoAccessLog({ ...session, role: 'viewer' }, [account], now), false);
  assert.equal(canReadVideoAccessLog(session, [], now), false);
  assert.equal(canReadVideoAccessLog(session, [{ ...account, role: 'viewer' }], now), false);
  assert.equal(canReadVideoAccessLog({ ...session, iat: now - LOG_RETENTION_MS - 1 }, [account], now), false);
  assert.equal(canReadVideoAccessLog({ ...session, iat: now + 1 }, [account], now), false);
  assert.equal(canReadVideoAccessLog(session, [account], now), true);
  assert.equal(canReadVideoAccessLog({ ...session, role: 'super_admin' }, [{ ...account, role: 'super_admin' }], now), true);
  assert.equal(canReadVideoAccessLog({ ...session, mode: 'legacy', accountId: 'legacy:admin', username: 'admin' }, [{ ...account, id: 'legacy-1' }], now), true);
  assert.equal(canReadVideoAccessLog({ ...session, mode: 'legacy', accountId: 'legacy:admin', username: 'admin' }, [{ ...account, id: 'legacy-1', role: 'viewer' }], now), false);
});

test('metadata cannot supply IP, timestamp or role and malformed fields are rejected', () => {
  const valid = { videoId: '123', title: '测试视频', source: 'source-1', episodeIndex: 0, episodeName: '第1集', premium: false };
  assert.deepEqual(parseVideoAccessInput({ ...valid, ip: '1.1.1.1', playedAt: 0, role: 'admin' }), valid);
  assert.equal(parseVideoAccessInput({ ...valid, episodeIndex: -1 }), null);
  assert.equal(parseVideoAccessInput({ ...valid, episodeIndex: 1.2 }), null);
  assert.equal(parseVideoAccessInput({ ...valid, title: 'x'.repeat(201) }), null);
  assert.equal(parseVideoAccessInput({ ...valid, source: ' ' }), null);
  assert.equal(parseVideoAccessInput({ ...valid, premium: 'true' }), null);
  assert.equal(parseVideoAccessInput(null), null);
});

test('IP extraction uses CF IPv6/IPv4 and ignores forwarded/browser-supplied values', () => {
  assert.equal(readCloudflareIp(new Headers({ 'x-forwarded-for': '1.1.1.1' })), null);
  assert.equal(readCloudflareIp(new Headers({ 'cf-connecting-ip': '192.0.2.1', 'cf-connecting-ipv6': '2001:0db8:0:0:0:0:0:1' })), '2001:db8::1');
  assert.equal(normalizeIp('999.1.1.1'), null);
  assert.equal(normalizeIp('1.1.1.1, 2.2.2.2'), null);
  assert.equal(normalizeIp('::zz'), null);
  assert.equal(normalizeIp('::1]/#'), null);
  assert.equal(normalizeIp('01.2.3.4'), null);
});

test('queries apply exact IP and title filters before pagination, including canonical IPv6', async () => {
  const records: VideoAccessRecord[] = Array.from({ length: 55 }, (_, index) => ({
    id: String(index), videoId: '123', title: 'Test Movie', source: 's', episodeIndex: index,
    episodeName: '', premium: false, ip: '2001:db8::1', playedAt: now - index,
  }));
  records.push({ ...records[0], id: 'other', ip: '192.0.2.1', title: 'Other Movie' });
  const redis = { zrange: async (_key: string, min: number, max: string, options: unknown) => {
    assert.equal(min, now - LOG_RETENTION_MS + 1);
    assert.equal(max, '+inf'); assert.deepEqual(options, { byScore: true }); return records;
  } } as unknown as Redis;
  const result = await queryVideoAccessLog(redis, new URLSearchParams({ ip: '2001:0db8::1', title: 'test', page: '2' }), now);
  assert.equal(result.total, 55); assert.equal(result.records.length, 5);
  assert.equal(result.records[0].episodeIndex, 50);
  await assert.rejects(queryVideoAccessLog(redis, new URLSearchParams({ ip: 'invalid' }), now));
});
