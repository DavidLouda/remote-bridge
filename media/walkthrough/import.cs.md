**Podporované zdroje importu:**

| Zdroj | Co se importuje |
|---|---|
| SSH Config (`~/.ssh/config`) | Host, port, uživatel, soubor klíče, agent |
| WinSCP (`WinSCP.ini`) | SSH, SFTP, FTP, FTPS – včetně šifrovaných hesel |
| SSH FS (rozšíření VS Code) | Všechny nakonfigurované vzdálené servery |
| FileZilla (`sitemanager.xml`) | FTP, SFTP, FTPS – hesla Base64 dekódována automaticky |
| PuTTY (registr / `~/.putty`) | SSH relace – cesty ke klíčům zachovány |
| Total Commander (`wcx_ftp.ini`) | FTP, FTPS – hesla de-obfuskována |

**Tip:** Připojení můžete také kdykoliv exportovat přes *Remote Bridge: Exportovat připojení* — do formátu JSON (znovu importovatelný) nebo SSH Config.
