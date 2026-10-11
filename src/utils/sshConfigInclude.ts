import * as fs from 'fs';
import * as path from 'path';
import { expandEnvVars } from './keyPath';

/**
 * Inline `Include` directives of an OpenSSH client config so the result can
 * be parsed as a single file (the `ssh-config` package does not follow
 * includes). Works on text, before parsing, so `SSHConfig.compute()` keeps
 * working on the combined config.
 *
 * Follows ssh_config(5): several space-separated paths per directive,
 * `~` and `${VAR}` expansion, relative paths resolved against `~/.ssh`,
 * glob wildcards (`*`, `?`) in any path segment with matches in sorted order,
 * and nesting up to 16 levels. An Include inside a Host or Match block is
 * inlined at its position; the enclosing block header is repeated after the
 * included text so the following lines still belong to that block.
 */

export interface IncludeExpansionOptions {
    /** Directory relative Include paths resolve against (normally `~/.ssh`). */
    sshDir: string;
    /** Home directory for `~` and `%d`. */
    homeDir: string;
    /** Reads one file; expected to enforce a per-file size limit and throw on error. */
    readFile: (filePath: string) => string;
    env?: NodeJS.ProcessEnv;
    maxDepth?: number;
    maxFiles?: number;
    maxTotalBytes?: number;
}

export type IncludeWarning =
    | { kind: 'notFound'; pattern: string }
    | { kind: 'notFile'; path: string }
    | { kind: 'cycle'; path: string }
    | { kind: 'depth'; path: string }
    | { kind: 'tooManyFiles'; limit: number }
    | { kind: 'tooLarge'; limit: number }
    | { kind: 'readError'; path: string; message: string };

export interface IncludeExpansionResult {
    text: string;
    /** Files that were inlined, in order. */
    files: string[];
    warnings: IncludeWarning[];
}

const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_FILES = 256;
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const INCLUDE_LINE = /^\s*include(?:\s*=\s*|\s+)(.*?)\s*$/i;
const SECTION_LINE = /^\s*(host|match)(?:\s*=\s*|\s+)\S/i;
const ARGUMENT = /"([^"]*)"|'([^']*)'|(\S+)/g;
const WILDCARD = /[*?]/;

/**
 * Expand Include directives in `content`. `sourcePath` (if known) is added
 * to the recursion guard so a file that includes itself is detected.
 */
export function expandIncludes(
    content: string,
    options: IncludeExpansionOptions,
    sourcePath?: string
): IncludeExpansionResult {
    const state = {
        options,
        maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
        maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
        maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
        totalBytes: content.length,
        files: [] as string[],
        warnings: [] as IncludeWarning[],
        limitReported: false,
    };
    const chain = new Set<string>();
    if (sourcePath) {
        chain.add(realpathOrSelf(sourcePath));
    }
    const text = expandText(content, 0, chain, state);
    return { text, files: state.files, warnings: state.warnings };
}

interface ExpansionState {
    options: IncludeExpansionOptions;
    maxDepth: number;
    maxFiles: number;
    maxTotalBytes: number;
    totalBytes: number;
    files: string[];
    warnings: IncludeWarning[];
    limitReported: boolean;
}

function expandText(content: string, depth: number, chain: Set<string>, state: ExpansionState): string {
    const output: string[] = [];
    let currentHeader: string | undefined;

    for (const line of content.split(/\r?\n/)) {
        if (SECTION_LINE.test(line)) {
            currentHeader = line.trim();
            output.push(line);
            continue;
        }
        const include = INCLUDE_LINE.exec(line);
        if (!include) {
            output.push(line);
            continue;
        }

        // Keep the directive as a comment so the combined text stays readable.
        output.push(`# ${line.trim()}`);
        let includedSections = false;
        for (const filePath of resolveIncludeArguments(include[1], state)) {
            const included = includeFile(filePath, depth, chain, state);
            if (included === undefined) {
                continue;
            }
            output.push(included);
            if (included.split(/\r?\n/).some((includedLine) => SECTION_LINE.test(includedLine))) {
                includedSections = true;
            }
        }
        if (includedSections) {
            // Lines after the Include belong to the block it appeared in;
            // `Match all` restores the global scope at the top level.
            output.push(currentHeader ?? 'Match all');
        }
    }
    return output.join('\n');
}

function includeFile(filePath: string, depth: number, chain: Set<string>, state: ExpansionState): string | undefined {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch {
        return undefined;
    }
    if (!stat.isFile()) {
        state.warnings.push({ kind: 'notFile', path: filePath });
        return undefined;
    }
    const realPath = realpathOrSelf(filePath);
    if (chain.has(realPath)) {
        state.warnings.push({ kind: 'cycle', path: filePath });
        return undefined;
    }
    if (depth + 1 > state.maxDepth) {
        state.warnings.push({ kind: 'depth', path: filePath });
        return undefined;
    }
    if (state.files.length >= state.maxFiles) {
        reportLimit(state, { kind: 'tooManyFiles', limit: state.maxFiles });
        return undefined;
    }
    if (state.totalBytes + stat.size > state.maxTotalBytes) {
        reportLimit(state, { kind: 'tooLarge', limit: state.maxTotalBytes });
        return undefined;
    }

    let content: string;
    try {
        content = state.options.readFile(filePath);
    } catch (err) {
        state.warnings.push({ kind: 'readError', path: filePath, message: err instanceof Error ? err.message : String(err) });
        return undefined;
    }
    state.totalBytes += content.length;
    state.files.push(filePath);

    chain.add(realPath);
    try {
        return expandText(content, depth + 1, chain, state);
    } finally {
        chain.delete(realPath);
    }
}

function reportLimit(state: ExpansionState, warning: IncludeWarning): void {
    if (!state.limitReported) {
        state.limitReported = true;
        state.warnings.push(warning);
    }
}

/** Split, expand and glob the arguments of one Include directive. */
function resolveIncludeArguments(argumentText: string, state: ExpansionState): string[] {
    const { options } = state;
    const result: string[] = [];
    for (const match of argumentText.matchAll(ARGUMENT)) {
        if (match[3]?.startsWith('#')) {
            break; // trailing comment
        }
        const raw = match[1] ?? match[2] ?? match[3];
        if (!raw) {
            continue;
        }
        let pattern = expandEnvVars(raw, options.env ?? process.env, 'linux')
            .replace(/%d/g, options.homeDir)
            .replace(/%%/g, '%');
        if (pattern === '~' || pattern.startsWith('~/')) {
            pattern = path.join(options.homeDir, pattern.slice(1));
        }
        if (!path.isAbsolute(pattern)) {
            pattern = path.join(options.sshDir, pattern);
        }
        if (WILDCARD.test(pattern)) {
            // OpenSSH silently ignores patterns without matches.
            result.push(...globPath(pattern));
        } else if (fs.existsSync(pattern)) {
            result.push(pattern);
        } else {
            state.warnings.push({ kind: 'notFound', pattern: raw });
        }
    }
    return result;
}

/** Minimal glob(3): `*` and `?` in any segment, no leading-dot matches, sorted. */
function globPath(pattern: string): string[] {
    const { root } = path.parse(pattern);
    const segments = pattern.slice(root.length).split(/[\\/]+/).filter(Boolean);
    let candidates = [root];
    for (const segment of segments) {
        const next: string[] = [];
        if (!WILDCARD.test(segment)) {
            for (const dir of candidates) {
                next.push(path.join(dir, segment));
            }
        } else {
            const regex = segmentToRegExp(segment);
            for (const dir of candidates) {
                let entries: string[];
                try {
                    entries = fs.readdirSync(dir);
                } catch {
                    continue;
                }
                for (const entry of entries.sort()) {
                    if (entry.startsWith('.') && !segment.startsWith('.')) {
                        continue;
                    }
                    if (regex.test(entry)) {
                        next.push(path.join(dir, entry));
                    }
                }
            }
        }
        candidates = next;
        if (candidates.length === 0) {
            break;
        }
    }
    return candidates.filter((candidate) => fs.existsSync(candidate));
}

function segmentToRegExp(segment: string): RegExp {
    const source = segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${source}$`);
}

function realpathOrSelf(filePath: string): string {
    try {
        return fs.realpathSync(filePath);
    } catch {
        return path.resolve(filePath);
    }
}
