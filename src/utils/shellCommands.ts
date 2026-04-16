import { RemoteOS } from '../types/connection';

/**
 * Centralised OS-aware shell command builder.
 *
 * Every tool that needs to execute a shell command on the remote server
 * should delegate to this module so that Linux / macOS / Windows
 * differences are handled in a single place.
 *
 * Convention: all public functions take `os` as the **last** parameter
 * and default to `'linux'` when undefined.
 */

// ─── Path escaping ──────────────────────────────────────────────────

/**
 * Escape a path for safe inclusion in a shell command.
 *
 * - Linux / macOS: wraps in single quotes, escaping embedded `'`.
 * - Windows (PowerShell): wraps in single quotes, doubling embedded `'`.
 */
export function esc(path: string, os: RemoteOS = 'linux'): string {    if (/[\x00-\x1f\x7f]/.test(path)) {
        throw new Error(`Path contains invalid control characters: ${JSON.stringify(path)}`);
    }    if (os === 'windows') {
        return `'${path.replace(/'/g, "''")}'`;
    }
    return `'${path.replace(/'/g, "'\\''")}'`;
}

// ─── rm -rf ─────────────────────────────────────────────────────────

export function rmRecursive(path: string, os: RemoteOS = 'linux'): string {
    const p = esc(path, os);
    if (os === 'windows') {
        return `Remove-Item -Recurse -Force -LiteralPath ${p}`;
    }
    return `rm -rf ${p}`;
}

// ─── Partial read (line range) ──────────────────────────────────────

export function readPartial(
    path: string,
    startLine: number,
    endArg: string, // number as string, or '$'
    os: RemoteOS = 'linux'
): string {
    const p = esc(path, os);
    if (os === 'windows') {
        // PowerShell: zero-indexed arrays
        const start0 = startLine - 1;
        if (endArg === '$') {
            return `$lines = Get-Content -LiteralPath ${p}; $lines.Count; $lines[${start0}..($lines.Count-1)] -join "\`n"`;
        }
        const end0 = Number(endArg) - 1;
        return `$lines = Get-Content -LiteralPath ${p}; $lines.Count; $lines[${start0}..${end0}] -join "\`n"`;
    }
    // Linux & macOS share the same commands
    return `_t=$(wc -l < ${p}) && echo "$_t" && sed -n '${startLine},${endArg}p' ${p}`;
}

// ─── Write helpers (insert / replace / delete lines) ────────────────

/**
 * Build a command that inserts `content` AFTER `startLine`.
 * Expects the caller to pipe `content` via stdin (execWithStdin).
 */
export function writeInsert(
    path: string,
    startLine: number,
    os: RemoteOS = 'linux'
): string {
    const p = esc(path, os);
    if (os === 'windows') {
        // PowerShell: read all lines, splice, write back. Content comes from stdin.
        return `$lines = @(Get-Content -LiteralPath ${p}); $new = @($input); $lines = $lines[0..${startLine - 1}] + $new + $lines[${startLine}..($lines.Count-1)]; $lines | Set-Content -LiteralPath ${p}`;
    }
    if (os === 'macos') {
        // macOS: mktemp without -p; use BSD stat -f '%Lp' instead of --reference
        return `perms=$(stat -f '%Lp' ${p}) && tmpf=$(mktemp) && trap 'rm -f "$tmpf"' EXIT && head -n ${startLine} ${p} > "$tmpf" && cat >> "$tmpf" && tail -n +${startLine + 1} ${p} >> "$tmpf" && chmod "$perms" "$tmpf" 2>/dev/null; mv "$tmpf" ${p}`;
    }
    // Linux
    return `tmpf=$(mktemp -p "$(dirname ${p})") && trap 'rm -f "$tmpf"' EXIT && head -n ${startLine} ${p} > "$tmpf" && cat >> "$tmpf" && tail -n +${startLine + 1} ${p} >> "$tmpf" && chmod --reference=${p} "$tmpf" 2>/dev/null; mv "$tmpf" ${p}`;
}

/**
 * Build a command that deletes lines [startLine..endLine] (1-based, inclusive).
 * No stdin required.
 */
export function writeDelete(
    path: string,
    startLine: number,
    endLine: number,
    os: RemoteOS = 'linux'
): string {
    const p = esc(path, os);
    if (os === 'windows') {
        return `$lines = @(Get-Content -LiteralPath ${p}); $lines = $lines[0..${startLine - 2}] + $lines[${endLine}..($lines.Count-1)]; $lines | Set-Content -LiteralPath ${p}`;
    }
    if (os === 'macos') {
        return `perms=$(stat -f '%Lp' ${p}) && tmpf=$(mktemp) && trap 'rm -f "$tmpf"' EXIT && head -n ${startLine - 1} ${p} > "$tmpf" && tail -n +${endLine + 1} ${p} >> "$tmpf" && chmod "$perms" "$tmpf" 2>/dev/null; mv "$tmpf" ${p}`;
    }
    return `tmpf=$(mktemp -p "$(dirname ${p})") && trap 'rm -f "$tmpf"' EXIT && head -n ${startLine - 1} ${p} > "$tmpf" && tail -n +${endLine + 1} ${p} >> "$tmpf" && chmod --reference=${p} "$tmpf" 2>/dev/null; mv "$tmpf" ${p}`;
}

/**
 * Build a command that replaces lines [startLine..endLine] with content from stdin.
 * Expects the caller to pipe new content via stdin (execWithStdin).
 */
export function writeReplace(
    path: string,
    startLine: number,
    endLine: number,
    os: RemoteOS = 'linux'
): string {
    const p = esc(path, os);
    if (os === 'windows') {
        return `$lines = @(Get-Content -LiteralPath ${p}); $new = @($input); $lines = $lines[0..${startLine - 2}] + $new + $lines[${endLine}..($lines.Count-1)]; $lines | Set-Content -LiteralPath ${p}`;
    }
    if (os === 'macos') {
        return `perms=$(stat -f '%Lp' ${p}) && tmpf=$(mktemp) && trap 'rm -f "$tmpf"' EXIT && head -n ${startLine - 1} ${p} > "$tmpf" && cat >> "$tmpf" && tail -n +${endLine + 1} ${p} >> "$tmpf" && chmod "$perms" "$tmpf" 2>/dev/null; mv "$tmpf" ${p}`;
    }
    return `tmpf=$(mktemp -p "$(dirname ${p})") && trap 'rm -f "$tmpf"' EXIT && head -n ${startLine - 1} ${p} > "$tmpf" && cat >> "$tmpf" && tail -n +${endLine + 1} ${p} >> "$tmpf" && chmod --reference=${p} "$tmpf" 2>/dev/null; mv "$tmpf" ${p}`;
}

// ─── grep / search ──────────────────────────────────────────────────

export function grepSearch(
    pattern: string,
    path: string,
    fileGlob: string | undefined,
    os: RemoteOS = 'linux',
    contextLines: number = 0,
    caseSensitive: boolean = false,
    maxResults: number = 100,
    excludePattern?: string
): string {
    maxResults = Math.max(1, maxResults);
    contextLines = Math.max(0, contextLines);
    const escapedPattern = os === 'windows'
        ? pattern.replace(/'/g, "''")
        : pattern.replace(/'/g, "'\\''");
    const p = esc(path, os);

    if (os === 'windows') {
        // PowerShell Select-String
        let cmd = `Get-ChildItem -LiteralPath ${p} -Recurse`;
        if (fileGlob) {
            cmd += ` -Filter '${fileGlob.replace(/'/g, "''")}'`;
        }
        if (excludePattern) {
            cmd += ` -Exclude '${excludePattern.replace(/'/g, "''")}'`;
        }
        const csFlag = caseSensitive ? '-CaseSensitive ' : '';
        const ctxFlag = contextLines > 0 ? `-Context ${contextLines},${contextLines} ` : '';
        cmd += ` -File | Select-String ${csFlag}${ctxFlag}-Pattern '${escapedPattern}' | Select-Object -First ${maxResults}`;
        if (contextLines > 0) {
            cmd += ` | ForEach-Object { $_.ToString() }`;
        } else {
            cmd += ` | ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line)" }`;
        }
        return cmd;
    }
    // Linux & macOS
    let cmd = `grep -rn -E -I --color=never`;
    if (!caseSensitive) {
        cmd += ' -i';
    }
    if (contextLines > 0) {
        cmd += ` -C ${contextLines}`;
    }
    if (fileGlob) {
        cmd += ` --include='${fileGlob.replace(/'/g, "'\\''")}'`;
    }
    if (excludePattern) {
        cmd += ` --exclude-dir='${excludePattern.replace(/'/g, "'\\''")}'`;
    }
    cmd += ` '${escapedPattern}' ${p} | head -n ${maxResults}`;
    return cmd;
}

// ─── grep in single file (readFile search mode) ─────────────────────

export function grepInFile(
    pattern: string,
    path: string,
    contextLines: number = 3,
    os: RemoteOS = 'linux',
    maxResults: number = 50
): string {
    maxResults = Math.max(1, maxResults);
    contextLines = Math.max(0, contextLines);
    const escapedPattern = os === 'windows'
        ? pattern.replace(/'/g, "''")
        : pattern.replace(/'/g, "'\\''");
    const p = esc(path, os);

    if (os === 'windows') {
        const ctxFlag = contextLines > 0 ? `-Context ${contextLines},${contextLines} ` : '';
        return `$lines = Get-Content -LiteralPath ${p}; $lines.Count; Select-String -InputObject ($lines -join "\n") ${ctxFlag}-Pattern '${escapedPattern}' -AllMatches | Select-Object -First ${maxResults} | ForEach-Object { $_.ToString() }`;
    }
    // Linux & macOS: line count + grep with context
    let cmd = `_t=$(wc -l < ${p}) && echo "$_t" && grep -n -E -I --color=never`;
    if (contextLines > 0) {
        cmd += ` -C ${contextLines}`;
    }
    cmd += ` -m ${maxResults} '${escapedPattern}' ${p}`;
    return cmd;
}

// ─── tail (readFile tail mode) ──────────────────────────────────────

export function tailRead(
    path: string,
    lines: number,
    os: RemoteOS = 'linux'
): string {
    const p = esc(path, os);
    if (os === 'windows') {
        return `$lines = Get-Content -LiteralPath ${p}; $lines.Count; $lines | Select-Object -Last ${lines}`;
    }
    return `_t=$(wc -l < ${p}) && echo "$_t" && tail -n ${lines} ${p}`;
}

// ─── append (writeFile append mode) ─────────────────────────────────

/**
 * Build a command that appends stdin content to the end of a file.
 * Expects the caller to pipe content via stdin (execWithStdin).
 * When `temporaryWrite` is true, the owner-write bit is added before appending
 * and the original permissions are restored afterward.
 */
export function writeAppend(
    path: string,
    os: RemoteOS = 'linux',
    temporaryWrite: boolean = false
): string {
    const p = esc(path, os);
    if (os === 'windows') {
        if (temporaryWrite) {
            return `$_ro = (Get-Item -LiteralPath ${p}).IsReadOnly; Set-ItemProperty -LiteralPath ${p} -Name IsReadOnly -Value $false; $input | Add-Content -LiteralPath ${p}; if ($_ro) { Set-ItemProperty -LiteralPath ${p} -Name IsReadOnly -Value $true }`;
        }
        return `$input | Add-Content -LiteralPath ${p}`;
    }
    if (temporaryWrite) {
        if (os === 'macos') {
            return `_perms=$(stat -f '%Lp' ${p}) && chmod u+w ${p} && cat >> ${p}; chmod "$_perms" ${p} 2>/dev/null`;
        }
        return `_perms=$(stat -c '%a' ${p}) && chmod u+w ${p} && cat >> ${p}; chmod "$_perms" ${p} 2>/dev/null`;
    }
    return `cat >> ${p}`;
}

// ─── stat (permissions) ─────────────────────────────────────────────

export function statPermissions(path: string, os: RemoteOS = 'linux'): string {
    const p = esc(path, os);
    if (os === 'windows') {
        return `(Get-Acl -LiteralPath ${p}).AccessToString`;
    }
    if (os === 'macos') {
        return `stat -f '%Sp %Su:%Sg' ${p} 2>/dev/null || ls -ld ${p} 2>/dev/null | head -1`;
    }
    return `stat -c '%A %U:%G' ${p} 2>/dev/null || ls -ld ${p} 2>/dev/null | head -1`;
}

// ─── cp (copy) ──────────────────────────────────────────────────────

export function copyCmd(
    src: string,
    dst: string,
    recursive: boolean,
    os: RemoteOS = 'linux'
): string {
    const s = esc(src, os);
    const d = esc(dst, os);
    if (os === 'windows') {
        return recursive
            ? `Copy-Item -LiteralPath ${s} -Destination ${d} -Recurse -Force`
            : `Copy-Item -LiteralPath ${s} -Destination ${d} -Force`;
    }
    const flag = recursive
        ? (os === 'macos' ? '-Rp' : '-a')
        : '-p';
    return `cp ${flag} ${s} ${d} 2>&1`.replace(/  +/g, ' ');
}

// ─── find (file search by name) ─────────────────────────────────────

export function findCmd(
    path: string,
    namePattern: string,
    limit: number,
    os: RemoteOS = 'linux',
    type?: 'file' | 'directory',
    excludePattern?: string
): string {
    limit = Math.max(1, limit);
    const p = esc(path, os);
    if (os === 'windows') {
        const pat = namePattern.replace(/'/g, "''");
        let cmd = `Get-ChildItem -LiteralPath ${p} -Recurse -Depth 10 -Filter '${pat}' -ErrorAction SilentlyContinue`;
        if (type === 'file') {
            cmd += ' -File';
        } else if (type === 'directory') {
            cmd += ' -Directory';
        }
        cmd += ` | Select-Object -First ${limit} -ExpandProperty FullName`;
        return cmd;
    }
    const escapedPattern = namePattern.replace(/'/g, "'\\''");
    let pruneList = '\\( -name .git -o -name node_modules -o -name .svn -o -name __pycache__ -o -name .DS_Store \\) -prune';
    if (excludePattern) {
        const escapedExclude = excludePattern.replace(/'/g, "'\\''");
        pruneList += ` -o -path '${escapedExclude}' -prune`;
    }
    let typeFilter = '';
    if (type === 'file') {
        typeFilter = ' -type f';
    } else if (type === 'directory') {
        typeFilter = ' -type d';
    }
    return `find ${p} -maxdepth 10 ${pruneList} -o${typeFilter} -name '${escapedPattern}' -print 2>/dev/null | head -n ${limit}`;
}
