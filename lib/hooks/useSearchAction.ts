import { useRef, useCallback } from 'react';
import { sortVideos } from '@/lib/utils/sort';
import { binaryInsertVideos } from '@/lib/utils/sorted-insert';
import { requestSearch } from '@/lib/utils/search-request';
import type { Video, VideoSource, SourceBadge } from '@/lib/types';
import type { SortOption } from '@/lib/store/settings-store';
import { settingsStore } from '@/lib/store/settings-store';
import { useSearchState } from './useSearchState';

type SearchState = ReturnType<typeof useSearchState>;
type SearchSourceConfig = { id: string; baseUrl?: string };

interface UseSearchActionProps {
    state: SearchState;
    onCacheUpdate: (query: string, results: Video[], sources: SourceBadge[]) => void;
    onUrlUpdate: (query: string) => void;
}

export function useSearchAction({ state, onCacheUpdate, onUrlUpdate }: UseSearchActionProps) {
    const {
        setLoading,
        setError,
        setResults,
        setAvailableSources,
        setCompletedSources,
        setTotalSources,
        setTotalVideosFound,
        setCurrentPage,
        setMaxPageCount,
        setLoadingMore,
        currentPage,
        maxPageCount,
        startSearch,
    } = state;

    const abortControllerRef = useRef<AbortController | null>(null);
    // Keep track of the last search params so loadMore can re-use them
    const lastSearchParamsRef = useRef<{ query: string; sources: VideoSource[]; sortBy: SortOption } | null>(null);

    const performSearch = useCallback(async (searchQuery: string, sources: VideoSource[] = [], sortBy: SortOption = 'default') => {
        if (!searchQuery.trim()) return;

        // Resolve sources if not provided
        let targetSources = sources;
        if (!targetSources || targetSources.length === 0) {
            const settings = settingsStore.getSettings();
            targetSources = settings.sources.filter(source => source.enabled !== false);
        }

        // Abort any ongoing search
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        const controller = new AbortController();
        abortControllerRef.current = controller;
        const isCurrent = () => abortControllerRef.current === controller && !controller.signal.aborted;

        // Reset state
        startSearch(searchQuery.trim());

        // Save search params for loadMore
        lastSearchParamsRef.current = { query: searchQuery.trim(), sources: targetSources, sortBy };

        // Update URL
        onUrlUpdate(searchQuery);

        try {
            const sourceConfigs = new Map<string, SearchSourceConfig>(
                targetSources.map((source: SearchSourceConfig) => [source.id, source])
            );
            const sourcesMap = new Map<string, { count: number; name: string; baseUrl?: string }>();
            const receivedVideos: Video[] = [];

            await requestSearch({
                sources: targetSources,
                signal: controller.signal,
                currentQuery: searchQuery.trim(),
                onStart: (total) => { if (isCurrent()) setTotalSources(total); },
                onVideos: (newVideos, sourceId) => {
                    if (!isCurrent()) return;
                    receivedVideos.push(...newVideos);
                    // Optimized: Insert new videos in sorted position
                    setResults((prev) => binaryInsertVideos(prev, newVideos));

                    // Update source stats (accumulate across pages)
                    const existing = sourcesMap.get(sourceId);
                    if (existing) {
                        existing.count += newVideos.length;
                    } else {
                        sourcesMap.set(sourceId, {
                            count: newVideos.length,
                            name: newVideos[0]?.sourceName || sourceId,
                            baseUrl: sourceConfigs.get(sourceId)?.baseUrl,
                        });
                    }
                },
                onProgress: (completed, found) => {
                    if (!isCurrent()) return;
                    setCompletedSources(completed);
                    setTotalVideosFound(found);
                },
                onPageInfo: (pageCount) => {
                    if (!isCurrent()) return;
                    setMaxPageCount((prev) => Math.max(prev, pageCount));
                },
                onComplete: () => {
                    if (!isCurrent()) return;
                    setLoading(false);

                    // Update available sources with correct property names
                    const sources = Array.from(sourcesMap.entries()).map(([id, info]) => ({
                        id: id,
                        name: info.name,
                        count: info.count,
                        ...(info.baseUrl ? { baseUrl: info.baseUrl } : {}),
                    }));
                    setAvailableSources(sources);

                    // Apply final sorting after all results are received
                    const sorted = sortVideos(receivedVideos, sortBy);
                    setResults(sorted);
                    onCacheUpdate(searchQuery.trim(), sorted, sources);
                },
                onError: (message) => {
                    if (!isCurrent()) return;
                    console.error('Search error:', message);
                    setError(message);
                    setLoading(false);
                },
            });

        } catch (error) {
            if (!isCurrent()) return;
            if (error instanceof Error && error.name === 'AbortError') {
                // Ignore abort errors and DO NOT set loading to false
                // because a new search might have already started
                return;
            } else {
                console.error('Search error:', error);
            }
            setError('搜索连接失败，请检查网络后重试');
            setLoading(false);
        }
    }, [startSearch, onUrlUpdate, onCacheUpdate, setTotalSources, setResults, setCompletedSources, setTotalVideosFound, setLoading, setError, setAvailableSources, setMaxPageCount]);

    const loadMore = useCallback(async () => {
        const params = lastSearchParamsRef.current;
        if (!params) return;

        const nextPage = currentPage + 1;
        if (nextPage > maxPageCount) return;

        // Abort any ongoing load-more (but not the main search)
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        const controller = new AbortController();
        abortControllerRef.current = controller;
        const isCurrent = () => abortControllerRef.current === controller && !controller.signal.aborted;

        setLoadingMore(true);

        try {
            await requestSearch({
                sources: params.sources,
                page: nextPage,
                signal: controller.signal,
                currentQuery: params.query,
                onStart: () => { },
                onVideos: (newVideos) => {
                    if (!isCurrent()) return;
                    // Append new videos to existing results
                    setResults((prev) => binaryInsertVideos(prev, newVideos));
                },
                onProgress: (_, found) => {
                    if (!isCurrent()) return;
                    setTotalVideosFound((prev) => prev + found);
                },
                onPageInfo: (pageCount) => {
                    if (!isCurrent()) return;
                    setMaxPageCount((prev) => Math.max(prev, pageCount));
                },
                onComplete: () => {
                    if (!isCurrent()) return;
                    setCurrentPage(nextPage);
                    setLoadingMore(false);
                },
                onError: (message) => {
                    if (!isCurrent()) return;
                    console.error('Load more error:', message);
                    setLoadingMore(false);
                },
            });

        } catch (error) {
            if (!isCurrent()) return;
            if (error instanceof Error && error.name === 'AbortError') {
                return;
            }
            console.error('Load more error:', error);
            setLoadingMore(false);
        }
    }, [currentPage, maxPageCount, setLoadingMore, setResults, setTotalVideosFound, setCurrentPage, setMaxPageCount]);

    const cancelSearch = useCallback(() => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        setLoading(false);
        setLoadingMore(false);
    }, [setLoading, setLoadingMore]);

    return { performSearch, loadMore, cancelSearch };
}
