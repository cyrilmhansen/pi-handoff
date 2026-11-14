# Procédure de sauvegarde, essai et retour arrière

> **Q2 : restauration fail-closed corrigée sur `qual/predeploy-a-i`.** Q1 avait démontré
> qu’une perte de `.pi-guard`/`stateDir` pouvait réinitialiser l’autorisation. Q2 refuse
> maintenant l’état absent/corrompu et initialise une chaîne seulement à la création
> explicite d’une nouvelle instance. La qualification globale reste limitée par les
> versions/runtime non testés; voir `predeploy-a-i.md`.

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
`<stateDir>/renewal-state.json` ne restaure pas le compteur, l’identité consommée ni le
stop opérateur. Q2 classe ce cas `missing`/`corrupt` et refuse renouvellement, stop/resume
et transitions documentaires sans réécrire le fichier. Restaurer la sauvegarde cohérente;
ne pas remplacer ou supprimer l’artefact corrompu. Une attestation de checkpoint ne
prouve pas qu’une chaîne est neuve.

## 2. Vérifier Handoff dans une copie de projet

1. Créer une copie jetable et vérifier qu’elle ne pointe ni vers DRPLi, ni vers le projet
   original, ni vers son `stateDir` partagé. Utiliser un `PI_CODING_AGENT_DIR` isolé pour
   que les sessions de vérification restent séparées.
2. Charger l’extension depuis cette copie avec `pi -e
   <copie>/.pi/extensions/context-guard/index.ts`. Vérifier `pi --version` : la campagne
   Q1 courante a utilisé Pi 1.5.2; Pi 1.4.0 reste à qualifier.
3. Vérifier les fichiers attendus, `node --test test/`, skill discovery et
   `node scripts/e2e-rpc-two-process.mjs`. Le script RPC est zéro inférence; Q2 vérifie
   qu’un vrai processus Pi refuse l’état absent et qu’une instance explicitement créée
   conserve sa chaîne après redémarrage. Pi 1.4.0 reste à qualifier.
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

La création d’une nouvelle instance initialise exclusivement son état chaîne zéro dans
le `stateDir` configuré, avec un `chainId` de forme `mission:<id>:...`. À chaque
redémarrage, vérifier que l’état est `valid` et correspond à l’ID sélectionné. Si la
création est interrompue après le manifest mais avant `renewal-state.json`, ne pas
réessayer sur ce même ID : garder ses fichiers intacts, inspecter, puis utiliser un nouvel
ID après décision opérateur. Une instance existante dont le state manque/corrompt doit
être restaurée depuis la sauvegarde complète; une nouvelle instance n’hérite pas de son
checkpoint ni de son `Next action`.

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
