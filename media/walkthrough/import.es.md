**Fuentes de importación compatibles:**

| Fuente | Qué se importa |
|---|---|
| SSH Config (`~/.ssh/config`) | Host, puerto, usuario, archivo de identidad, agente |
| WinSCP (`WinSCP.ini`) | SSH, SFTP, FTP, FTPS — incluidas contraseñas cifradas |
| SSH FS (extensión de VS Code) | Todos los remotos configurados |
| FileZilla (`sitemanager.xml`) | FTP, SFTP, FTPS — contraseñas Base64 decodificadas automáticamente |
| PuTTY (registro / `~/.putty`) | Sesiones SSH — rutas de claves conservadas |
| Total Commander (`wcx_ftp.ini`) | FTP, FTPS — contraseñas desofuscadas |

**Consejo:** También puede exportar sus conexiones más tarde a través de *Remote Bridge: Exportar conexiones* — en formato JSON (re-importable) o formato SSH Config.
