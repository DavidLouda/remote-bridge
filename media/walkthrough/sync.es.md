> **Función Beta** — la fiabilidad de la sincronización depende de VS Code Settings Sync. Si las conexiones no aparecen en otro dispositivo, ejecute *Sincronizar conexiones ahora (Beta)* manualmente.

**Cómo funciona la sincronización entre dispositivos:**

1. Active la contraseña maestra en todos sus dispositivos (use la **misma contraseña** en todas partes)
2. Inicie sesión en VS Code Settings Sync en todos los dispositivos
3. Active `remoteBridge.security.syncConnections` en la Configuración

Las conexiones se fusionan automáticamente usando marcas de tiempo por elemento — no se pierden datos. Las eliminaciones se rastrean durante 30 días, por lo que una conexión eliminada en un dispositivo permanece eliminada en los demás.

**Nota:** Si cambia la contraseña maestra en un dispositivo, Remote Bridge le pedirá que desbloquee con la nueva contraseña en los demás.
