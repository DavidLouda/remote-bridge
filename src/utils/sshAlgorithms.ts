import * as ssh2Constants from 'ssh2/lib/protocol/constants';
import type { SshAlgorithmSettings } from '../types/connection';

/**
 * Per-connection SSH algorithm overrides, written in OpenSSH syntax so they
 * map 1:1 to `KexAlgorithms`, `Ciphers`, `HostKeyAlgorithms` and `MACs`:
 *
 * - `a,b`  — use exactly these algorithms, in this order
 * - `+a,b` — append to the default list
 * - `-a,b` — remove from the default list (`*` and `?` wildcards allowed)
 * - `^a,b` — move to the front of the default list
 *
 * The final list is computed here rather than with ssh2's append/prepend
 * objects: ssh2's `prepend` does not move an algorithm that is already in
 * the default list, unlike OpenSSH's `^`.
 */

export type AlgorithmCategory = keyof SshAlgorithmSettings;

export const ALGORITHM_CATEGORIES: readonly AlgorithmCategory[] = ['kex', 'cipher', 'serverHostKey', 'hmac'];

/** OpenSSH config keyword for each category. */
export const OPENSSH_ALGORITHM_KEYWORDS: Readonly<Record<AlgorithmCategory, string>> = {
    kex: 'KexAlgorithms',
    cipher: 'Ciphers',
    serverHostKey: 'HostKeyAlgorithms',
    hmac: 'MACs',
};

export interface AlgorithmTables {
    defaults: Readonly<Record<AlgorithmCategory, readonly string[]>>;
    supported: Readonly<Record<AlgorithmCategory, readonly string[]>>;
}

/** Algorithm tables of the bundled ssh2 in the running process. */
export function getSsh2AlgorithmTables(): AlgorithmTables {
    return {
        defaults: {
            kex: ssh2Constants.DEFAULT_KEX,
            cipher: ssh2Constants.DEFAULT_CIPHER,
            serverHostKey: ssh2Constants.DEFAULT_SERVER_HOST_KEY,
            hmac: ssh2Constants.DEFAULT_MAC,
        },
        supported: {
            kex: ssh2Constants.SUPPORTED_KEX,
            cipher: ssh2Constants.SUPPORTED_CIPHER,
            serverHostKey: ssh2Constants.SUPPORTED_SERVER_HOST_KEY,
            hmac: ssh2Constants.SUPPORTED_MAC,
        },
    };
}

export type AlgorithmSpecMode = 'exact' | 'append' | 'remove' | 'prepend';

export interface AlgorithmSpec {
    mode: AlgorithmSpecMode;
    names: string[];
}

export type AlgorithmProblem =
    /** The value is not valid OpenSSH algorithm-list syntax. */
    | { category: AlgorithmCategory; kind: 'syntax'; value: string }
    /** The named algorithms are not supported by ssh2 in this environment. */
    | { category: AlgorithmCategory; kind: 'unsupported'; names: string[] }
    /** The value would leave no algorithm at all. */
    | { category: AlgorithmCategory; kind: 'empty' };

const MAX_ALGORITHM_NAMES = 64;
const MAX_ALGORITHM_NAME_LENGTH = 128;
const NAME_PATTERN = /^[A-Za-z0-9@._+-]+$/;
const REMOVE_PATTERN = /^[A-Za-z0-9@._+*?-]+$/;
const MODE_BY_PREFIX: Readonly<Record<string, AlgorithmSpecMode>> = { '+': 'append', '-': 'remove', '^': 'prepend' };

/**
 * Parse one OpenSSH-style algorithm list. Returns `undefined` for an empty
 * value and `null` for invalid syntax.
 */
export function parseAlgorithmSpec(value: string): AlgorithmSpec | undefined | null {
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    const mode = MODE_BY_PREFIX[trimmed[0]] ?? 'exact';
    const body = mode === 'exact' ? trimmed : trimmed.slice(1);
    const names = body.split(/[\s,]+/).filter(Boolean);
    const pattern = mode === 'remove' ? REMOVE_PATTERN : NAME_PATTERN;
    if (
        names.length === 0
        || names.length > MAX_ALGORITHM_NAMES
        || names.some((name) => name.length > MAX_ALGORITHM_NAME_LENGTH || !pattern.test(name))
    ) {
        return null;
    }
    return { mode, names };
}

function wildcardToRegExp(pattern: string): RegExp {
    const source = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${source}$`);
}

/** Apply a parsed spec to the default list of one category. */
export function resolveAlgorithmList(
    spec: AlgorithmSpec,
    defaults: readonly string[],
    supported: readonly string[]
): { list: string[]; unsupported: string[] } {
    if (spec.mode === 'remove') {
        const patterns = spec.names.map(wildcardToRegExp);
        return {
            list: defaults.filter((name) => !patterns.some((re) => re.test(name))),
            unsupported: [],
        };
    }

    const unsupported = spec.names.filter((name) => !supported.includes(name));
    const names = Array.from(new Set(spec.names.filter((name) => supported.includes(name))));
    switch (spec.mode) {
        case 'exact':
            return { list: names, unsupported };
        case 'append':
            return { list: [...defaults, ...names.filter((name) => !defaults.includes(name))], unsupported };
        case 'prepend':
            return { list: [...names, ...defaults.filter((name) => !names.includes(name))], unsupported };
    }
}

/**
 * Build the ssh2 `algorithms` option from connection settings. Categories
 * left empty use ssh2's defaults. Any problem makes the whole result
 * unusable — callers report `problems` instead of connecting.
 */
export function buildSsh2Algorithms(
    settings: SshAlgorithmSettings | undefined,
    tables: AlgorithmTables = getSsh2AlgorithmTables()
): { algorithms?: Partial<Record<AlgorithmCategory, string[]>>; problems: AlgorithmProblem[] } {
    const problems: AlgorithmProblem[] = [];
    const algorithms: Partial<Record<AlgorithmCategory, string[]>> = {};
    for (const category of ALGORITHM_CATEGORIES) {
        const value = settings?.[category];
        if (typeof value !== 'string') {
            continue;
        }
        const spec = parseAlgorithmSpec(value);
        if (spec === undefined) {
            continue;
        }
        if (spec === null) {
            problems.push({ category, kind: 'syntax', value });
            continue;
        }
        const { list, unsupported } = resolveAlgorithmList(spec, tables.defaults[category], tables.supported[category]);
        if (unsupported.length > 0) {
            problems.push({ category, kind: 'unsupported', names: unsupported });
        } else if (list.length === 0) {
            problems.push({ category, kind: 'empty' });
        } else {
            algorithms[category] = list;
        }
    }
    return {
        algorithms: Object.keys(algorithms).length > 0 ? algorithms : undefined,
        problems,
    };
}

/**
 * Normalize algorithm settings from an untrusted source (JSON import, SSH FS
 * settings, webview). Accepts OpenSSH-style strings, plain arrays (exact
 * lists) and ssh2's `{ append | prepend | remove }` objects with a single
 * operation. Returns `undefined` when nothing usable is set.
 */
export function normalizeAlgorithmSettings(input: unknown): SshAlgorithmSettings | undefined {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return undefined;
    }
    const source = input as Record<string, unknown>;
    const result: SshAlgorithmSettings = {};
    for (const category of ALGORITHM_CATEGORIES) {
        const value = toSpecString(source[category]);
        if (value) {
            result[category] = value;
        }
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

function toNameList(value: unknown): string[] | undefined {
    const items = Array.isArray(value) ? value : [value];
    if (items.length === 0 || items.some((item) => typeof item !== 'string')) {
        return undefined;
    }
    return (items as string[]).map((item) => item.trim()).filter(Boolean);
}

function toSpecString(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value.trim().slice(0, MAX_ALGORITHM_NAMES * (MAX_ALGORITHM_NAME_LENGTH + 1)) || undefined;
    }
    if (Array.isArray(value)) {
        return toNameList(value)?.join(',') || undefined;
    }
    if (typeof value === 'object' && value !== null) {
        const operations = Object.entries(value as Record<string, unknown>)
            .filter(([key]) => key === 'append' || key === 'prepend' || key === 'remove');
        if (operations.length !== 1) {
            return undefined;
        }
        const [operation, names] = operations[0];
        const list = toNameList(names);
        if (!list || list.length === 0) {
            return undefined;
        }
        return formatAlgorithmSpec({ mode: operation as AlgorithmSpecMode, names: list });
    }
    return undefined;
}

/**
 * Make imported algorithm settings usable: categories with invalid syntax
 * and algorithm names ssh2 does not support (e.g. OpenSSH certificate or
 * post-quantum names) are dropped. `dropped` lists what was removed, as
 * `Keyword: value`, so importers can report it.
 */
export function sanitizeAlgorithmSettings(
    input: unknown,
    tables: AlgorithmTables = getSsh2AlgorithmTables()
): { algorithms?: SshAlgorithmSettings; dropped: string[] } {
    const settings = normalizeAlgorithmSettings(input);
    const dropped: string[] = [];
    if (!settings) {
        return { dropped };
    }
    const result: SshAlgorithmSettings = {};
    for (const category of ALGORITHM_CATEGORIES) {
        const value = settings[category];
        if (!value) {
            continue;
        }
        const keyword = OPENSSH_ALGORITHM_KEYWORDS[category];
        const spec = parseAlgorithmSpec(value);
        if (!spec) {
            dropped.push(`${keyword}: ${value}`);
            continue;
        }
        if (spec.mode !== 'remove') {
            const unsupported = spec.names.filter((name) => !tables.supported[category].includes(name));
            if (unsupported.length > 0) {
                dropped.push(`${keyword}: ${unsupported.join(',')}`);
                spec.names = spec.names.filter((name) => !unsupported.includes(name));
                if (spec.names.length === 0) {
                    continue;
                }
            }
        }
        if (resolveAlgorithmList(spec, tables.defaults[category], tables.supported[category]).list.length === 0) {
            dropped.push(`${keyword}: ${value}`);
            continue;
        }
        result[category] = formatAlgorithmSpec(spec);
    }
    return {
        algorithms: Object.keys(result).length > 0 ? result : undefined,
        dropped,
    };
}

/** Format a parsed spec back into OpenSSH syntax. */
export function formatAlgorithmSpec(spec: AlgorithmSpec): string {
    const prefix = spec.mode === 'append' ? '+' : spec.mode === 'remove' ? '-' : spec.mode === 'prepend' ? '^' : '';
    return prefix + spec.names.join(',');
}
