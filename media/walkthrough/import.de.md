**Unterstützte Importquellen:**

| Quelle | Was importiert wird |
|---|---|
| SSH Config (`~/.ssh/config`) | Host, Port, Benutzer, Identitätsdatei, Agent |
| WinSCP (`WinSCP.ini`) | SSH, SFTP, FTP, FTPS – einschließlich verschlüsselter Passwörter |
| SSH FS (VS Code-Erweiterung) | Alle konfigurierten Remotes |
| FileZilla (`sitemanager.xml`) | FTP, SFTP, FTPS – Base64-Passwörter automatisch dekodiert |
| PuTTY (Registrierung / `~/.putty`) | SSH-Sitzungen – Schlüsselpfade erhalten |
| Total Commander (`wcx_ftp.ini`) | FTP, FTPS – Passwörter de-obfuskiert |

**Tipp:** Sie können Ihre Verbindungen auch später über *Remote Bridge: Verbindungen exportieren* exportieren – im JSON-Format (re-importierbar) oder im SSH-Config-Format.
