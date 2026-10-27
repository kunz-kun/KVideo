import { Video } from '@/lib/types';
import { getSourceName } from '@/lib/utils/source-names';
import { calculateRelevanceScore, hasMinimumMatch } from '@/lib/utils/search';
import { settingsStore } from '@/lib/store/settings-store';

/**
 * Check if a video's category matches any blocked keyword.
 */
type SearchVideo = Video & { vod_class?: string; sourceDisplayName?: string };

function isCategoryBlocked(video: SearchVideo, blockedCategories: string[]): boolean {
    if (blockedCategories.length === 0) return false;
    const typeName = (video.type_name || video.vod_class || '').toLowerCase();
    return blockedCategories.some(cat => typeName.includes(cat.toLowerCase()));
}

export interface StreamHandlerParams {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    onStart: (totalSources: number) => void;
    onVideos: (videos: Video[], source: string) => void;
    onProgress: (completedSources: number, totalVideosFound: number) => void;
    onComplete: () => void;
    onError: (message: string) => void;
    onPageInfo?: (maxPageCount: number) => void;
    currentQuery: string;
}

export async function processSearchStream({
    reader,
    onStart,
    onVideos,
    onProgress,
    onComplete,
    onError,
    onPageInfo,
    currentQuery,
}: StreamHandlerParams) {
    const decoder = new TextDecoder();
    let buffer = '';
    let isCompleted = false;

    const blockedCategories = settingsStore.getSettings().blockedCategories;

    const processLine = (line: string) => {
            if (!line.startsWith('data:')) return;

            const data = JSON.parse(line.slice(5).trim());

            if (data.type === 'start') {
                onStart(data.totalSources);
            } else if (data.type === 'videos') {
                const newVideos: Video[] = data.videos
                    .filter((video: SearchVideo) => hasMinimumMatch(video.vod_name, currentQuery))
                    .filter((video: SearchVideo) => !isCategoryBlocked(video, blockedCategories))
                    .map((video: SearchVideo) => ({
                        ...video,
                        sourceName: video.sourceDisplayName || getSourceName(video.source),
                        isNew: true,
                        relevanceScore: calculateRelevanceScore(video, currentQuery),
                    }));
                onVideos(newVideos, data.source);
                if (data.pagecount && onPageInfo) onPageInfo(data.pagecount);
            } else if (data.type === 'progress') {
                onProgress(data.completedSources, data.totalVideosFound);
            } else if (data.type === 'complete') {
                isCompleted = true;
                if (data.maxPageCount && onPageInfo) onPageInfo(data.maxPageCount);
                onComplete();
            } else if (data.type === 'error') {
                isCompleted = true;
                onError(data.message);
            }
    };

    try {
      while (!isCompleted) {
        const { done, value } = await reader.read();
        if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) processLine(buffer);
            if (!isCompleted) {
                throw new Error('搜索连接中断，请重试');
            }
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            processLine(line);
            if (isCompleted) break;
        }
      }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
