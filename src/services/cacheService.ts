import { RemoteFileStat } from '../types/connection';

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
    size: number;
}

/**
 * LRU cache with TTL for remote file metadata and content.
 */
export class CacheService {
    private readonly _statCache = new Map<string, CacheEntry<RemoteFileStat>>();
    private readonly _contentCache = new Map<string, CacheEntry<Uint8Array>>();
    private readonly _dirCache = new Map<string, CacheEntry<[string, number][]>>();

    private _maxContentSizeBytes: number;
    private _currentContentSize = 0;
    private _statTtlMs: number;
    private _contentTtlMs: number;

    constructor(
        statTtlSeconds = 30,
        contentTtlSeconds = 10,
        maxContentSizeMB = 10
    ) {
        this._statTtlMs = statTtlSeconds * 1000;
        this._contentTtlMs = contentTtlSeconds * 1000;
        this._maxContentSizeBytes = maxContentSizeMB * 1024 * 1024;
    }

    // ─── Configuration Update ───────────────────────────────────────

    updateConfig(statTtlSeconds: number, contentTtlSeconds: number, maxContentSizeMB: number): void {
        this._statTtlMs = statTtlSeconds * 1000;
        this._contentTtlMs = contentTtlSeconds * 1000;
        this._maxContentSizeBytes = maxContentSizeMB * 1024 * 1024;
    }

    // ─── Stat Cache ─────────────────────────────────────────────────

    getStat(key: string): RemoteFileStat | undefined {
        return this._get(this._statCache, key);
    }

    setStat(key: string, stat: RemoteFileStat): void {
        this._statCache.set(key, {
            value: stat,
            expiresAt: Date.now() + this._statTtlMs,
            size: 0,
        });
    }

    // ─── Content Cache ──────────────────────────────────────────────

    getContent(key: string): Uint8Array | undefined {
        return this._get(this._contentCache, key);
    }

    setContent(key: string, content: Uint8Array): void {
        // Evict oldest entries if we exceed max size
        while (
            this._currentContentSize + content.byteLength > this._maxContentSizeBytes &&
            this._contentCache.size > 0
        ) {
            const oldestKey = this._contentCache.keys().next().value;
            if (oldestKey !== undefined) {
                this._evictContent(oldestKey);
            }
        }

        // Don't cache if single entry exceeds max size
        if (content.byteLength > this._maxContentSizeBytes) {
            console.warn(`[RemoteBridge] Cache: file content (${content.byteLength} B) exceeds max cache size (${this._maxContentSizeBytes} B) — skipping cache`);
            return;
        }

        this._contentCache.set(key, {
            value: content,
            expiresAt: Date.now() + this._contentTtlMs,
            size: content.byteLength,
        });
        this._currentContentSize += content.byteLength;
    }

    // ─── Directory Cache ────────────────────────────────────────────

    getDirectory(key: string): [string, number][] | undefined {
        return this._get(this._dirCache, key);
    }

    setDirectory(key: string, entries: [string, number][]): void {
        this._dirCache.set(key, {
            value: entries,
            expiresAt: Date.now() + this._statTtlMs,
            size: 0,
        });
    }

    // ─── Invalidation ───────────────────────────────────────────────

    /**
     * Invalidate all cache entries for a specific path (and parent directory).
     */
    invalidatePath(connectionId: string, remotePath: string): void {
        const key = this._makeKey(connectionId, remotePath);
        this._statCache.delete(key);
        this._evictContent(key);
        this._dirCache.delete(key);

        // Also invalidate parent directory listing
        const parentPath = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
        const parentKey = this._makeKey(connectionId, parentPath);
        this._dirCache.delete(parentKey);
    }

    /**
     * Invalidate all cache entries for a connection.
     */
    invalidateConnection(connectionId: string): void {
        const prefix = `${connectionId}:`;
        for (const key of this._statCache.keys()) {
            if (key.startsWith(prefix)) {
                this._statCache.delete(key);
            }
        }
        for (const key of this._contentCache.keys()) {
            if (key.startsWith(prefix)) {
                this._evictContent(key);
            }
        }
        for (const key of this._dirCache.keys()) {
            if (key.startsWith(prefix)) {
                this._dirCache.delete(key);
            }
        }
    }

    /**
     * Clear all caches.
     */
    clearAll(): void {
        this._statCache.clear();
        this._contentCache.clear();
        this._dirCache.clear();
        this._currentContentSize = 0;
    }

    // ─── Key Builder ────────────────────────────────────────────────

    /** Public key builder for external use */
    makeKey(connectionId: string, remotePath: string): string {
        return this._makeKey(connectionId, remotePath);
    }

    // ─── Private Helpers ────────────────────────────────────────────

    private _makeKey(connectionId: string, remotePath: string): string {
        return `${connectionId}:${remotePath}`;
    }

    private _get<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
        const entry = cache.get(key);
        if (!entry) {
            return undefined;
        }
        if (Date.now() > entry.expiresAt) {
            cache.delete(key);
            return undefined;
        }
        return entry.value;
    }

    private _evictContent(key: string): void {
        const entry = this._contentCache.get(key);
        if (entry) {
            this._currentContentSize -= entry.size;
            this._contentCache.delete(key);
        }
    }

    dispose(): void {
        this.clearAll();
    }
}
