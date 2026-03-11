**Podporované zdroje importu:**

| Zdroj | Čo sa importuje |
|---|---|
| SSH Config (`~/.ssh/config`) | Hostiteľ, port, používateľ, súbor kľúča, agent |
| WinSCP (`WinSCP.ini`) | SSH, SFTP, FTP, FTPS – vrátane šifrovaných hesiel |
| SSH FS (rozšírenie VS Code) | Všetky nakonfigurované vzdialené servery |
| FileZilla (`sitemanager.xml`) | FTP, SFTP, FTPS – heslá Base64 dekódované automaticky |
| PuTTY (register / `~/.putty`) | SSH relácie – cesty ku kľúčom zachované |
| Total Commander (`wcx_ftp.ini`) | FTP, FTPS – heslá de-obfuskované |

**Tip:** Pripojenia môžete tiež exportovať neskôr cez *Remote Bridge: Exportovať pripojenia* — do formátu JSON (opätovne importovateľný) alebo formátu SSH Config.
