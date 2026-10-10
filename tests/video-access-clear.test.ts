import test from 'node:test';
import assert from 'node:assert/strict';
import { clearVideoAccessRecords } from '@/lib/server/video-access-clear';
import type { AccountInfo, ServerAuthSession } from '@/lib/server/auth';
import type { VideoAccessStorage } from '@/lib/server/video-access-storage';
import { LOG_RETENTION_MS } from '@/lib/server/video-access-log';

const now = Date.now();
const session: ServerAuthSession = { accountId: 'a', profileId: 'a', name: 'Admin', role: 'admin', customPermissions: [], mode: 'managed', iat: now };
const account: AccountInfo = { id: 'a', username: 'admin', name: 'Admin', role: 'admin', customPermissions: [], createdAt: now, updatedAt: now };
const validHeaders = { origin: 'https://video.example', 'X-KVideo-Clear-Logs': 'all' };

function setup(currentSession: ServerAuthSession | null = session, accounts = [account], fail = false, missing = false) {
  let calls = 0;
  const storage = { clear: async () => { calls++; if (fail) throw new Error('offline'); } } as VideoAccessStorage;
  return {
    calls: () => calls,
    run: (headers: Record<string, string> = validHeaders) => clearVideoAccessRecords(
      new Request('https://video.example/api/admin/video-access?ip=192.0.2.1', { method: 'DELETE', headers }),
      { getSession: async () => currentSession, listAccounts: async () => accounts, getStorage: () => missing ? null : storage },
    ),
  };
}

test('anonymous, viewer, demoted/deleted admins and expired sessions cannot delete', async () => {
  for (const [current, accounts, status] of [
    [null, [account], 401],
    [{ ...session, role: 'viewer' }, [account], 403],
    [session, [{ ...account, role: 'viewer' }], 403],
    [session, [], 403],
    [{ ...session, iat: now - LOG_RETENTION_MS - 1 }, [account], 403],
  ] as Array<[ServerAuthSession | null, AccountInfo[], number]>) {
    const fixture = setup(current, accounts);
    assert.equal((await fixture.run()).status, status);
    assert.equal(fixture.calls(), 0);
  }
});

test('cross-origin, absent origin and absent intent header cannot delete', async () => {
  const attempts: Array<Record<string, string>> = [{ ...validHeaders, origin: 'https://evil.example' }, { 'X-KVideo-Clear-Logs': 'all' }, { origin: validHeaders.origin }];
  for (const headers of attempts) {
    const fixture = setup();
    assert.equal((await fixture.run(headers)).status, 403);
    assert.equal(fixture.calls(), 0);
  }
});

test('admin and super_admin can clear regardless of filters, with a no-store response', async () => {
  for (const role of ['admin', 'super_admin'] as const) {
    const fixture = setup({ ...session, role }, [{ ...account, role }]);
    const response = await fixture.run();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cleared: true });
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(fixture.calls(), 1);
  }
});

test('missing or failed storage returns an error without claiming success', async () => {
  for (const fixture of [setup(session, [account], false, true), setup(session, [account], true)]) {
    const response = await fixture.run();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).cleared, undefined);
  }
});
