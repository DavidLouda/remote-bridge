# Changelog

All notable changes to the **Remote Bridge** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
