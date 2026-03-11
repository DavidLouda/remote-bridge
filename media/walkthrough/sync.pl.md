> **Funkcja Beta** — niezawodność synchronizacji zależy od VS Code Settings Sync. Jeśli połączenia nie pojawiają się na innym urządzeniu, uruchom *Synchronizuj połączenia teraz (Beta)* ręcznie.

**Jak działa synchronizacja między urządzeniami:**

1. Włącz hasło główne na wszystkich urządzeniach (używaj **tego samego hasła** wszędzie)
2. Zaloguj się do VS Code Settings Sync na wszystkich urządzeniach
3. Włącz `remoteBridge.security.syncConnections` w Ustawieniach

Połączenia są łączone automatycznie przy użyciu znaczników czasu — żadne dane nie są tracone. Usunięcia są śledzone przez 30 dni, dzięki czemu połączenie usunięte na jednym urządzeniu pozostaje usunięte na pozostałych.

**Uwaga:** Jeśli zmienisz hasło główne na jednym urządzeniu, Remote Bridge poprosi o odblokowanie nowym hasłem na pozostałych.
