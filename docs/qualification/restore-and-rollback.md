# Procédure de sauvegarde, essai et retour arrière

> **Statut Q1 : ne pas déployer sur DRPLi.** La chaîne de renouvellement peut être
> réinitialisée silencieusement si `.pi-guard` ou le `stateDir` externe manque. Cette
> procédure permet les répétitions dans une copie isolée et le retour exact à un état
> pré-déploiement; elle ne lève pas ce blocage.

## 1. Sauvegarder un état actif

1. Arrêter les créations de nouvelles sessions/renouvellements et attendre la fin des
   opérations en cours. Fermer normalement tous les Pi qui sélectionnent les instances.
   Si un Pi a crashé et qu’un lock ou marker existe, le laisser intact et suivre son
   inspection/récupération explicite; ne pas retirer un lock par âge.
2. Copier à froid **tout le projet**, y compris les fichiers ignorés/non suivis, puis
   copier séparément le `stateDir` configuré. Par défaut, cela inclut `.pi-guard/`; avec
   `CONTEXT_GUARD_STATE_DIR` ou `stateDir` externe, préserver ce chemin en plus. Inclure
   `.pi-handoff/` (manifestes, docs des instances, profils, locks/markers, clôtures,
   proposals, records de connaissances) et les fichiers d’archive/référence utilisés par
   un cycle documentaire.
3. Enregistrer l’ID de révision Git, la valeur effective de `stateDir`, les IDs d’instance
   et un manifeste SHA-256 des fichiers copiés. Pour une clôture, restaurer au même chemin
   absolu que le `stateRoot` du scellement; un autre chemin échoue volontairement à la
   vérification.
4. Pi garde ses transcripts hors de l’arbre du projet. Les copier séparément si un audit
   de conversation est requis; ils ne reconstituent pas l’état Handoff et ne seront pas
   rejoués.

**Point critique :** ne pas faire confiance à Git seul. La perte de
`<stateDir>/renewal-state.json` peut oublier le compteur, l’identité de checkpoint
consommée et le stop opérateur. Pour l’instant, si ce fichier est absent ou corrompu pour
une mission existante, arrêter les mutations et préserver l’état; ne pas continuer sur la
base d’une chaîne supposée neuve.

## 2. Vérifier Handoff dans une copie de projet

1. Créer une copie jetable et vérifier qu’elle ne pointe ni vers DRPLi, ni vers le projet
   original, ni vers son `stateDir` partagé. Utiliser un `PI_CODING_AGENT_DIR` isolé pour
   que les sessions de vérification restent séparées.
2. Charger l’extension depuis cette copie avec `pi -e
   <copie>/.pi/extensions/context-guard/index.ts`. Vérifier `pi --version` : la campagne
   Q1 courante a utilisé Pi 1.5.2; Pi 1.4.0 reste à qualifier.
3. Vérifier les fichiers attendus, `node --test test/`, skill discovery et
   `node scripts/e2e-rpc-two-process.mjs`. Le script RPC est zéro inférence; le test
   `Q1 BLOCKER REPRODUCED` doit actuellement reproduire le défaut et **ne signifie pas
   que le déploiement est sûr**.
4. Essayer les restaurations uniquement dans des répertoires temporaires de la copie. Ne
   jamais pointer les variables d’environnement ou outils de test vers des preuves DRPLi.

## 3. Démarrer en mode historique (sans instance explicite)

Dans la copie seulement, laisser `missionInstance.id` absent/null et ne pas définir
`CONTEXT_GUARD_MISSION_INSTANCE`. L’extension utilise alors les documents racine
historiques (`HANDOFF.md`, `PROGRESS.md`, `LEARNINGS.md`). Vérifier `/handoff status` et
`/handoff verify`, puis examiner les changements Git. Ne pas créer/migrer de données
automatiquement. Le mode historique n’est pas une solution à la perte de renewal-state:
le même état de chaîne demeure nécessaire.

## 4. Créer ensuite une instance explicite

Après validation du manifest, du profil éventuel, des documents vides et de l’espace
d’état, l’opérateur peut exécuter `/handoff instance create <nouvel-id>` (option
`--profile <id@version>` si voulu), puis redémarrer Pi avec
`CONTEXT_GUARD_MISSION_INSTANCE=<nouvel-id>` ou la sélection explicite de configuration.
Ne jamais réutiliser l’ID d’une instance clôturée ou restaurée de manière ambiguë; ne pas
copier le `Next action`, `LEARNINGS.md` ou les preuves automatiquement. Le nouveau travail
est distinct d’une continuation de l’ancienne chaîne.

Q1 reste **BLOCKED** : avant tout déploiement, un correctif doit refuser les états de
chaîne missing/corrupt pour une mission existante et fournir une initialisation sûre,
explicitement autorisée, pour une nouvelle chaîne vierge. Cette procédure n’invente pas
un reset de chaîne.

## 5. Retour arrière en cas de refus ou d’incident

1. Arrêter tous les processus Pi concernés. Ne pas supprimer locks, markers, state files,
   records de connaissance ou artefacts temporaires incertains.
2. Faire une seconde copie d’incident de l’état observé après le déploiement. Elle
   préserve les changements et preuves produits depuis le début, même si leur validité
   scientifique reste à évaluer.
3. Restaurer la sauvegarde complète pré-déploiement — code, configuration, documents,
   `.pi-handoff/` et `stateDir` — dans un environnement isolé, puis vérifier les hashes.
   Pour un rollback exact, restaurer au chemin original si des closures référencent ce
   chemin. Un simple downgrade de l’extension peut ignorer les lots F–I et rendre les
   missions/scellements incomplets; ne pas le faire comme substitut à la restauration
   cohérente.
4. Comparer la copie d’incident à la sauvegarde et reporter manuellement les résultats
   scientifiques nouveaux après vérification indépendante. Ne jamais écraser ou
   consolider automatiquement les preuves. Garder le projet en lecture seule jusqu’à ce
   que la chaîne restaurée et le propriétaire des données soient établis.

Le rollback restaure un snapshot opérationnel; il ne prouve ni que les résultats postérieurs
sont valides, ni qu’un renewal-state manquant peut être reconstruit.
