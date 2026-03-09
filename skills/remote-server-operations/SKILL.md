---
name: remote-server-operations
description: >
  Manages files, directories, and databases on remote servers via SSH, SFTP, or FTP.
  Activate when the user wants to list, read, write, search, find, copy, rename,
  delete files, create directories, get file info, run shell commands, or query
  MySQL/MariaDB databases on a remote server.
user-invocable: false
---

# Remote Server Operations

## Core Principle

Use dedicated tools for all file and database operations. Use `runCommand` **only** for tasks without a dedicated tool (builds, tests, service control, package management, custom scripts).

## File Editing Patterns

**Search/replace (preferred for edits):**
Use `writeFile` with `search` + `content` to find and replace text. No line numbers needed. Supports multi-line search strings. Add `replaceAll: true` to replace all occurrences at once.

**Insert relative to existing code:**
Use `writeFile` with `search` + `content` + `insertPosition` (`'before'` or `'after'`) to add new content near existing text without removing it. Ideal for adding imports, CSS rules, or function definitions.

**Append to end of file:**
Use `writeFile` with `mode: 'append'` to add content at the end without reading the file first.

**Navigate large files:**
Use `readFile` with `search` to find specific code — runs grep server-side, returns only matching lines with line numbers and context. Use `tail` to read the last N lines.

**Multi-file search:**
Use `searchFiles` to search across multiple files. For searching within a single file, use `readFile` with `search` instead.

## Important

Never use local tools (PowerShell, local grep, local file reads, replace_string_in_file, multi_replace_string_in_file) for remote files. To edit remote files, use `writeFile` with `search` + `content`. Never rewrite an entire file just to change a few lines.

## MySQL Credentials

MySQL tools accept optional `user`, `password`, and `host` parameters. If MySQL authentication fails, search for credentials in config files (`configuration.php`, `wp-config.php`, `.env`, `app/etc/env.php`, `settings.php`) using `readFile` with `search`, then pass them to the MySQL tools. If nothing works, ask the user.

