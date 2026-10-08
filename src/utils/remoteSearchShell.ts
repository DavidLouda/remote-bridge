import { StringDecoder } from 'string_decoder';
import { esc } from './shellCommands';

/**
 * Command builders and output parsers for server-side text search over SSH
 * (POSIX shells only). Pure functions without `vscode` so they can be tested
 * in plain Node.
 */

export type SearchTool = 'rg' | 'grep' | 'busybox';

export interface RemoteSearchQuery {
    pattern: string;
    isRegex: boolean;
    matchCase: boolean;
    wholeWord: boolean;
    /** Globs a file must match (any of them); empty = all files. */
    include: string[];
    /** Globs of files and folders to skip. */
    exclude: string[];
    /** Honour .gitignore and similar files (ripgrep only). */
    useIgnoreFiles: boolean;
}

export interface SearchMatch {
    /** Absolute remote path of the file. */
    path: string;
    /** 1-based line number. */
    line: number;
    /** Line text without the line break (may be truncated). */
    text: string;
    /** Match ranges in `text` as [start, end) UTF-16 offsets. */
    ranges: [number, number][];
}

/** Longest line text kept per match; longer lines are cut after the first match. */
export const MAX_LINE_LENGTH = 1000;

const PROBE_MARKER = '__remote_bridge_search_probe__';

// ─── Tool detection ─────────────────────────────────────────────────

/**
 * Probe which search tool the server has. Prints a marker first so a server
 * without a usable shell (e.g. ForceCommand internal-sftp) is recognised.
 */
export function buildProbeCommand(): string {
    const script = [
        `echo ${PROBE_MARKER}`,
        'if command -v rg >/dev/null 2>&1; then echo tool=rg; fi',
        'if grep --version 2>/dev/null | grep -qiE "GNU|BSD"; then echo tool=grep; fi',
        'if command -v grep >/dev/null 2>&1; then echo tool=busybox; fi',
    ].join('; ');
    return `sh -c ${esc(script)}`;
}

/** Best tool from the probe output, or `undefined` when there is no shell or grep. */
export function parseProbeOutput(stdout: string): SearchTool | undefined {
    if (!stdout.includes(PROBE_MARKER)) {
        return undefined;
    }
    for (const tool of ['rg', 'grep', 'busybox'] as const) {
        if (new RegExp(`^tool=${tool}\\s*$`, 'm').test(stdout)) {
            return tool;
        }
    }
    return undefined;
}

// ─── Command building ───────────────────────────────────────────────

/** Split a comma-separated glob list (`*.yml, !vendor/**`) into includes and excludes. */
export function parseGlobList(input: string): { include: string[]; exclude: string[] } {
    const include: string[] = [];
    const exclude: string[] = [];
    // Globs are relative to the searched folder; ripgrep matches nothing
    // for a leading `./`.
    const relative = (glob: string) => glob.replace(/^(\.\/)+/, '');
    for (const raw of splitGlobs(input)) {
        if (raw.startsWith('!')) {
            const glob = relative(raw.slice(1));
            if (glob) {
                exclude.push(glob);
            }
        } else if (relative(raw)) {
            include.push(relative(raw));
        }
    }
    return { include, exclude };
}

/** Split on commas that are not inside `{…}` braces. */
function splitGlobs(input: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of input) {
        if (ch === '{') { depth++; }
        if (ch === '}') { depth = Math.max(0, depth - 1); }
        if (ch === ',' && depth === 0) {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    parts.push(current);
    return parts.map((part) => part.trim()).filter(Boolean);
}

/** Absolute path of a result path printed by a search run in `searchPath`. */
export function resolveResultPath(resultPath: string, searchPath: string): string {
    const root = searchPath.endsWith('/') ? searchPath.slice(0, -1) : searchPath;
    if (resultPath === '.') {
        return root || '/';
    }
    return resultPath.startsWith('./') ? `${root}/${resultPath.slice(2)}` : resultPath;
}

/**
 * Command that runs a search script: the script is written to stdin (see
 * {@link buildSearchScript}) instead of being quoted into the command line,
 * so it does not depend on how the user's login shell (bash, csh, fish…)
 * parses nested quotes.
 */
export const SEARCH_SHELL_COMMAND = 'sh -s';

/**
 * Build the shell script for `tool`, to be fed to {@link SEARCH_SHELL_COMMAND}
 * on stdin. The search is killed when stdin reaches EOF (cancellation or a
 * dropped connection): closing a channel without a PTY does not stop the
 * remote process, and not every server supports SSH signals.
 */
export function buildSearchScript(tool: SearchTool, query: RemoteSearchQuery, searchPath: string): string {
    if (/[\x00-\x1f\x7f]/.test(query.pattern)) {
        throw new Error('control characters');
    }
    const args: string[] = [];
    if (tool === 'rg') {
        args.push('rg', '--json', '--hidden', '--no-config', '--no-messages', '--max-filesize', '10M');
        args.push(query.matchCase ? '--case-sensitive' : '--ignore-case');
        if (!query.isRegex) { args.push('--fixed-strings'); }
        if (query.wholeWord) { args.push('--word-regexp'); }
        if (!query.useIgnoreFiles) { args.push('--no-ignore'); }
        for (const glob of query.include) {
            args.push('--glob', esc(glob));
        }
        for (const glob of ['.git', ...query.exclude]) {
            args.push('--glob', esc(`!${glob}`));
        }
    } else {
        args.push('grep', tool === 'grep' ? '-rnHIs' : '-rnHs');
        args.push(query.isRegex ? '-E' : '-F');
        if (!query.matchCase) { args.push('-i'); }
        if (query.wholeWord) { args.push('-w'); }
        if (tool === 'grep') {
            args.push('--null', '--color=never');
            // grep matches --include/--exclude against base names with
            // fnmatch (no `{a,b}`); the caller filters all results by the
            // full globs as well. Includes are passed on only when all of
            // them are plain name globs — with a folder glob (`src/**`) among
            // them grep would skip every other file.
            const includeNames = query.include.map((glob) => glob.replace(/^(\*\*\/)+/, ''));
            if (includeNames.every(isPlainNameGlob)) {
                for (const name of includeNames) {
                    args.push(`--include=${esc(name)}`);
                }
            }
            for (const glob of query.exclude) {
                const name = excludeName(glob);
                if (name) {
                    args.push(`--exclude=${esc(name)}`, `--exclude-dir=${esc(name)}`);
                }
            }
            args.push(`--exclude-dir=${esc('.git')}`);
        }
    }
    // Search `.` from inside the folder: ripgrep anchors path globs such as
    // `src/**` at the working directory. Result paths start with `./`.
    args.push('-e', esc(query.pattern), '--', '.');

    const search = `${args.join(' ')} </dev/null`;
    const script = [
        `cd ${esc(searchPath)} || exit 2`,
        'exec 3<&0',
        `${search} & p=$!`,
        '( cat <&3 >/dev/null; kill $p 2>/dev/null ) >/dev/null 2>&1 & w=$!',
        'wait $p; s=$?',
        'kill $w 2>/dev/null',
        'exit $s',
    ].join('; ');
    // One line: sh reads and runs it, and `cat` then waits on the rest of
    // stdin, which only ends on cancellation or when the channel closes.
    return `${script}\n`;
}

/**
 * Name glob grep can exclude as file or folder (`**\/node_modules`,
 * `vendor/**` → `node_modules`, `vendor`); `undefined` for path globs.
 */
function excludeName(glob: string): string | undefined {
    const stripped = glob.replace(/^(\*\*\/)+/, '').replace(/(\/\*\*)+$/, '').replace(/\/$/, '');
    return isPlainNameGlob(stripped) ? stripped : undefined;
}

function isPlainNameGlob(glob: string): boolean {
    return glob.length > 0 && !/[/{}]/.test(glob);
}

// ─── Glob matching (for results grep could not filter) ──────────────

/** Convert a VS Code-style glob (`**`, `*`, `?`, `{a,b}`, `[…]`) to a RegExp. */
export function globToRegExp(glob: string): RegExp {
    let source = '';
    let inGroup = 0;
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob[i + 1] === '*') {
                i++;
                if (glob[i + 1] === '/') {
                    i++;
                    source += '(?:.*/)?';
                } else {
                    source += '.*';
                }
            } else {
                source += '[^/]*';
            }
        } else if (ch === '?') {
            source += '[^/]';
        } else if (ch === '{') {
            inGroup++;
            source += '(?:';
        } else if (ch === '}' && inGroup > 0) {
            inGroup--;
            source += ')';
        } else if (ch === ',' && inGroup > 0) {
            source += '|';
        } else if (ch === '[') {
            const close = glob.indexOf(']', i + 1);
            if (close > i + 1) {
                const body = glob.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\');
                source += `[${body}]`;
                i = close;
            } else {
                source += '\\[';
            }
        } else {
            source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${source}$`);
}

/**
 * Whether `relativePath` passes the include/exclude globs. Like VS Code and
 * ripgrep, a glob without `/` matches the base name or any folder name.
 */
export function createPathFilter(include: readonly string[], exclude: readonly string[]): (relativePath: string) => boolean {
    const compile = (glob: string) => {
        const regex = globToRegExp(glob.replace(/^\.\//, ''));
        const anySegment = !glob.includes('/');
        return (path: string) => {
            if (regex.test(path)) {
                return true;
            }
            if (anySegment) {
                return path.split('/').some((segment) => regex.test(segment));
            }
            // Folder globs (`src/**` or `vendor`) also match files below them.
            return path.split('/').some((_, i, parts) => regex.test(parts.slice(0, i + 1).join('/')));
        };
    };
    const includes = include.map(compile);
    const excludes = exclude.map(compile);
    return (relativePath: string) =>
        (includes.length === 0 || includes.some((test) => test(relativePath)))
        && !excludes.some((test) => test(relativePath));
}

// ─── Output parsing ─────────────────────────────────────────────────

/** Splits a byte stream into lines, decoding UTF-8 across chunk boundaries. */
export class LineSplitter {
    private readonly _decoder = new StringDecoder('utf8');
    private _buffer = '';

    push(chunk: Buffer): string[] {
        this._buffer += this._decoder.write(chunk);
        const lines = this._buffer.split('\n');
        this._buffer = lines.pop() ?? '';
        return lines;
    }

    end(): string[] {
        this._buffer += this._decoder.end();
        const rest = this._buffer;
        this._buffer = '';
        return rest ? [rest] : [];
    }
}

interface RgText {
    text?: string;
    bytes?: string;
}

function rgText(value: RgText | undefined): { text: string; bytes: Buffer } | undefined {
    if (!value) {
        return undefined;
    }
    if (typeof value.text === 'string') {
        return { text: value.text, bytes: Buffer.from(value.text, 'utf8') };
    }
    if (typeof value.bytes === 'string') {
        const bytes = Buffer.from(value.bytes, 'base64');
        return { text: bytes.toString('utf8'), bytes };
    }
    return undefined;
}

/** Parse one line of `rg --json` output; returns a match or `undefined`. */
export function parseRgJsonLine(line: string): SearchMatch | undefined {
    if (!line.startsWith('{"type":"match"')) {
        return undefined;
    }
    let message: {
        data?: {
            path?: RgText;
            lines?: RgText;
            line_number?: number;
            submatches?: { start: number; end: number }[];
        };
    };
    try {
        message = JSON.parse(line);
    } catch {
        return undefined;
    }
    const data = message.data;
    const path = rgText(data?.path);
    const lines = rgText(data?.lines);
    if (!data || !path || !lines || typeof data.line_number !== 'number') {
        return undefined;
    }
    // Submatch offsets are UTF-8 byte offsets into `lines`.
    const toUtf16 = (byteOffset: number) => lines.bytes.subarray(0, byteOffset).toString('utf8').length;
    const ranges = (data.submatches ?? []).map(
        ({ start, end }) => [toUtf16(start), toUtf16(end)] as [number, number]
    );
    return finishMatch(path.text, data.line_number, lines.text, ranges);
}

/** Parse one line of `grep -n -H --null` output (`path\0line:text`). */
export function parseGrepNullLine(line: string, highlight: RegExp | undefined): SearchMatch | undefined {
    const nul = line.indexOf('\0');
    if (nul <= 0) {
        return undefined;
    }
    const rest = /^(\d+):(.*)$/s.exec(line.slice(nul + 1));
    if (!rest) {
        return undefined;
    }
    return finishMatch(line.slice(0, nul), Number(rest[1]), rest[2], findRanges(rest[2], highlight));
}

/** Parse one line of plain `grep -n -H` output (`path:line:text`), e.g. BusyBox. */
export function parseGrepPlainLine(line: string, highlight: RegExp | undefined): SearchMatch | undefined {
    const match = /^(.+?):(\d+):(.*)$/s.exec(line);
    if (!match) {
        return undefined;
    }
    return finishMatch(match[1], Number(match[2]), match[3], findRanges(match[3], highlight));
}

function finishMatch(path: string, line: number, rawText: string, ranges: [number, number][]): SearchMatch {
    let text = rawText.replace(/\r?\n$/, '').replace(/\r$/, '');
    let kept = ranges.filter(([start, end]) => end > start && start < text.length);
    if (text.length > MAX_LINE_LENGTH) {
        const firstEnd = kept[0]?.[1] ?? 0;
        const cut = Math.max(MAX_LINE_LENGTH, Math.min(firstEnd, text.length));
        text = text.slice(0, cut);
        kept = kept.filter(([start]) => start < cut).map(([start, end]) => [start, Math.min(end, cut)]);
    }
    return { path, line, text, ranges: kept };
}

/**
 * JavaScript RegExp that finds the matches grep reported (grep does not
 * output match positions). Best effort: POSIX-only regex syntax that
 * JavaScript does not understand simply yields no highlight.
 */
export function buildHighlightRegExp(query: Pick<RemoteSearchQuery, 'pattern' | 'isRegex' | 'matchCase' | 'wholeWord'>): RegExp | undefined {
    let source = query.isRegex
        ? query.pattern.replace(/\[\[:(\w+):\]\]/g, (_, cls: string) => POSIX_CLASSES[cls] ?? `[[:${cls}:]]`)
        : query.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = query.matchCase ? 'g' : 'gi';
    try {
        // Unicode mode for word boundaries that understand non-ASCII letters.
        return new RegExp(query.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source, `${flags}u`);
    } catch {
        // Some patterns are only valid outside Unicode mode (e.g. `\-`).
        try {
            return new RegExp(query.wholeWord ? `\\b(?:${source})\\b` : source, flags);
        } catch {
            return undefined;
        }
    }
}

const POSIX_CLASSES: Record<string, string> = {
    alpha: '[a-zA-Z]',
    digit: '\\d',
    alnum: '[a-zA-Z0-9]',
    space: '\\s',
    upper: '[A-Z]',
    lower: '[a-z]',
    punct: '[!-/:-@[-`{-~]',
    xdigit: '[0-9A-Fa-f]',
};

function findRanges(text: string, highlight: RegExp | undefined): [number, number][] {
    if (!highlight) {
        return [];
    }
    const ranges: [number, number][] = [];
    highlight.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = highlight.exec(text)) !== null && ranges.length < 100) {
        if (match[0].length === 0) {
            highlight.lastIndex++;
            continue;
        }
        ranges.push([match.index, match.index + match[0].length]);
    }
    return ranges;
}
