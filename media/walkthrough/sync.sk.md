> **Beta funkcia** — spoľahlivosť synchronizácie závisí od VS Code Settings Sync. Ak sa pripojenia na inom zariadení nezobrazujú, spustite *Synchronizovať pripojenia teraz (Beta)* ručne.

**Ako funguje synchronizácia medzi zariadeniami:**

1. Povoľte hlavné heslo na všetkých zariadeniach (používajte **rovnaké heslo** všade)
2. Prihláste sa do VS Code Settings Sync na všetkých zariadeniach
3. Povoľte `remoteBridge.security.syncConnections` v Nastaveniach

Pripojenia sa zlučujú automaticky pomocou časových pečiatok — žiadne dáta sa nestratia. Vymazania sú sledované po dobu 30 dní, takže pripojenie zmazané na jednom zariadení zostane zmazané aj na ostatných.

**Poznámka:** Ak zmeníte hlavné heslo na jednom zariadení, Remote Bridge vás na ostatných vyzve na odomknutie novým heslom.
