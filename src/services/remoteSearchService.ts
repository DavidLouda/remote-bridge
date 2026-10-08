import * as vscode from 'vscode';
import { RemoteAdapter, isConnectionLostError } from '../adapters/adapter';
import { ConnectionConfig } from '../types/connection';
import { ConnectionPool } from './connectionPool';
import {
    LineSplitter,
    RemoteSearchQuery,
    SearchMatch,
    SearchTool,
    buildHighlightRegExp,
    buildProbeCommand,
    buildSearchCommand,
    createPathFilter,
    parseGrepNullLine,
    parseGrepPlainLine,
    parseProbeOutput,
    parseRgJsonLine,
    resolveResultPath,
} from '../utils/remoteSearchShell';

/** Why server-side search cannot run for a connection. */
export type SearchUnavailableReason = 'noExec' | 'windows' | 'noShell';

export class SearchUnavailableError extends Error {
    constructor(readonly reason: SearchUnavailableReason) {
        super(reason);
        this.name = 'SearchUnavailableError';
    }
}

export interface RemoteSearchOutcome {
    tool: SearchTool;
    matchCount: number;
    /** The result limit was reached and the search was stopped. */
    truncated: boolean;
    cancelled: boolean;
    /** Some files or folders could not be read (e.g. permission denied). */
    partial: boolean;
    /** Error reported by the search tool when it found nothing. */
    error?: string;
}

const TOOL_CACHE_TTL_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Runs text searches on the server (ripgrep, else grep) over SSH and
 * streams the matches, independent of the file system cache.
 */
export class RemoteSearchService {
    private readonly _tools = new Map<string, { tool: SearchTool | undefined; at: number }>();

    constructor(private readonly _pool: ConnectionPool) {}

    async search(
        connection: ConnectionConfig,
        rootPath: string,
        query: RemoteSearchQuery,
        maxResults: number,
        onMatches: (matches: SearchMatch[]) => void,
        token: vscode.CancellationToken
    ): Promise<RemoteSearchOutcome> {
        if (connection.os === 'windows') {
            throw new SearchUnavailableError('windows');
        }
        const adapter = await this._pool.getAdapter(connection);
        if (!adapter.supportsExec || !adapter.exec || !adapter.execStream) {
            throw new SearchUnavailableError('noExec');
        }
        const tool = await this._detectTool(connection.id, adapter);
        if (!tool) {
            throw new SearchUnavailableError('noShell');
        }

        const limit = new vscode.CancellationTokenSource();
        const forwardCancel = token.onCancellationRequested(() => limit.cancel());
        const highlight = tool === 'rg' ? undefined : buildHighlightRegExp(query);
        // grep cannot apply path globs (and BusyBox no globs at all), so all
        // grep results are filtered here as well.
        const pathFilter = tool === 'rg' ? undefined : createPathFilter(query.include, ['.git', ...query.exclude]);
        const prefix = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
        const parse = (line: string): SearchMatch | undefined => {
            const match = tool === 'rg'
                ? parseRgJsonLine(line)
                : tool === 'grep' ? parseGrepNullLine(line, highlight) : parseGrepPlainLine(line, highlight);
            if (!match) {
                return undefined;
            }
            match.path = resolveResultPath(match.path, rootPath);
            if (pathFilter && !pathFilter(match.path.startsWith(prefix) ? match.path.slice(prefix.length) : match.path)) {
                return undefined;
            }
            return match;
        };

        let matchCount = 0;
        let truncated = false;
        const splitter = new LineSplitter();
        const deliver = (lines: string[]) => {
            if (truncated) {
                return;
            }
            const batch: SearchMatch[] = [];
            for (const line of lines) {
                const match = parse(line);
                if (!match) {
                    continue;
                }
                batch.push(match);
                if (++matchCount >= maxResults) {
                    truncated = true;
                    limit.cancel();
                    break;
                }
            }
            if (batch.length > 0) {
                onMatches(batch);
            }
        };

        try {
            const result = await adapter.execStream(
                buildSearchCommand(tool, query, rootPath),
                (chunk) => deliver(splitter.push(chunk)),
                limit.token
            );
            deliver(splitter.end());

            const outcome: RemoteSearchOutcome = {
                tool,
                matchCount,
                truncated,
                cancelled: token.isCancellationRequested,
                partial: false,
            };
            if (truncated || outcome.cancelled) {
                return outcome;
            }
            const stderr = result.stderr.trim();
            if (result.exitCode === 0 || result.exitCode === 1) {
                return outcome;
            }
            if (result.exitCode === 127) {
                // The tool disappeared since it was detected.
                this._tools.delete(connection.id);
            }
            if (matchCount > 0 || !stderr) {
                // rg/grep exit with 2 when some files could not be read.
                outcome.partial = true;
                return outcome;
            }
            // e.g. "rg: regex parse error: … error: unclosed group"
            const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
            outcome.error = lines.length > 1 ? `${lines[0]} ${lines[lines.length - 1]}` : lines[0];
            return outcome;
        } finally {
            forwardCancel.dispose();
            limit.dispose();
        }
    }

    /** Forget detected tools, e.g. after a connection was edited. */
    forget(connectionId: string): void {
        this._tools.delete(connectionId);
    }

    private async _detectTool(connectionId: string, adapter: RemoteAdapter): Promise<SearchTool | undefined> {
        const cached = this._tools.get(connectionId);
        if (cached && Date.now() - cached.at < TOOL_CACHE_TTL_MS) {
            return cached.tool;
        }
        let tool: SearchTool | undefined;
        try {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS);
            });
            try {
                const result = await Promise.race([adapter.exec!(buildProbeCommand()), timeout]);
                tool = parseProbeOutput(result.stdout);
            } finally {
                clearTimeout(timer);
            }
        } catch (err) {
            if (isConnectionLostError(err)) {
                throw err;
            }
            // Timed out or exec refused: no usable shell on this server.
            tool = undefined;
        }
        this._tools.set(connectionId, { tool, at: Date.now() });
        return tool;
    }
}
