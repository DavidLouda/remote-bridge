**対応インポートソース：**

| ソース | インポートされる内容 |
|---|---|
| SSH Config (`~/.ssh/config`) | ホスト、ポート、ユーザー、ID ファイル、エージェント |
| WinSCP (`WinSCP.ini`) | SSH、SFTP、FTP、FTPS — 暗号化されたパスワードを含む |
| SSH FS (VS Code 拡張機能) | すべての設定済みリモート |
| FileZilla (`sitemanager.xml`) | FTP、SFTP、FTPS — Base64 パスワードを自動デコード |
| PuTTY (レジストリ / `~/.putty`) | SSH セッション — 鍵のパスを保持 |
| Total Commander (`wcx_ftp.ini`) | FTP、FTPS — パスワードのデオブファスケーション |

**ヒント：** 接続は後から *Remote Bridge: 接続をエクスポート* を使って JSON 形式（再インポート可能）または SSH Config 形式でエクスポートすることもできます。
