import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { processSearchStream, type StreamHandlerParams } from '@/lib/utils/search-stream';
import { requestSearch } from '@/lib/utils/search-request';
import { POST } from '@/app/api/search-parallel/route';
import { fetchSourcesFromUrl } from '@/lib/utils/source-import-utils';
import { readSourceSubscription } from '@/lib/server/source-subscription';

const event = (data: object) => `data: ${JSON.stringify(data)}\r\n\r\n`;
const start = event({ type: 'start', totalSources: 1 });
const videos = event({ type: 'videos', source: 'test', videos: [{ vod_id: 1, vod_name: '小城良方', source: 'test' }] });
const complete = event({ type: 'complete', maxPageCount: 1 });

function capture() {
    const titles: string[] = [];
    const errors: string[] = [];
    let completions = 0;
    const handlers: Omit<StreamHandlerParams, 'reader'> = {
        currentQuery: '小城良方', onStart: () => {}, onProgress: () => {},
        onVideos: items => titles.push(...items.map(item => item.vod_name)),
        onComplete: () => { completions++; }, onError: message => errors.push(message),
    };
    return { handlers, titles, errors, completions: () => completions };
}

test('UTF-8 characters split across chunks and a final event without newline are retained', async () => {
    const bytes = new TextEncoder().encode(start + videos + complete.trim());
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
        if (index === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(index, ++index));
    } });
    const fixture = capture();
    await processSearchStream({ ...fixture.handlers, reader: stream.getReader() });
    assert.deepEqual(fixture.titles, ['小城良方']);
    assert.equal(fixture.completions(), 1);
});

test('an empty or truncated stream cannot complete or create a negative search cache', async () => {
    for (const text of ['', start, start + videos]) {
        const fixture = capture();
        await assert.rejects(processSearchStream({ ...fixture.handlers, reader: new Response(text).body!.getReader() }), /连接中断/);
        assert.equal(fixture.completions(), 0);
    }
});

test('a stalled connection is cancelled immediately once a complete event arrives', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(start + videos + complete)); },
        cancel() { cancelled = true; },
    });
    const fixture = capture();
    await processSearchStream({ ...fixture.handlers, reader: stream.getReader() });
    assert.equal(cancelled, true);
    assert.equal(fixture.completions(), 1);
});

test('a broken stream retries in buffered mode without duplicating partial results', async () => {
    const fixture = capture();
    const urls: string[] = [];
    const fetcher: typeof fetch = async input => {
        urls.push(String(input));
        return new Response(start + videos + (urls.length === 1 ? '' : complete));
    };
    await requestSearch({ ...fixture.handlers, sources: [], signal: new AbortController().signal, fetcher });
    assert.deepEqual(urls, ['/api/search-parallel', '/api/search-parallel?buffered=1']);
    assert.deepEqual(fixture.titles, ['小城良方']);
    assert.equal(fixture.completions(), 1);
    assert.deepEqual(fixture.errors, []);
});

test('network failures retry only once and show an error instead of no results', async () => {
    const fixture = capture();
    let requests = 0;
    await requestSearch({ ...fixture.handlers, sources: [], signal: new AbortController().signal,
        fetcher: async () => { requests++; throw new TypeError('Failed to fetch'); } });
    assert.equal(requests, 2);
    assert.equal(fixture.completions(), 0);
    assert.match(fixture.errors[0], /连接失败/);
});

test('cancelled searches never retry or publish completion/errors', async () => {
    const fixture = capture();
    const controller = new AbortController();
    let requests = 0;
    await assert.rejects(requestSearch({ ...fixture.handlers, sources: [], signal: controller.signal,
        fetcher: async () => { requests++; controller.abort(); throw new DOMException('aborted', 'AbortError'); } }), { name: 'AbortError' });
    assert.equal(requests, 1);
    assert.equal(fixture.completions(), 0);
    assert.deepEqual(fixture.errors, []);
});

test('a streaming timeout recovers with the buffered response', async () => {
    const fixture = capture();
    let requests = 0;
    await requestSearch({ ...fixture.handlers, sources: [], signal: new AbortController().signal, timeoutMs: 30,
        fetcher: async (_url, init) => {
            requests++;
            if (requests === 2) return new Response(start + videos + complete);
            return new Response(new ReadableStream({ start(controller) {
                init?.signal?.addEventListener('abort', () => controller.error(new DOMException('timeout', 'AbortError')), { once: true });
            } }));
        } });
    assert.equal(requests, 2);
    assert.deepEqual(fixture.titles, ['小城良方']);
});

test('authentication failures and server source failures are not retried as transport errors', async () => {
    for (const response of [new Response(null, { status: 401 }), new Response(event({ type: 'error', message: '视频源不可用' }))]) {
        const fixture = capture();
        let requests = 0;
        await requestSearch({ ...fixture.handlers, sources: [], signal: new AbortController().signal,
            fetcher: async () => { requests++; return response; } });
        assert.equal(requests, 1);
        assert.equal(fixture.completions(), 0);
        assert.equal(fixture.errors.length, 1);
    }
});

test('route distinguishes failed sources from genuinely empty searches in both response modes', async () => {
    const original = globalThis.fetch;
    try {
        for (const buffered of [false, true]) {
            for (const failed of [false, true]) {
                globalThis.fetch = async () => Response.json(failed ? { code: -1, msg: 'unavailable' } : { code: 1, list: [] });
                const response = await POST(new NextRequest(`https://example.com/api/search-parallel${buffered ? '?buffered=1' : ''}`, {
                    method: 'POST', body: JSON.stringify({ query: '小城良方', sources: [{ id: 'test', name: 'test', baseUrl: 'https://source.example', searchPath: '' }] }),
                }));
                const text = await response.text();
                assert.equal(text.includes('"type":"error"'), failed);
                assert.equal(text.includes('"type":"complete"'), !failed);
                assert.match(response.headers.get('cache-control')!, /no-store/);
            }
        }
    } finally { globalThis.fetch = original; }
});

test('subscription HTTP and parsing failures fall back to the same-origin proxy', async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    try {
        Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { host: 'example.com' } } });
        for (const initial of [new Response('unavailable', { status: 503 }), new Response('invalid json')]) {
            const urls: string[] = [];
            globalThis.fetch = async input => {
                urls.push(String(input));
                return urls.length === 1 ? initial : Response.json([{ id: 'test', name: '测试源', baseUrl: 'https://source.example' }]);
            };
            const result = await fetchSourcesFromUrl('https://subscription.example/list.json');
            assert.equal(result.normalSources.length, 1);
            assert.deepEqual(urls, ['https://subscription.example/list.json', '/api/source-subscription?url=https%3A%2F%2Fsubscription.example%2Flist.json']);
        }
    } finally {
        globalThis.fetch = originalFetch;
        if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
        else Reflect.deleteProperty(globalThis, 'window');
    }
});

test('subscription endpoint only returns parsed configured source JSON', async () => {
    const url = 'https://subscription.example/list.json';
    const request = () => new Request(`https://example.com/api/source-subscription?url=${encodeURIComponent(url)}`);
    const fetcher: typeof fetch = async () => Response.json([{ id: 'test', name: '测试源', baseUrl: 'https://source.example', unrelated: 'discard' }]);
    for (const config of [url, JSON.stringify([{ name: '站点订阅', url }])]) {
        const response = await readSourceSubscription(request(), config, fetcher);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).sources[0].unrelated, undefined);
    }
    let fetched = false;
    const response = await readSourceSubscription(request(), 'https://different.example/list.json', async () => { fetched = true; return new Response(); });
    assert.equal(response.status, 403);
    assert.equal(fetched, false);
});

test('subscription endpoint rejects non-JSON, invalid source lists and oversized payloads', async () => {
    const url = 'https://subscription.example/list.json';
    for (const body of ['#EXTM3U\nhttps://video.example/test.ts', '[]', 'x'.repeat(1024 * 1024 + 1)]) {
        const response = await readSourceSubscription(new Request(`https://example.com/api/source-subscription?url=${encodeURIComponent(url)}`), url, async () => new Response(body));
        assert.equal(response.status, 502);
        assert.equal((await response.json()).sources, undefined);
    }
});
