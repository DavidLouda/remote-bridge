**Supported import sources:**

| Source | What gets imported |
|---|---|
| SSH Config (`~/.ssh/config`) | Host, port, user, identity file, agent |
| WinSCP (`WinSCP.ini`) | SSH, SFTP, FTP, FTPS — including encrypted passwords |
| SSH FS (VS Code extension) | All configured remotes |
| FileZilla (`sitemanager.xml`) | FTP, SFTP, FTPS — Base64 passwords decoded automatically |
| PuTTY (registry / `~/.putty`) | SSH sessions — key paths preserved |
| Total Commander (`wcx_ftp.ini`) | FTP, FTPS — passwords de-obfuscated |

**Tip:** You can also export your connections later via *Remote Bridge: Export Connections* — to JSON (re-importable) or SSH Config format.
