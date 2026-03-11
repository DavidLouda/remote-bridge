> **Fonctionnalité Bêta** — la fiabilité de la synchronisation dépend de VS Code Settings Sync. Si les connexions n'apparaissent pas sur un autre appareil, exécutez *Synchroniser les connexions maintenant (Bêta)* manuellement.

**Comment fonctionne la synchronisation entre appareils :**

1. Activez le mot de passe maître sur tous vos appareils (utilisez le **même mot de passe** partout)
2. Connectez-vous à VS Code Settings Sync sur tous les appareils
3. Activez `remoteBridge.security.syncConnections` dans les Paramètres

Les connexions sont fusionnées automatiquement à l'aide d'horodatages par élément — aucune donnée n'est perdue. Les suppressions sont suivies pendant 30 jours, de sorte qu'une connexion supprimée sur un appareil reste supprimée sur les autres.

**Remarque :** Si vous changez le mot de passe maître sur un appareil, Remote Bridge vous invitera à déverrouiller avec le nouveau mot de passe sur les autres.
