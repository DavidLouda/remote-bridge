**Sources d'importation prises en charge :**

| Source | Ce qui est importé |
|---|---|
| SSH Config (`~/.ssh/config`) | Hôte, port, utilisateur, fichier d'identité, agent |
| WinSCP (`WinSCP.ini`) | SSH, SFTP, FTP, FTPS — y compris les mots de passe chiffrés |
| SSH FS (extension VS Code) | Tous les distants configurés |
| FileZilla (`sitemanager.xml`) | FTP, SFTP, FTPS — mots de passe Base64 décodés automatiquement |
| PuTTY (registre / `~/.putty`) | Sessions SSH — chemins de clés préservés |
| Total Commander (`wcx_ftp.ini`) | FTP, FTPS — mots de passe désobfusqués |

**Conseil :** Vous pouvez également exporter vos connexions ultérieurement via *Remote Bridge : Exporter les connexions* — au format JSON (ré-importable) ou au format SSH Config.
