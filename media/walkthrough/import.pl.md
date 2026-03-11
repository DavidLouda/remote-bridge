**Obsługiwane źródła importu:**

| Źródło | Co jest importowane |
|---|---|
| SSH Config (`~/.ssh/config`) | Host, port, użytkownik, plik tożsamości, agent |
| WinSCP (`WinSCP.ini`) | SSH, SFTP, FTP, FTPS — w tym zaszyfrowane hasła |
| SSH FS (rozszerzenie VS Code) | Wszystkie skonfigurowane zdalne serwery |
| FileZilla (`sitemanager.xml`) | FTP, SFTP, FTPS — hasła Base64 dekodowane automatycznie |
| PuTTY (rejestr / `~/.putty`) | Sesje SSH — ścieżki kluczy zachowane |
| Total Commander (`wcx_ftp.ini`) | FTP, FTPS — hasła de-obfuskowane |

**Wskazówka:** Możesz też wyeksportować połączenia później przez *Remote Bridge: Eksportuj połączenia* — do formatu JSON (możliwość ponownego importu) lub formatu SSH Config.
