> **Beta feature** — sync reliability depends on VS Code Settings Sync. If connections are not appearing on another device, run *Sync Connections Now (Beta)* manually.

**How cross-device sync works:**

1. Enable master password on all your devices (use the **same password** everywhere)
2. Sign into VS Code Settings Sync on all devices
3. Enable `remoteBridge.security.syncConnections` in Settings

Connections are merged automatically using per-item timestamps — no data is ever lost. Deletions are tracked for 30 days so a connection deleted on one device stays deleted on the others.

**Note:** If you change the master password on one device, Remote Bridge will prompt you to unlock with the new password on the others.
