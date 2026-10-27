import { parseSourcesFromJson } from '@/lib/utils/source-import-utils';

const MAX_SUBSCRIPTION_BYTES = 1024 * 1024;

function configuredUrls(raw: string): string[] {
    try {
        const entries: unknown = JSON.parse(raw);
        if (Array.isArray(entries)) {
            return entries.flatMap(entry => entry && typeof entry.url === 'string' ? [entry.url.trim()] : []);
        }
    } catch { /* A comma-separated URL list is also supported. */ }
    return raw.split(',').map(url => url.trim()).filter(Boolean);
}

/** Only reads configured source-list JSON; this is not a media or arbitrary URL proxy. */
export async function readSourceSubscription(request: Request, rawConfig: string, fetcher: typeof fetch = fetch): Promise<Response> {
    const respond = (body: object, status = 200) => Response.json(body, {
        status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
    const url = new URL(request.url).searchParams.get('url') || '';
    if (!configuredUrls(rawConfig).includes(url)) return respond({ error: '订阅不在站点配置中' }, 403);
    try {
        if (!['http:', 'https:'].includes(new URL(url).protocol)) return respond({ error: '无效订阅地址' }, 400);
    } catch { return respond({ error: '无效订阅地址' }, 400); }

    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) controller.abort();
    const timer = setTimeout(abort, 12000);
    try {
        const response = await fetcher(url, { signal: controller.signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!response.ok || !response.body) throw new Error('Subscription unavailable');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = '';
        let bytes = 0;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > MAX_SUBSCRIPTION_BYTES) throw new Error('Subscription too large');
                text += decoder.decode(value, { stream: true });
            }
            text += decoder.decode();
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
        const parsed = parseSourcesFromJson(text);
        if (!parsed.totalCount) throw new Error('No valid sources');
        return respond({ sources: [...parsed.normalSources, ...parsed.premiumSources] });
    } catch {
        return respond({ error: '视频源列表暂时无法读取，请重试' }, 502);
    } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', abort);
        controller.abort();
    }
}
