# Changelog

All notable changes to the **Remote Bridge** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- GitHub Copilot chat participant `@remote` with 15 LM tools for file operations, commands, and SQL
- Per-connection OS setting (Linux, macOS, Windows/PowerShell)
- File and directory listing cache with configurable TTL
- Connection pooling with idle timeout
- Localization in 12 languages: English, Czech, German, French, Spanish, Polish, Hungarian, Slovak, Ukrainian, Chinese (Simplified), Korean, Japanese

### Fixed
- Test Connection button now correctly falls back to SecretStorage when password/passphrase fields are empty (editing existing connections)
