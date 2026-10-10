import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createD1VideoAccessStorage, type AccessLogDatabase, type D1Statement } from '@/lib/server/video-access-storage';
import { LOG_RETENTION_MS, type VideoAccessRecord } from '@/lib/server/video-access-log';

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('migrations/0001_video_access.sql', 'utf8'));
  class Statement implements D1Statement {
    constructor(readonly sql: string, readonly values: Array<string | number> = []) {}
    bind(...values: unknown[]) { return new Statement(this.sql, values as Array<string | number>); }
    async all<T>() { return { results: sqlite.prepare(this.sql).all(...this.values) as T[] }; }
    async first<T>() { return (sqlite.prepare(this.sql).get(...this.values) as T) || null; }
  }
  const adapter: AccessLogDatabase = {
    prepare: sql => new Statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(value => {
          const statement = value as Statement;
          const result = sqlite.prepare(statement.sql).run(...statement.values);
          return { meta: { changes: Number(result.changes) } };
        });
        sqlite.exec('COMMIT'); return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { sqlite, store: createD1VideoAccessStorage(adapter) };
}

function record(id: string, playedAt: number): VideoAccessRecord {
  return { id, playedAt, videoId: 'v', title: '测试视频', ip: '192.0.2.1', source: 's', episodeIndex: 0, episodeName: '第一集', premium: false };
}

test('D1 clear removes all logs, preserves rate limits and other data, and allows new events', async () => {
  const { sqlite, store } = setup();
  try {
    const now = Date.now();
    sqlite.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep')");
    await store.append(record('first', now));
    await store.append({ ...record('other', now), ip: '192.0.2.2', title: '其他视频' });
    await store.clear();
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM video_access_log').get()?.count, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM video_access_rate').get()?.count, 2);
    assert.equal(sqlite.prepare('SELECT value FROM unrelated').get()?.value, 'keep');
    assert.equal((await store.query(new URLSearchParams(), now)).total, 0);
    await store.clear();
    assert.equal(await store.append(record('new', now)), true);
    assert.equal((await store.query(new URLSearchParams(), now)).records[0].id, 'new');
  } finally { sqlite.close(); }
});

test('D1 persists metadata, filters and paginates without mixing IPs', async () => {
  const { sqlite, store } = setup();
  try {
    const now = Date.now();
    for (let index = 0; index < 55; index++) assert.equal(await store.append(record(String(index), now + index)), true);
    await store.append({ ...record('other', now), ip: '192.0.2.2', title: '其他视频', premium: true });
    const result = await store.query(new URLSearchParams({ ip: '192.0.2.1', title: '测试', page: '2' }), now);
    assert.equal(result.total, 55); assert.equal(result.records.length, 5);
    assert.equal(result.records[0].id, '4'); assert.equal(result.records[0].premium, false);
    const other = await store.query(new URLSearchParams({ ip: '192.0.2.2' }), now);
    assert.equal(other.records[0].premium, true);
  } finally { sqlite.close(); }
});

test('D1 atomically limits each IP to 60 events/minute and resets next minute', async () => {
  const { sqlite, store } = setup();
  try {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    for (let index = 0; index < 60; index++) assert.equal(await store.append(record(String(index), now)), true);
    assert.equal(await store.append(record('limited', now)), false);
    assert.equal((await store.query(new URLSearchParams(), now)).total, 60);
    assert.equal(await store.append(record('next-minute', now + 60_000)), true);
    assert.equal(await store.append({ ...record('different-ip', now), ip: '192.0.2.2' }), true);
  } finally { sqlite.close(); }
});

test('D1 excludes expired rows even before a new write and cleans them on append', async () => {
  const { sqlite, store } = setup();
  try {
    const now = Date.now();
    await store.append(record('old', now - LOG_RETENTION_MS));
    assert.equal((await store.query(new URLSearchParams(), now)).total, 0);
    await store.append(record('new', now));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM video_access_log').get()?.count, 1);
    assert.equal((await store.query(new URLSearchParams(), now)).records[0].id, 'new');
  } finally { sqlite.close(); }
});

test('D1 keeps the newest 10,000 records', async () => {
  const { sqlite, store } = setup();
  try {
    const now = Date.now();
    const insert = sqlite.prepare('INSERT INTO video_access_log VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    sqlite.exec('BEGIN');
    for (let index = 0; index < 10000; index++) insert.run(String(index), '192.0.2.1', 'v', 'Movie', 's', 0, '', 0, now - index - 1);
    sqlite.exec('COMMIT');
    await store.append(record('newest', now));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM video_access_log').get()?.count, 10000);
    assert.equal(sqlite.prepare('SELECT id FROM video_access_log WHERE id = ?').get('9999'), undefined);
  } finally { sqlite.close(); }
});
