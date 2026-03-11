**Támogatott importforrások:**

| Forrás | Mi kerül importálásra |
|---|---|
| SSH Config (`~/.ssh/config`) | Gazdagép, port, felhasználó, identitásfájl, ügynök |
| WinSCP (`WinSCP.ini`) | SSH, SFTP, FTP, FTPS — beleértve a titkosított jelszavakat |
| SSH FS (VS Code bővítmény) | Minden konfigurált távoli kiszolgáló |
| FileZilla (`sitemanager.xml`) | FTP, SFTP, FTPS — Base64 jelszavak automatikus dekódolással |
| PuTTY (registry / `~/.putty`) | SSH munkamenetek — kulcsútvonalak megőrzésével |
| Total Commander (`wcx_ftp.ini`) | FTP, FTPS — jelszavak de-obfuszkálva |

**Tipp:** A kapcsolatokat később is exportálhatja a *Remote Bridge: Kapcsolatok exportálása* menüponton keresztül — JSON formátumban (újra importálható) vagy SSH Config formátumban.
