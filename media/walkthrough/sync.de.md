> **Beta-Funktion** — Die Zuverlässigkeit der Synchronisierung hängt von VS Code Settings Sync ab. Wenn Verbindungen auf einem anderen Gerät nicht erscheinen, führen Sie *Verbindungen jetzt synchronisieren (Beta)* manuell aus.

**So funktioniert die geräteübergreifende Synchronisierung:**

1. Aktivieren Sie das Master-Passwort auf allen Geräten (verwenden Sie überall **dasselbe Passwort**)
2. Melden Sie sich auf allen Geräten bei VS Code Settings Sync an
3. Aktivieren Sie `remoteBridge.security.syncConnections` in den Einstellungen

Verbindungen werden automatisch anhand von Zeitstempeln zusammengeführt – es gehen keine Daten verloren. Löschungen werden 30 Tage lang verfolgt, sodass eine auf einem Gerät gelöschte Verbindung auch auf den anderen gelöscht bleibt.

**Hinweis:** Wenn Sie das Master-Passwort auf einem Gerät ändern, fordert Remote Bridge auf den anderen Geräten zur Entsperrung mit dem neuen Passwort auf.
