import { useCallback, useEffect, useRef, useState } from 'react';
import { settingsStore } from '@/lib/store/settings-store';
import { fetchSourcesFromUrl, mergeSources, type ImportResult } from '@/lib/utils/source-import-utils';

const SYNC_COOLDOWN_MS = 5 * 60 * 1000;
// PasswordGate and the home page can mount together. Share only in-flight downloads.
const downloads = new Map<string, Promise<ImportResult>>();

function download(url: string) {
    let pending = downloads.get(url);
    if (!pending) {
        pending = fetchSourcesFromUrl(url).finally(() => downloads.delete(url));
        downloads.set(url, pending);
    }
    return pending;
}

export function useSubscriptionSync() {
    const [syncing, setSyncing] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const refreshRef = useRef<() => void>(() => {});
    const refresh = useCallback(() => refreshRef.current(), []);

    useEffect(() => {
        let mounted = true;
        let running = false;
        let pending = false;
        let forceNext = false;
        let timer: ReturnType<typeof setTimeout>;

        const sync = async () => {
            if (running) { pending = true; return; }
            running = true;
            const settings = settingsStore.getSettings();
            const force = forceNext;
            forceNext = false;
            const hasSources = settings.sources.length + settings.premiumSources.length > 0;
            const subscriptions = settings.subscriptions.filter(sub =>
                sub.autoRefresh !== false && (force || !hasSources || !sub.lastUpdated || Date.now() - sub.lastUpdated >= SYNC_COOLDOWN_MS)
            );
            if (mounted) { setSyncing(subscriptions.length > 0); setError(null); }
            try {
                const results = await Promise.allSettled(subscriptions.map(sub => download(sub.url)));
                if (!mounted) return;
                // Merge into the latest settings; a download must not overwrite user edits.
                const latest = settingsStore.getSettings();
                let normal = latest.sources;
                let premium = latest.premiumSources;
                let updated = latest.subscriptions;
                let changed = false;
                let failed = false;
                results.forEach((result, index) => {
                    if (result.status === 'rejected') { failed = true; return; }
                    if (result.value.totalCount === 0) { failed = true; return; }
                    const sub = subscriptions[index];
                    if (!updated.some(item => item.id === sub.id && item.url === sub.url)) return;
                    normal = mergeSources(normal, result.value.normalSources);
                    premium = mergeSources(premium, result.value.premiumSources);
                    updated = updated.map(item => item.id === sub.id ? { ...item, lastUpdated: Date.now() } : item);
                    changed = true;
                });
                if (changed) settingsStore.saveSettings({ ...latest, sources: normal, premiumSources: premium, subscriptions: updated });
                if (failed) setError('视频源列表加载失败，请检查网络后重试');
            } catch {
                if (mounted) setError('视频源列表加载失败，请重试');
            } finally {
                running = false;
                if (mounted) {
                    setSyncing(false);
                    if (pending) { pending = false; schedule(); }
                }
            }
        };

        const schedule = () => {
            clearTimeout(timer);
            timer = setTimeout(() => { void sync(); }, 0);
        };
        const retry = () => { forceNext = true; schedule(); };
        refreshRef.current = retry;
        // Runtime subscriptions may arrive after authentication on a slow device.
        const unsubscribe = settingsStore.subscribe(schedule);
        window.addEventListener('online', retry);
        schedule();
        return () => {
            mounted = false;
            clearTimeout(timer);
            unsubscribe();
            window.removeEventListener('online', retry);
            refreshRef.current = () => {};
        };
    }, []);

    return { syncing, error, refresh };
}
