> **Beta funkce** — spolehlivost synchronizace závisí na VS Code Settings Sync. Pokud se připojení na druhém zařízení nezobrazují, spusťte *Synchronizovat připojení (Beta)* ručně.

**Jak funguje synchronizace mezi zařízeními:**

1. Povolte hlavní heslo na všech zařízeních (používejte **stejné heslo** všude)
2. Přihlaste se do VS Code Settings Sync na všech zařízeních
3. Povolte `remoteBridge.security.syncConnections` v Nastavení

Připojení se slučují automaticky pomocí časových razítek — žádná data nejsou ztracena. Smazání jsou sledována po dobu 30 dní, takže připojení smazané na jednom zařízení zůstane smazané i na ostatních.

**Poznámka:** Pokud změníte hlavní heslo na jednom zařízení, Remote Bridge vás na ostatních vyzve k odemčení novým heslem.
