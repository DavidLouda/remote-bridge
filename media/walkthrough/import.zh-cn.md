**支持的导入来源：**

| 来源 | 导入的内容 |
|---|---|
| SSH Config (`~/.ssh/config`) | 主机、端口、用户、身份文件、代理 |
| WinSCP (`WinSCP.ini`) | SSH、SFTP、FTP、FTPS — 包括加密密码 |
| SSH FS（VS Code 扩展） | 所有已配置的远程服务器 |
| FileZilla (`sitemanager.xml`) | FTP、SFTP、FTPS — Base64 密码自动解码 |
| PuTTY（注册表 / `~/.putty`） | SSH 会话 — 保留密钥路径 |
| Total Commander (`wcx_ftp.ini`) | FTP、FTPS — 密码去混淆 |

**提示：** 您也可以稍后通过 *Remote Bridge: 导出连接* 导出连接 — 为 JSON 格式（可重新导入）或 SSH Config 格式。
