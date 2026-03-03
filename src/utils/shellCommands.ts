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
export function esc(path: string, os: RemoteOS = 'linux'): string {
    if (os === 'windows') {
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
        // macOS: mktemp without -p, no chmod --reference (BSD)
        return `tmpf=$(mktemp) && trap 'rm -f "$tmpf"' EXIT && head -n ${startLine} ${p} > "$tmpf" && cat >> "$tmpf" && tail -n +${startLine + 1} ${p} >> "$tmpf" && mv "$tmpf" ${p}`;
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
        return `tmpf=$(mktemp) && trap 'rm -f "$tmpf"' EXIT && head -n ${startLine - 1} ${p} > "$tmpf" && tail -n +${endLine + 1} ${p} >> "$tmpf" && mv "$tmpf" ${p}`;
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
        return `tmpf=$(mktemp) && trap 'rm -f "$tmpf"' EXIT && head -n ${startLine - 1} ${p} > "$tmpf" && cat >> "$tmpf" && tail -n +${endLine + 1} ${p} >> "$tmpf" && mv "$tmpf" ${p}`;
    }
    return `tmpf=$(mktemp -p "$(dirname ${p})") && trap 'rm -f "$tmpf"' EXIT && head -n ${startLine - 1} ${p} > "$tmpf" && cat >> "$tmpf" && tail -n +${endLine + 1} ${p} >> "$tmpf" && chmod --reference=${p} "$tmpf" 2>/dev/null; mv "$tmpf" ${p}`;
}

// ─── grep / search ──────────────────────────────────────────────────

export function grepSearch(
    pattern: string,
    path: string,
    fileGlob: string | undefined,
    os: RemoteOS = 'linux'
): string {
    const escapedPattern = os === 'windows'
        ? pattern
        : pattern.replace(/'/g, "'\\''");
    const p = esc(path, os);

    if (os === 'windows') {
        // PowerShell Select-String
        let cmd = `Get-ChildItem -LiteralPath ${p} -Recurse`;
        if (fileGlob) {
            cmd += ` -Filter '${fileGlob}'`;
        }
        cmd += ` -File | Select-String -Pattern '${escapedPattern}' | Select-Object -First 100 | ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line)" }`;
        return cmd;
    }
    // Linux & macOS
    let cmd = `grep -rn -I --color=never`;
    if (fileGlob) {
        cmd += ` --include='${fileGlob}'`;
    }
    cmd += ` '${escapedPattern}' ${p} | head -n 100`;
    return cmd;
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
    const flag = recursive ? '-a' : '';
    return `cp ${flag} ${s} ${d} 2>&1`.replace(/  +/g, ' ');
}

// ─── find (file search by name) ─────────────────────────────────────

export function findCmd(
    path: string,
    namePattern: string,
    limit: number,
    os: RemoteOS = 'linux'
): string {
    const p = esc(path, os);
    if (os === 'windows') {
        const pat = namePattern.replace(/'/g, "''");
        return `Get-ChildItem -LiteralPath ${p} -Recurse -Depth 10 -Filter '${pat}' -ErrorAction SilentlyContinue | Select-Object -First ${limit} -ExpandProperty FullName`;
    }
    const escapedPattern = namePattern.replace(/'/g, "'\\''");
    return `find ${p} -maxdepth 10 \\( -name .git -o -name node_modules -o -name .svn -o -name __pycache__ -o -name .DS_Store \\) -prune -o -name '${escapedPattern}' -print 2>/dev/null | head -n ${limit}`;
}

// ─── mysql ──────────────────────────────────────────────────────────

/**
 * Build the base mysql command line.
 *
 * Uses `--no-defaults` instead of the previous `--defaults-file=<(echo '')`
 * to avoid bash process-substitution dependency. Works across bash, zsh,
 * and Windows (Git Bash / PowerShell with mysql in PATH).
 */
export function mysqlCmd(dbArg: string, _os: RemoteOS = 'linux'): string {
    return `mysql --no-defaults${dbArg} 2>&1`;
}

/**
 * Build a mysql -e "..." command for inline SQL.
 */
export function mysqlExecInline(sql: string, dbArg: string, _os: RemoteOS = 'linux'): string {
    return `mysql --no-defaults -e "${sql}"${dbArg} 2>&1`;
}
