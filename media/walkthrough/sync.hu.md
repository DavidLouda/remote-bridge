> **Béta funkció** — a szinkronizálás megbízhatósága a VS Code Settings Synctől függ. Ha a kapcsolatok nem jelennek meg egy másik eszközön, futtassa manuálisan a *Kapcsolatok szinkronizálása most (Béta)* parancsot.

**Hogyan működik az eszközök közötti szinkronizálás:**

1. Engedélyezze a mesterjelszót az összes eszközén (használja ugyanazt a **jelszót** mindenhol)
2. Jelentkezzen be a VS Code Settings Syncbe az összes eszközén
3. Engedélyezze a `remoteBridge.security.syncConnections` beállítást

A kapcsolatok automatikusan összevonódnak elemenként lévő időbélyegek alapján — nem vész el adat. A törlések 30 napig követhetők, így az egyik eszközön törölt kapcsolat a többi eszközön is törölt marad.

**Megjegyzés:** Ha megváltoztatja a mesterjelszót az egyik eszközön, a Remote Bridge a többi eszközön felkéri az új jelszóval való feloldásra.
