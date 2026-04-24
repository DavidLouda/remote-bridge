import * as vscode from 'vscode';

const STATE_KEY = 'remoteBridge.lastConnectedAt';

/**
 * Tracks per-connection "last successfully connected" timestamps in
 * `globalState`. Kept separate from the synced ConnectionStore so the
 * timestamp is local to the current machine and never participates in
 * cross-device sync merges.
 *
 * Writes are debounced — successive `touch()` calls within `_flushDelayMs`
 * coalesce into a single `globalState.update` to avoid disk thrash when
 * the user reconnects rapidly.
 */
export class RecentConnectionsService implements vscode.Disposable {
    private _map: Record<string, number>;
    private _flushTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly _flushDelayMs = 500;

    constructor(private readonly _state: vscode.Memento) {
        const raw = this._state.get<Record<string, number>>(STATE_KEY);
        // Defensive shape check — any unexpected value resets to empty.
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            this._map = {};
            for (const [id, ts] of Object.entries(raw)) {
                if (typeof id === 'string' && typeof ts === 'number' && Number.isFinite(ts)) {
                    this._map[id] = ts;
                }
            }
        } else {
            this._map = {};
        }
    }

    /** Record `now` as the last-connected timestamp for `connectionId`. */
    touch(connectionId: string, when: number = Date.now()): void {
        this._map[connectionId] = when;
        this._scheduleFlush();
    }

    /** Drop a connection's entry (e.g. when the connection is deleted). */
    forget(connectionId: string): void {
        if (connectionId in this._map) {
            delete this._map[connectionId];
            this._scheduleFlush();
        }
    }

    /** Return epoch ms of the last connect, or `undefined` if never. */
    get(connectionId: string): number | undefined {
        return this._map[connectionId];
    }

    /**
     * Return up to `limit` connection IDs sorted newest-first, optionally
     * filtered to those present in `validIds` (defends against stale entries
     * for deleted connections that touch() never saw deleted).
     */
    getRecent(limit: number = 5, validIds?: ReadonlySet<string>): string[] {
        return Object.entries(this._map)
            .filter(([id]) => !validIds || validIds.has(id))
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([id]) => id);
    }

    private _scheduleFlush(): void {
        if (this._flushTimer) { return; }
        this._flushTimer = setTimeout(() => {
            this._flushTimer = undefined;
            void this._state.update(STATE_KEY, this._map);
        }, this._flushDelayMs);
    }

    dispose(): void {
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = undefined;
            // Final synchronous-ish flush so the last touch isn't lost.
            void this._state.update(STATE_KEY, this._map);
        }
    }
}
