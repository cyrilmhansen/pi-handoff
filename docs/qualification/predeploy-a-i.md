# Q1/Q2 — Qualification de restauration A–I

**Historique Q1 : BLOCKED.** La restauration d’un checkout qui perdait l’état de chaîne réautorisait un checkpoint consommé et oubliait plafond/stop. Q2 conserve les reproducteurs Q1, corrige le défaut en fail-closed et le prouve sur le runtime Pi disponible. **Correction Q2 : PASS** pour les scénarios testés ci-dessous. La qualification globale avant déploiement reste **UNTESTED** tant que Pi 1.4.0 et les parcours nécessitant une vraie inférence ne sont pas observés; ce rapport ne constitue pas une approbation de déploiement ni une validation scientifique.

## Périmètre et environnement mesuré

- Base : `main@8caee04b4c2106dba36c03514274e91e5277f607`; qualification sur `qual/predeploy-a-i`.
- Système : Linux x86_64, projet sur Btrfs; `/tmp` est tmpfs. Les scénarios Q1 créent chacun leur répertoire isolé `/tmp/atlas-qualification-…` et le détruisent dans `finally`.
- Node : `v26.12.1`. `pi --version` rapporte **1.5.2**. Aucun Pi 1.4.0 n’a été trouvé dans les installations locales; les validations RPC de cette campagne ne qualifient donc pas 1.4.0.
- `CONTEXT_GUARD_STATE_DIR` n’est pas défini ici; `handoff.config.json` sélectionne `.pi-guard` et configure `renewal.enabled=true`, `autoRenew=false`, plafond 8, `documentation.enabled=false`.
- Dans ce checkout, les documents racine `GOAL.md`, `HANDOFF.md`, `PROGRESS.md`, `LEARNINGS.md`, `PROTOCOL.md`, `AGENTS.md`, `README.md` et `handoff.config.json` sont suivis par Git. `.pi-guard/` est ignoré; l’inventaire local comptait 85 fichiers, dont 82 fichiers de session et `renewal-state.json`. `.pi-handoff/` est absent de ce checkout; les tests créent les instances, scellements et registre dans des copies jetables. Cinq fichiers non suivis préexistants (`__pycache__/`, `create_pi_handoff_starter.py`, `pi_kv4_fanout.py`, `pi_sub_kv4_mitm.py`, `setup_pi_sub_kv4.py`) ont été préservés.
- Aucun stateDir externe n’est configuré dans ce workspace. Les tests Q1 créent un stateDir externe dans leur répertoire jetable pour vérifier qu’il doit être sauvegardé séparément.
- Les transcripts Pi sont stockés par Pi hors des documents opérationnels; Handoff ne les lit pas et ne les rejoue pas. Le répertoire agent Pi effectif n’a pas été déterminé pendant cet audit. Les transcripts peuvent être conservés à des fins forensiques mais ne reconstituent ni compteurs ni autorisations.

## Inventaire des états et conséquences d’une restauration (état Q1, avant correction)

| État | Nécessaire / reconstructible | Absent, ancien ou corrompu | Sauvegarde cohérente |
|---|---|---|---|
| `GOAL.md`, `PROTOCOL.md`, règles et code | Autorité durable du projet; ne pas reconstruire depuis un transcript. `GOAL.md` reste protégé. | Empreintes de checkpoint deviennent stale; règles manquantes rendent le projet incomplet. | Oui, avec révision du code et configuration correspondante. |
| `HANDOFF.md`, `PROGRESS.md`, `LEARNINGS.md` racine ou `.pi-handoff/instances/<id>/` | Prose manuelle fait autorité; checkpoint géré est dérivé de ces sources. Les documents d’une instance ne sont pas automatiquement créés dans Git. | Manquant/corrompu : validation échoue ou checkpoint stale/corrupt; aucun fallback silencieux vers une autre mission si l’instance est sélectionnée. Édition manuelle plus récente que checkpoint : stale/refus d’autorisation jusqu’au refresh et à l’attestation. | Oui, avec `mission.json`, profil et états. Vérifier ce qui est effectivement suivi par Git. |
| Blocs de checkpoint schema v3 dans HANDOFF/PROGRESS | Nécessaires pour identité/fraîcheur et readiness; attestations sont liées au même ID dans les deux blocs. Reconstruction possible par refresh explicite mais cela crée une nouvelle identité et ne prouve aucune réussite scientifique. | Absence/corruption/mélange : missing/corrupt/stale et renouvellement non autorisé. Prose plus récente : stale. | Oui. Conserver les octets pour audit et continuité. |
| `<stateDir>/renewal-state.json` | **Non reconstructible sans ambiguïté** : `chainId`, compteur, ID consommé, successor session et `stopped`. | **FAIL critique** : missing et JSON corrompu sont ramenés à l’état initial; le chemin renouvellement ignore aussi `corrupt`. Un checkpoint current+attested peut alors redevenir renouvelable. | **Obligatoire**, indépendamment de Git et même lorsque `stateDir` est externe. |
| `<stateDir>/sessions/<session>.json`, `state.json` historique | État de pression/alertes par session; reconstruit en réarmant les alertes. Ne doit pas porter le plafond/stop de la chaîne. | Un fichier de session absent repart avec une machine neuve; legacy peut migrer. Fichier corrompu peut être quarantainé en mode normal. | Recommandé pour audit/continuité, mais ne remplace jamais `renewal-state.json`. |
| `<stateDir>/diagnostics.jsonl` | Journal d’événements limité; non décisionnel et non reconstructible. | Perte de l’historique de diagnostic, pas de permission. Corruption partielle est ignorée selon le lecteur. | Facultatif, mais à inclure dans une sauvegarde d’incident. |
| `<stateDir>/documentation-cycle/` et ses artefacts | Phase, hash de plan/revue, verrou et journal de transition permettent d’éviter un rejeu ou une transition ambiguë. Non reconstructibles depuis les transcripts. | État corrompu/verrou actif bloque; état absent paraît idle et ne permet pas de conclure quelle étape antérieure avait été approuvée. Ne pas reprendre sans inspection des artifacts. | Oui si un cycle est actif/incomplet; inclure le stateDir et les fichiers référencés. |
| `.pi-handoff/instances/<id>/mission.json`, docs, `.owner.lock`, `.owner.lock.recovery` | Manifest identifie l’instance; documents sont son état. Verrou protège un propriétaire Pi local. | Manifest absent/corrompu : sélection refuse. Lock abandonné reste bloquant; âge seul n’est jamais preuve d’abandon. PID réutilisé peut être reconnu seulement avec preuve Linux boot ID/start ticks; cas incertain reste manuel. | Oui, après arrêt/quiescence. Ne pas restaurer un verrou live dans un processus actif; préserver les marqueurs incertains. |
| `closure.json`, `closure.pending` | Sceau et marqueur de transaction; hashent les fichiers opérationnels et les fichiers du stateDir. | Sceau valide mais état absent/modifié : closure `changed`; pending/incomplet/corrompu : `uncertain`, mutations Handoff bloquées. Ne jamais supprimer pour réactiver l’ID. | Oui, avec les octets hashés et le stateDir à son chemin d’origine. |
| `.pi-handoff/knowledge/records/`, propositions et `.publish.lock` | Records publiés immuables avec empreintes/provenance; lock sérialise les publications dans un arbre local. Les propositions ne sont pas des publications. | Record invalide/hash incorrect bloque l’intégrité; références de preuve absentes/modifiées échouent à verify. Lock abandonné exige récupération contrôlée; fichiers temporaires sont conservés et bloquent une nouvelle publication. | Records oui. Lock/température incertaine à préserver et inspecter; pas de reprise implicite. |
| `.pi-handoff/work-profiles/<id>/<version>.json` | Méthodologie versionnée référencée par manifest; pas d’autorité opérateur. | Manquant/corrompu/incompatible : sélection de l’instance refuse. | Oui pour les profils utilisés. |
| Transcripts Pi | Stockage Pi distinct; pas de rôle dans la récupération Handoff. | Leur absence n’empêche pas la récupération à partir des fichiers durables; aucun replay n’est fait. | Facultatif pour récupération; recommandé séparément si un audit de conversation le requiert. |

Les empreintes SHA valident l’intégrité octet pour octet, pas l’atomicité d’une transaction interrompue. Les locks/journaux/markers déterminent si une transaction a été menée à terme. Ni l’attestation Handoff ni une publication `accepted` ne valident une hypothèse ou un résultat scientifique.

## Scénarios de restauration — preuves Q1 historiques

| Scénario | Résultat | Preuve |
|---|---|---|
| A — copie complète, même chemin | **PASS** : checkpoint courant/attesté et variantes de chaîne (checkpoint consommé, plafond atteint, stop) gardent leur gate après copie complète. Sceau de mission valide après backup+restauration complète à son chemin d’origine. | `test/qualification-restore.test.ts`: Q1-A et Q1-A/B. |
| B — docs/manifest/checkpoint sans `.pi-guard` | **FAIL critique** : pour chacune des variantes consommé/plafond/stop, state absent se parse sans corruption en compteur 0, `stopped=false`, `renewedFromCheckpointId=null`; `decideRenewal` renvoie `renew=true` avec checkpoint current+attested. | Q1-B; vrai Pi RPC zéro inférence ajouté à `scripts/e2e-rpc-two-process.mjs` : le checkpoint neuf est attesté, `renewal-state.json` absent, `/handoff verify` signale `ready-now`. |
| C — documents plus récents que state | **PASS** : modification manuelle rend le checkpoint stale; l’autorisation échoue. | Q1-C. |
| C — state plus récent (stop) que documents | **PASS** : checkpoint reste current, mais le stop durable refuse le renouvellement. | Q1-C. |
| C — renewal-state corrompu | **FAIL critique** : parse renvoie `corrupt=true` et état initial; le gate renvoie renouvelable. | Q1-C; l’appel réel dans `index.ts` lit `.state`, sans refuser `.corrupt`. |
| C — stateDir externe | **PASS si sauvegardé; FAIL si perdu** : état externe arrêté reste arrêté après copie distincte; disparition de cet arbre restaure le même fail-open qu’en scénario B. | Q1-C. |
| C — journal de cycle documentaire absent | **UNTESTED continuité complète** : le parseur traite l’absence comme `idle`; l’étape/approbation active n’est pas reconstructible depuis les seuls documents. Le plan/appliquer/revoir complet n’a pas été repris après perte de stateDir. | Q1-C vérifie la classification; `test/extension.test.ts` E2/E4 couvre seulement l’approbation stale/NO_CHANGE avec état présent. |
| C — fermeture interrompue | **PASS** : `closure.pending` seul apparaît `uncertain`; copie complète valide; copie sans state hashé apparaît `changed`. | Q1-C et Q1-A/B. |
| C — publication interrompue | **PASS limité** : artefact temporaire est signalé/préservé; verrou/état incertain bloque une publication. Aucun rejeu n’est fait. | `test/knowledge.test.ts` KI8/KI10, `test/knowledge-processes.test.ts` KP2. |
| C — PID réutilisé | **PASS logique / UNTESTED noyau** : branche `pid-reused` est exercée via probe injecté; aucun PID n’a été réellement réutilisé pendant Q1. | Q1-C et `test/instance-lock.test.ts`; tests de processus réels existent pour d’autres chemins d’exclusion, mais pas de réutilisation forcée. |

Une nouvelle instance explicite vierge a ses documents propres et ne copie pas le Next action; elle est distincte d’une restauration de l’instance précédente. L’existence d’un nouveau checkpoint attesté sans `renewal-state.json` ne prouve cependant pas que cette instance est vierge: c’est précisément l’ambiguïté de sécurité à résoudre.

## Parcours intégré A–I — preuves Q1 historiques

Le RPC zéro inférence couvre checkpoint/attestation, séparation des états d’instances, refus d’un second propriétaire, disponibilité simultanée d’un ID différent, plafond/finalize, clôture et relecture après redémarrage, publication depuis une mission scellée, consultation depuis une autre mission et détection d’une preuve modifiée. Le script observe le runtime Pi **1.5.2**, pas 1.4.0. La validation finale complète de ce candidat est dans la section suivante.

| Étape demandée | Classement | Détail mesuré |
|---|---|---|
| 1–2 deux instances, checkpoint attesté et état isolé | **PASS** | `scripts/e2e-rpc-two-process.mjs`; tests `test/mission-instance.test.ts`. |
| 3 renouvellement autorisé, compteur, idempotence | **UNTESTED transition réelle** | Gates, compteur/cap/idempotence sont testés déterministiquement (`test/renewal.test.ts` RN5–RN9/RN15; `test/extension.test.ts` RB); le RPC n’effectue pas de renouvellement Pi réel car son premier tour successeur consommerait une inférence. Ne pas confondre le simulateur/gate avec un switch observé. |
| 4 second propriétaire refusé | **PASS** | Deux vrais processus Pi; le perdant ne peut checkpoint/attester/renouveler/cycle; ID différent simultané autorisé. |
| 5 cycle documentaire NO_CHANGE et approbation périmée | **PASS déterministe / UNTESTED Pi complet** | `test/extension.test.ts` E2/E4 teste hash périmé et NO_CHANGE. La mission de planification est dispatchée comme un nouveau tour Pi; aucun parcours intégré complet n’a été exécuté pour éviter l’inférence. |
| 6 clôture et lecture après redémarrage | **PASS** | RPC Pi: plan read-only, close explicite, redémarrage et refus d’écriture; restauration de sceau Q1 couvre state complet/absent. |
| 7–9 publication scellée, consultation autre mission, Next action inchangé | **PASS** | RPC réel et `test/knowledge.test.ts` KI4/KI5. |
| 10 corruption d’une preuve | **PASS** | RPC modifie une copie temporaire de preuve puis `knowledge verify` rapporte `evidence hash mismatch`; aucun fichier DRPLi/projet externe concerné. |

La restauration B/C échoue au critère central, même si le reste du parcours est positif.

## Validation et limites

Campagnes lancées séquentiellement, après vérification qu’aucun build Rune CI n’était actif :

- `node --test test/` — **302 tests, 301 pass, 0 fail, 1 gated skip**. Les quatre tests Q1 sont des reproducteurs contrôlés; Q1-B/Q1-C réussissent parce qu’ils capturent explicitement le comportement dangereux mesuré, ils ne le classent pas sûr.
- `node scripts/check-skill-discovery.mjs` — **8/8**, runtime Pi 1.5.2, sans inférence.
- `node scripts/e2e-rpc-two-process.mjs` — **58/58** (compte final après ajout du reproducer Q1 et vérification preuve corrompue), runtime Pi 1.5.2, aucune inférence. Le check Q1 est nommé « BLOCKER REPRODUCED » et ne constitue pas un PASS sécurité.
- `git diff --check` — réussi.
- Pi 1.4.0 — **UNTESTED** dans cet environnement; seulement l’API historique et `compatibility: Pi >= 1.4.0` sont documentées.
- Rune CI — non relancée; Q1 n’a modifié aucun fichier Rune.
- Inférence réelle Sushi/renouvellement et cycle documentaire — **NOT RUN** selon consigne; le premier tour des missions de cycle et le switch réel restent non observés.
- Garantie de locks : testée sur Linux/Btrfs et tmpfs/local temps; **UNTESTED** macOS et fichiersystems réseau. Les docs Lots G/I excluent déjà réseau et autres checkouts.

### Anomalie initiale et décision Q1 (historique)

Le state chain est l’unique persistance qui relie un checkpoint durable à son usage antérieur. Avant Q2, `parseRenewalState(undefined)` retournait `INITIAL_RENEWAL_STATE` sans corruption; un JSON incorrect faisait pareil avec `corrupt=true`. Le chemin réel renouvellement n’arrêtait pas sur missing/corrupt. Le test Pi Q1 confirmait `ready-now` après perte du fichier. C’était une perte d’autorisation, pas une simple perte de diagnostic.

Q1 n’avait pas ajouté de reset automatique ni d’état initial synthétique: avec les fichiers disponibles, Handoff ne pouvait distinguer une première chaîne d’une chaîne perdue. Q2 implémente depuis cette branche la règle fail-closed et l’initialisation exclusive d’une nouvelle instance explicitement créée. **La décision BLOCKED ci-dessus reste l’instantané historique de Q1, pas le résultat Q2.**

## Q2 — Correction fail-closed et mesures

### Règle mise en œuvre

- `loadRenewalState()` retourne une classification `valid | missing | corrupt`; JSON vide, champs requis absents/invalides/incohérents et mauvais schéma v1 sont `corrupt`. Les anciens états v1 valides sans champ `stopped` restent acceptés.
- `decideRenewal()` refuse un état sans identité de chaîne. L’état `missing/corrupt` est affiché avec la cause et demande la restauration de la sauvegarde complète. Aucune inspection ne répare ou réécrit l’état.
- `saveRenewalState()` ne crée plus un fichier manquant, n’écrase pas un état corrompu, ne change pas la chaîne et ne baisse pas le compteur. Les remplacements de campagne passent uniquement par le journal et l’archive du cycle documentaire.
- `/handoff renew`, le tool `handoff_renew`, les aperçus L3/L4, `/handoff renew stop|resume`, les cycles documentaires, et le scellement contrôlent l’état. Identité de chaîne d’instance étrangère et checkpoint courant d’une génération égale/antérieure au checkpoint consommé sont refusés.
- `/handoff instance create <id>` crée les documents vides et un état initial de chaîne avec `createExclusive`, identifiant `mission:<id>:...`, compteur zéro. Le retry ne re-bootstrap pas un manifest existant dont le fichier chaîne manque; préserver les octets et utiliser un nouvel ID après décision opérateur.

### Résultats sécurité Q2

| Scénario | Résultat Q2 | Preuve |
|---|---|---|
| Consommé, plafonné ou stopped avec state absent | **PASS — refus** | `test/qualification-restore.test.ts` Q2-B; `decideRenewal` donne `state-unavailable`. |
| JSON cassé, champs incomplets/incohérents | **PASS — refus, octets conservés** | Q2-C, RN16; `saveRenewalState` ne répare ni ne remplace. |
| `stateDir` externe restauré/perdu | **PASS — refus si perdu; autorisation historique conservée si sauvegardé** | Q2-C. |
| stop/resume et `handoff_renew` opérateur/modèle avec état manquant | **PASS — refus, aucun state/checkpoint/dispatch créé** | test Q2 dans `test/renew.test.ts`; vrai RPC Pi sans inférence. |
| `cycle continue` missing/corrupt | **PASS — refus, state et documents conservés** | test Q2 dans `test/extension.test.ts`. |
| Nouvelle instance explicite, répétition et interruption avant état | **PASS — bootstrap exclusif/idempotent; partial refuse au retry** | MI2d, Q2-B et vrai RPC Pi avec redémarrage. |
| État v1 valide et quotas existants | **PASS** | RN9/RN15, Q1-A; consumed/capped/stopped restent bloqués après copie complète. |
| State/checkpoint de générations incohérentes ou identité d’autre instance | **PASS — refus** | RN16, MI2d; chain identity prefix et génération consommée testées. |
| Transition réelle avec inférence Sushi / comparaison `successorTurn` | **UNTESTED** | Aucune inférence autorisée. |

### Validation Q2

Campagnes exécutées séquentiellement après contrôle local de l’absence de build request Rune CI actif. Le runtime réel RPC était Pi **1.5.2** (`pi --version`); Pi 1.4.0 n’était pas installé.

- `node --test test/` — **306 tests : 305 pass, 0 fail, 1 gated skip**.
- `node scripts/check-skill-discovery.mjs` — **8/8**, zéro inférence.
- `node scripts/e2e-rpc-two-process.mjs` — **60/60**, zéro inférence; reproduit le refus d’état absent et l’initialisation d’une mission qui survit à un redémarrage réel.
- `git diff --check` — réussi après modifications.
- Pi 1.4.0 — **UNTESTED**; aucune assertion de compatibilité runtime n’est inférée depuis 1.5.2.
- Parcours documentaire complet, bascule de session avec premier tour successeur, et validation scientifique — **UNTESTED** (dépendent d’inférence ou d’une validation indépendante).

### Décision Q2

**Correction de restauration : PASS** pour les cas et plateformes mesurés. **Qualification globale A–I avant déploiement : UNTESTED** pour Pi 1.4.0 et les parcours live nécessitant une inférence; aucune décision READY n’est prononcée et cette correction seule n’autorise pas un déploiement DRPLi. Le blocage de sécurité Q1 est corrigé localement sur `qual/predeploy-a-i`. Les états scientifiques n’ont pas été migrés, réécrits ou nettoyés.
