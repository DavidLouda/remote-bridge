# Changelog

All notable changes to the **Remote Bridge** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.3.0] - 2026-04-02

### Added
- **Per-connection default permissions for new files and directories** — the connection form now includes a permission matrix for newly created files and directories. Leave all boxes unchecked to keep the server default (`umask`); otherwise the selected Unix mode is applied on create for SSH/SFTP and FTP/FTPS connections.

### Fixed
- **Copy now preserves permissions** — duplicating files and directories through the VS Code file system provider now keeps the source mode instead of falling back to the server default. SSH/SFTP uses native remote copy, FTP/FTPS performs a recursive copy and reapplies source permissions.
- **Configured permission defaults can now be cleared when editing a connection** — removing all permission checkboxes correctly resets the stored per-connection default instead of silently keeping the previous mode.

## [3.2.0] - 2026-03-31

### Added
- **Jump Host (ProxyJump) support** *(Beta — currently under testing)* — connect to servers that are only accessible through a bastion / jump host using standard SSH port forwarding. Configure per connection in **Advanced → Use Jump Host (ProxyJump)**. Supported authentication methods on the jump host: Password, Private Key, SSH Agent. Jump host passwords and passphrases are stored in VS Code SecretStorage. Mutually exclusive with Proxy.
- **SSH Config import — ProxyJump** — importing `~/.ssh/config` entries with `ProxyJump` now maps them to a Jump Host configuration automatically (first hop only for multi-hop chains).

## [3.1.1] - 2026-03-31

### Fixed
- **False-positive dangerous-command block** — shell comment lines (lines starting with `#`) are now stripped before checking commands against the dangerous-keyword list. Previously a multi-line script whose comment contained words like `reboot` or `shutdown` (e.g. `# Device needs reboot to apply firmware`) was incorrectly blocked, even though the actual command (e.g. `sed -n '…p' /file.py`) was completely harmless.
- **Full SSH Access — agent mode awareness** — the AI agent now receives a note in `remoteRun` results indicating that Full SSH Access is active, so it no longer self-limits write/read commands based on static assumptions. `remoteRead` and `remoteSearch` tool descriptions clarified to mention Full SSH Access path bypass. "Path outside workspace root" errors now include a hint about enabling Full SSH Access.
- **Agent skill — `remote-bridge://` URI guidance** — the skill now explicitly instructs the agent to use `remote-bridge://` URIs when creating or editing files, preventing accidental creation of local files instead of remote ones.

## [3.1.0] - 2026-03-20

### Added
- **Full SSH Access per connection** — new per-connection option in the Advanced section of the connection form (SSH/SFTP only). When enabled, the AI agent (`@bridge`) can read, search, and run commands anywhere on the server — not just within the configured workspace root. Enables server administration tasks such as installing packages (`apt install`, `composer`, `npm`), editing system configuration files (`/etc/nginx/nginx.conf`, `/etc/cron.d/…`), managing services, and inspecting logs outside the project directory. Destructive commands (`halt`, `shutdown`, `reboot`, `rm -rf /`, `mkfs`, `dd`, fork bombs, `iptables -F`) remain blocked regardless of this setting.
- **Temporary Write Permission** — new opt-in setting `remoteBridge.files.temporaryWritePermission` (default `false`). When enabled, saving a read-only remote file (owner-write bit not set) automatically and temporarily elevates permissions (`chmod u+w`) before the write and restores the original mode in a `finally` block afterward — even if the write fails. Supported for SSH/SFTP (via SFTP `chmod`) and FTP/FTPS (via `SITE CHMOD`). On FTP servers that do not support `SITE CHMOD`, a clear error is shown instead of silently failing. The `writeAppend` shell helper gains the same guard for SSH connections.

## [3.0.0] - 2026-03-17

After two releases of growing the AI toolset to 15 dedicated tools, it became clear that more tools is not always better — the agent would get tangled choosing between them and occasionally fight the extension's own safety rails. Version 3.0 strips it back to three universal, always-on tools and enforces what the agent should and should not do at the code level.

### Added
- **Proxy support** — SOCKS4, SOCKS5, and HTTP CONNECT proxy for SSH/SFTP and FTP/FTPS connections. Configure per connection in the connection form. Passwords stored in VS Code SecretStorage. Note: for FTP/FTPS, only the control connection is tunnelled through HTTP CONNECT proxy; SOCKS4/5 works fully for both.
- **Change Permissions** — right-click any file or folder → **Change Permissions** to set Unix permissions in octal (e.g. `755`). Current mode is pre-filled and shown in symbolic notation (e.g. `rw-r--r--`). Supports SSH/SFTP and FTP/FTPS. Also available via the Command Palette.
- **Dangerous command protection** — `#remoteRun` hard-blocks destructive commands (`halt`, `shutdown`, `reboot`, `rm -rf /`, `mkfs`, `dd`, fork bombs, `iptables -F` and others) before they reach the server.
- **Read/search command redirection** — `#remoteRun` blocks `grep`, `cat`, `head`, `tail`, `find` and similar, directing the agent to `#remoteRead` / `#remoteSearch` instead.
- **Agent skill** — built-in orchestration skill teaches the model when and how to use each tool correctly.
- **`#remoteRead` improvements** — new `maxResults` parameter (default: 50); large files show a 50-line preview with an explicit prompt to use `search` instead of falling back to grep via `#remoteRun`.

### Changed
- **AI toolset reduced from 15 to 3** — only `#remoteRead`, `#remoteSearch`, and `#remoteRun` remain, all always-on. `remoteBridge.ai.enabled` removed. `#remoteSearch` now covers both content search (grep) and file-name search (find). Active connection is auto-detected — `#remoteConnections` removed.
- **Chat participant renamed `@remote` → `@bridge`** — eliminates the VS Code reserved-name warning.

### Fixed
- **Shell injection removed** — unused MySQL helper functions deleted; one of them (`mysqlExecInline`) contained a SQL injection vulnerability (SQL interpolated into an unquoted bash string).
- **Path validation hardened** — `file:///` check made case-insensitive; Windows UNC paths blocked; control characters in paths rejected.
- **Shell escaping** — single quotes in grep patterns and file globs now properly escaped; `find` grouping operators fixed; numeric parameters (`maxResults`, `contextLines`) clamped to prevent negative values producing invalid shell syntax.
- **Glob correctness** — `*` no longer crosses directory separators; `[!pattern]` negation now correctly produces `[^pattern]`.
- **`excludePattern` in content search** — previously ignored in `#remoteSearch` grep mode; now maps to `--exclude-dir` / `-Exclude` on all platforms.
- **Blocked commands skip confirmation** — commands matching a blocking rule are rejected before the "Execute on server?" dialog is shown. `dd of=` (disk write) added to the block list alongside `dd if=`.
- **SSH keepalive `0` now correctly disables keepalive** — previously `keepaliveInterval: 0` was coerced to the default `10000 ms` due to a falsy `||` fallback.
- **Redundant SSH connection timeout removed** — the manual `setTimeout` safety wrapper inside the SSH connect promise duplicated `ssh2`'s own `readyTimeout: 30000` and could in rare cases produce a confusing second error after the library had already rejected the promise.

## [2.0.0] - 2026-03-11

### Added
- **Encrypted local backups** — the connection store is automatically backed up on every save when master password encryption is active (AES-256-GCM, same encryption as the live store; never synced). Retention: 7 daily + 4 weekly backups in VS Code's local global storage. New `Remote Bridge: Create Backup` command for on-demand backups and `Remote Bridge: Restore from Backup` (Command Palette or `⋯` overflow menu) to restore a selected backup by date and type; prompts for the old password if the backup was created with a different one.
- **Export Connections** — new `Remote Bridge: Export Connections` command (Command Palette or `⋯` overflow menu). Two formats: **JSON** (all connections and folder structure; optionally includes passwords with a security warning) or **SSH Config** (SSH/SFTP only; FTP/FTPS connections are skipped with a count in the result).
- **Configurable TLS certificate verification for FTPS** — new `Allow self-signed TLS certificates` checkbox in the connection form for FTP/FTPS connections. Default is full TLS verification — a security improvement over the previous behaviour where verification was always disabled. Enable only for servers with self-signed or invalid certificates; existing FTPS connections that relied on this must be edited to opt in.
- **Getting Started walkthrough** — a new interactive walkthrough (Command Palette → *Get Started*) guides new users through adding their first connection, setting up master password encryption, enabling cross-device sync, and importing from other SSH clients.
- **Master password onboarding hint** — after adding the very first connection without master password encryption active, a one-time notification suggests enabling it and explains the benefits (AES-256-GCM encryption, automatic backups, cross-device sync).
- **Master password UX** — the overflow menu and Command Palette now show `Set Master Password` only when encryption is off and `Change Master Password` only when it is on. Two new commands: `Lock Connections` (clears the decryption key from memory) and `Unlock Connections` (prompts for the master password). When connections are locked, the panel shows a *Connections are locked* message with an inline Unlock link instead of the empty-state UI.
- *(Beta)* **Connection sync** — new `remoteBridge.security.syncConnections` setting (default: `false`) bundles the encrypted store into VS Code Settings Sync so connections (including passwords) synchronize across devices. Requires master password; the same password must be used on every device. Connections are merged by timestamp (newer edit wins; local wins on tie); deletions are tracked as tombstones for 30 days. New `Remote Bridge: Sync Connections Now` command for a manual reload. On a fresh install, *Set Master Password* detects synced data and redirects to an unlock prompt rather than creating a new incompatible key; if a store encrypted with a different password arrives, the extension immediately prompts to unlock with the new one. The store is never overwritten with an empty result during transient decryption failures.

### Fixed
- **File permissions reset on save** — reported by [@dimuchios84](https://github.com/dimuchios84). SFTP's `createWriteStream()` and FTP's `uploadFrom()` do not preserve existing file permissions — files with stricter modes (e.g. 644) were reset to the server's default (typically 666) on every write. The adapter now reads the current mode before writing and restores it afterward: SFTP uses the `mode` option on `createWriteStream()`; FTP issues `SITE CHMOD` after upload (silently ignored if the server does not support it). New files are unaffected. Fix applies to both editor saves and AI tool operations.
- **File permissions reset on partial edit (macOS servers)** — insert, replace, and delete line operations on macOS remote servers did not restore the original permissions after the in-place rewrite (BSD `chmod` does not support `--reference`). The macOS shell commands now save the mode with `stat -f '%Lp'` before the operation and restore it with `chmod` afterward.

## [1.1.1] - 2026-03-09

### Fixed
- **Auto-port on protocol change** — switching the protocol in the connection form now automatically updates the port to its default value (SSH/SFTP → 22, FTP → 21, FTPS → 990) when adding a new connection. Manually entered ports are still preserved. Editing an existing connection also keeps the saved port unchanged.

## [1.1.0] - 2026-03-09

In practice, the dedicated AI tools (readFile, writeFile, searchFiles…) turned out to complicate the agent's work more than they helped — the agent would get stuck trying to use them even when a simple SSH command would be faster and more reliable. Starting with this version, AI tools are **disabled by default**. The agent still has full access via `runCommand` and `listConnections` and can call `cat`, `grep`, `sed`, `find`, `mysql`, and anything else over SSH — and it does so surprisingly well. If you prefer the dedicated tool approach, you can re-enable them in settings (`remoteBridge.ai.enabled`).

### Changed
- **AI tools disabled by default** — new `remoteBridge.ai.enabled` setting (default: `false`). 15 dedicated AI tools (file operations, database, search) are now opt-in. Without them the agent accesses servers through `runCommand` using native SSH commands, which in practice produces more reliable results. Enable in settings if you prefer the dedicated tool approach.
- `connectionName` is now auto-detected from the single active connection — no longer required on any tool

### Added
- **Import from FileZilla** — reads `sitemanager.xml` (auto-detected on Windows, Linux, and macOS); supports FTP, SFTP, and FTPS; decodes Base64-stored passwords; skips master-password-encrypted (`encoding="crypt"`) passwords with a warning; preserves Site Manager folder hierarchy
- **Import from PuTTY** — reads sessions from the Windows registry (`HKCU\Software\SimonTatham\PuTTY\Sessions`) on Windows and from `~/.putty/sessions/` on Linux/macOS; SSH only (telnet/serial/raw skipped with a warning); auth method inferred from `PublicKeyFile` and `AgentFwd` fields; private key path preserved
- **Import from Total Commander** — reads the built-in FTP plugin config `wcx_ftp.ini` from `%APPDATA%\GHISLER\`; supports FTP and FTPS; port parsed from the `host:port` field; passwords de-obfuscated (XOR cipher with `user@host` key)
- **File decorations in Explorer** — when AI tools are enabled, file changes made by the agent are tracked with colored badges in the VS Code Explorer:
  - **M** (yellow) — modified/edited
  - **A** (green) — added/created
  - **R** (teal) — renamed or moved
  - **D** (red) — deleted
  Badges propagate to parent folders for M/A changes so you can see at a glance which directory subtrees were affected. Tooltips are fully localized.
- **`getChangedFiles` LM tool** (`#remoteChanges`) — returns a badge-annotated list of all files changed during the current session (`[M]`, `[A]`, `[R]`, `[D]` with connection ID and path); designed for producing a change summary before finishing a task
- **`clearDecorations` LM tool** + **`remoteBridge.clearDecorations` command** — reset session change tracking and remove all Explorer badges
- **`writeFile` improvements** — `search`/replace mode (find and replace first occurrence, returns surrounding context for verification); `replaceAll` to replace all occurrences; `insertPosition` (`before`/`after`) to insert content relative to existing text without removing it; `append` mode to add content at end of file server-side
- **MySQL tools** — optional `user`, `password`, and `host` parameters on all three MySQL tools; passwords passed securely via `MYSQL_PWD` environment variable (hidden from process list)
- Shared `iniParser` utility extracted from the WinSCP importer — now used by the PuTTY and Total Commander importers

## [1.0.1] - 2026-03-04

### Fixed
- Test Connection button now correctly uses stored credentials when editing an existing connection
- Localized "Testing…" label in the connection form
- Corrected repository URL in package metadata

### Changed
- Added overview table to README for quick feature reference
- Added `THIRD-PARTY-LICENSES.md` with full license texts of production dependencies
- Updated copyright year to 2026

## [1.0.0] - 2026-03-03

Initial public release.

### Added
- Multi-protocol remote file system access: SSH, SFTP, FTP, FTPS
- Native VS Code workspace folder integration with auto-reconnect
- Interactive SSH terminal with full PTY support
- Connection manager with folders, drag & drop, multi-select, duplicate, and import (SSH config, WinSCP, SSH FS)
- Passwords and passphrases stored securely in VS Code SecretStorage
- Optional AES-256-GCM master password with auto-lock
- MySQL/MariaDB integration via SSH (query, modify, schema browser)
- GitHub Copilot chat participant `@bridge` with 15 LM tools for file operations, commands, and SQL
- Per-connection OS setting (Linux, macOS, Windows/PowerShell)
- File and directory listing cache with configurable TTL
- Connection pooling with idle timeout
- Localization in 12 languages: English, Czech, German, French, Spanish, Polish, Hungarian, Slovak, Ukrainian, Chinese (Simplified), Korean, Japanese

### Fixed
- Test Connection button now correctly falls back to SecretStorage when password/passphrase fields are empty (editing existing connections)
