---
name: remote-bridge
description: >
  Use when working with remote servers connected via Remote Bridge (SSH, SFTP, FTP, FTPS).
  Covers reading files, searching file contents, finding files by name, running shell commands,
  and editing remote files. Activate when the user wants to read, search, find, edit, create,
  rename, delete files, run commands, manage services, or deploy on a remote server.
user-invocable: false
---

# Remote Bridge — Tool Usage Guide

Remote Bridge mounts remote server file systems into VS Code via the `remote-bridge://` scheme. Three server-side tools provide fast reading, searching, and command execution. File editing uses VS Code's native tools through the filesystem provider.

## Reading files — `#tool:remoteRead`

Reads file contents on the remote server. The `path` must be an **absolute server path** (e.g. `/www/mysite/file.php`), never a `remote-bridge://` URI.

**Choose the right mode:**

| Mode | When to use | Parameters |
|------|-------------|------------|
| **Search** (preferred for large files) | Find specific code, patterns, function definitions | `search` (+ optional `contextLines`, `maxResults`) |
| **Line range** | Read a known section after finding line numbers via search | `startLine`, `endLine` |
| **Tail** | Check end of logs, recent entries | `tail` |
| **Full read** | Small files only (auto-truncated at 2000 lines) | just `path` |

**Best practice for large files:** Use search mode first to get line numbers, then line range to read the surrounding context. Never read entire large files when you only need specific sections.

## Searching across files — `#tool:remoteSearch`

Searches on the remote server (grep/find). The `path` must be an **absolute server directory path**.

**Two modes — use exactly one:**

| Mode | When to use | Parameters |
|------|-------------|------------|
| **Content search** | Find text/regex inside files | `pattern` (+ optional `namePattern` to filter by file type) |
| **File name search** | Find files/directories by glob | `namePattern` only (no `pattern`) |

**Tips:**
- Multi-pattern: use regex alternation — `pattern="word1|word2|word3"`
- Filter by file type: `namePattern="*.php"` with content search
- Exclude directories: `excludePattern="node_modules"` — works in both modes (skips matching directories in content search, skips matching paths in file name search)
- Search a single known file: use `remoteRead` with `search` instead
- To search within a single file, always prefer `remoteRead` with `search` over `remoteSearch`

## Running commands — `#tool:remoteRun`

Executes shell commands on the remote server via SSH.

**Use for:** builds, tests, service management (`systemctl restart`), package management (`apt`, `composer`, `npm`), permissions (`chmod`, `chown`), git, diagnostics.

**Blocked — the extension returns an error instead of executing:**
- Reading files (`cat`, `head`, `tail`) → use `remoteRead`
- Searching files (`grep`, `find`, `awk`) → use `remoteRead` with `search` or `remoteSearch`
- Writing/editing files (`echo >`, `sed -i`, `tee`) → use VS Code native file editing tools
- Destructive/dangerous commands (`halt`, `shutdown`, `reboot`, `rm -rf /`, `mkfs`, `dd if=`, fork bombs, `iptables -F`) → ask the user to run these manually via SSH terminal

## Editing remote files — VS Code native tools

Remote files are mounted as `remote-bridge://` workspace files. To write, edit, or create files, use VS Code's built-in file editing tools — the same ones used for local files. Changes are written directly to the remote server through the filesystem provider.

**SSH write commands (`echo >`, `sed -i`, `tee`, `python3 -c`) are blocked by the extension.** Always use VS Code native file editing tools instead.

**Before editing:** always read the relevant section first with `remoteRead` to get the exact current content.

## Rules

1. Always prefer `remoteRead` over reading through the filesystem provider — it runs server-side and is faster.
2. Always use `remoteSearch` for multi-file searches — it runs grep/find server-side.
3. Never use `remoteRun` to read, search, or write files.
4. Never delegate file operations to subagents — they do not have access to Remote Bridge tools and fall back to slow generic VS Code tools.
5. For large files: `remoteRead` with `search` first → get line numbers → `remoteRead` with `startLine`/`endLine`.
