import { processSearchStream, type StreamHandlerParams } from './search-stream';

class SearchServerError extends Error {}

type SearchRequestOptions = Omit<StreamHandlerParams, 'reader'> & {
    sources: unknown[];
    page?: number;
    signal: AbortSignal;
    fetcher?: typeof fetch;
    timeoutMs?: number;
};

/** Retry a broken streaming connection once using a fully buffered response. */
export async function requestSearch({
    sources, page = 1, signal, fetcher = fetch, timeoutMs = 35000, ...handlers
}: SearchRequestOptions): Promise<void> {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt++) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(abort, timeoutMs);
        try {
            const response = await fetcher(attempt ? '/api/search-parallel?buffered=1' : '/api/search-parallel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: handlers.currentQuery, sources, page }),
                signal: controller.signal,
                cache: 'no-store',
            });
            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    throw new SearchServerError('登录状态已失效，请刷新页面后重新登录');
                }
                throw new Error(`搜索请求失败 (${response.status})，请重试`);
            }
            // The second request does not depend on browser streaming support.
            const reader = attempt
                ? new Response(await response.text()).body!.getReader()
                : response.body?.getReader();
            if (!reader) throw new Error('浏览器未能读取搜索响应，请重试');
            await processSearchStream({
                ...handlers,
                reader,
                onVideos: (videos, source) => {
                    const unique = videos.filter(video => {
                        const key = JSON.stringify([video.source || source, video.vod_id]);
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    });
                    if (unique.length) handlers.onVideos(unique, source);
                },
                onError: message => { throw new SearchServerError(message); },
            });
            return;
        } catch (error) {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            if (error instanceof SearchServerError || attempt === 1) {
                handlers.onError(error instanceof SearchServerError ? error.message : '搜索连接失败，请检查网络后重试');
                return;
            }
        } finally {
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
            controller.abort();
        }
    }
}
