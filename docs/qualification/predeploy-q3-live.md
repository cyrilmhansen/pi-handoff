# Q3 — qualification intégrée Pi / Sushi

## Cible et préflight

- Source exacte : `main@f4206dbc9fcab89b666bc8623cbe8477f8bd7c95`; branche locale `qual/predeploy-q3-live`.
- Node **v26.12.1** ; Pi réellement lancé **1.5.2**. Pi 1.4.0 parallèle non trouvé dans les installations inspectées : **UNTESTED**.
- Sushi CLI absent. Le provider Pi `sushi` visait le proxy local `http://127.0.0.1:12345/v1`. `/models` indiquait `Qwen3.8-Flash-Next-Sushi-STQ-2.75bpw`, `loaded=true`, `state=ready`, contexte annoncé **180000**. La version serveur Sushi n'est pas exposée. Aucun provider de secours n'était configuré.
- Accès Sushi vérifié avant les campagnes. L'agent Pi temporaire ne contenait que cette entrée de modèle et la clé sentinelle locale `sushi`; aucun `auth.json` ou réglage global n'a été copié.
- Pi 1.5.2 rapportait `autoCompactionEnabled=true`, `isCompacting=false`. Aucun réglage de compaction n'a été changé. Aucun transcript observé ne permet de mesurer une compaction R1/D1.
- Buildbot API : **0 build request actif** avant R1, avant D1 et avant les suites finales.
- Chaque RPC live était lancé sous Bubblewrap depuis un clone temporaire de la révision source. `/home` et `/tmp` de l'hôte étaient masqués; la racine du clone était en lecture seule, avec montages inscriptibles limités à l'instance et à son état, ou au registre de connaissances durant M1. Le clone ne pouvait pas écrire dans DRPLi ni accéder à son état local. Les agents et `PI_CODING_AGENT_DIR` étaient isolés.
- Les répertoires temporaires des conducteurs ont été supprimés après chaque exécution. Aucun changement global, DRPLi ou Rune CI.

## Budget annoncé avant les campagnes

Chaque complétion Pi était configurée à **2048 tokens maximum en sortie**. Limites planifiées et imprimées par le conducteur avant les essais :

| Campagne | Appels/stades prévus | Complétions maximales prévues | Sortie cumulée planifiée |
|---|---:|---:|---:|
| R1 | 4 prompts : tâche A, requête de renouvellement, tour B, tour C | 10 | 20480 tokens |
| D1 | plan réel, puis au plus apply/review si plan conforme | 6 | 12288 tokens |

Ces plafonds cumulés sont des limites du plan d'expérience, pas un coupe-circuit provider atomique. Les transcriptions des tours interrompus n'ont pas fourni de compteurs d'usage exploitables. Aucun retry d'inférence ni fallback opérateur n'a été tenté. Le modèle étant local, aucune facturation API externe n'a été configurée; le calcul local consommé n'est pas mesurable ici.

## Résultats live

| Domaine | Statut | Résultat observé |
|---|---|---|
| Restauration fail-closed | **PASS** | Dans une instance Q2 neuve séparée de R1, Pi 1.5.2 a produit puis attesté un checkpoint courant. Deux copies isolées ont supprimé l'état de chaîne ou remplacé ses octets par `{"version":1,"renewalsDone":0,"broken":true}\n`. Les deux `/handoff renew` ont été refusés `state-unavailable`; aucune chaîne/checkpoint/session successeur n'a été recréé, les documents sont restés identiques et les octets corrompus ont été conservés. Diagnostics : restaurer le `stateDir` complet ou créer une nouvelle identité de mission. Zéro inférence. |
| Pi RPC réel | **PASS** | Pi 1.5.2 a chargé l'extension, sélectionné le modèle Sushi, créé des missions Q2, répondu aux commandes et exercé les contrôles de propriété, scellement et publication. Suite RPC finale **60/60**, zéro inférence. |
| Renouvellement opérateur | **UNTESTED** | R1 n'a pas dépassé son premier tour de tâche; aucune transition A→B/C n'a été demandée par l'opérateur. |
| Renouvellement autonome | **UNTESTED** | Le premier tour Sushi de R1 n'a pas émis `agent_settled` avant le délai de 120 s. Le prompt demandant ensuite `handoff_renew` n'a donc jamais été envoyé; aucun fallback opérateur n'a été utilisé. |
| Successeur et provenance | **UNTESTED** | Aucun successeur Pi n'a été observé. Identifiants A/B/C, consommation de checkpoint, provenance de reprise, premier travail et compaction après renouvellement non mesurés. |
| Cycle documentaire | **UNTESTED** | Dans un projet Q2 isolé, `/handoff cycle plan` a été soumis avec chaîne plafonnée `0/0` et checkpoint attesté. Le RPC n'a pas répondu dans le délai de 180 s; aucun plan/hash/approbation/continue n'a été observé. Le clone éphémère a été nettoyé avant qu'une preuve de l'état partiel puisse être conservée; l'état réel de dispatch du tour est donc incertain. Aucun autre essai D1 ni aucune approbation n'a eu lieu. |
| Clôture et publication | **PASS (fixture)** | Sans inférence, Pi 1.5.2 a clôturé un fixture isolé après checkpoint courant et attestation post-finalize. Après redémarrage, Pi a vérifié le scellement. Publication `proposed` issue de la mission scellée approuvée et créée une seule fois (`publicationId=a6bbc357aaa39e4f7c2f8bc04cf9dba5f742cdbdb69cbc860a9f7906c60da5b9`). Une nouvelle mission `q3-next` a reçu une chaîne distincte `mission:q3-next:chain:2026-11-14T12:33:07.290Z`, un `Next action` vide et a consulté la provenance. Il s'agit d'un fixture déterministe, pas du cycle après un travail agent R1 réussi. |
| Compatibilité Pi 1.4.0 | **UNTESTED** | Aucun runtime 1.4.0 accessible; ne pas transposer les observations 1.5.2. |
| Compatibilité Pi 1.5.2 | **PASS (RPC sans inférence)** | Chargement d'extension et commandes Lots A–I observés. Les parcours d'inférence restent non qualifiés. |
| Réversibilité | **PASS** | Essais dans des clones/projets temporaires et `stateDir` isolés; aucun chemin DRPLi ni configuration globale montée en écriture. Les artefacts temporaires sont supprimés. La copie d'évidence d'échec a été ajoutée au conducteur pour les futures exécutions; les runs R1/D1 effectués avant cet ajout ne disposent que des journaux rapportés ici. |

### Détail R1, R2, D1 et M1

- **R1** : budget consigné avant lancement (4 prompts, 10 complétions, sortie max planifiée 20480). La mission `q3-r1` a été créée par le bootstrap explicite Q2 avec chaîne `mission:q3-r1:chain:2026-11-14T12:13:59.077Z`, quota `0/2`. Pi/Sushi a été sélectionné sans inférence préalable. La première requête de travail a expiré en attente d'`agent_settled` après 120 s. L'identifiant de session de départ, les écritures éventuelles de l'agent et l'usage provider n'ont pas été préservés par cette première version du conducteur. Aucune transition ou tentative de renouvellement n'a été comptée.
- **R2** : répété ensuite depuis un autre clone, sans dépendre d'un résultat R1 inexistant. Le conducteur a créé une chaîne Q2 et un checkpoint attesté via commandes Pi read-only/instrumentées, a arrêté le propriétaire, puis copié le projet en deux fixtures. Pour l'état manquant et l'état corrompu, le RPC Pi a conservé le même `sessionId` avant/après la commande, sans mutation documentaire ni recréation. Les diagnostics exacts mentionnent respectivement `renewal-state.json is absent` et les champs transactionnels requis manquants/invalides.
- **D1** : budget consigné avant campagne (3 stades, 6 complétions, sortie max planifiée 12288). Chaîne explicitement plafonnée `0/0`; Pi a confirmé son état et le checkpoint a été attesté. L'appel de planification n'a pas répondu avant 180 s. Aucun plan inattendu n'a été approuvé. Le résultat n'est pas une validation NO_CHANGE et `cycle continue` n'a pas été lancé.
- **M1** : zéro inférence. Fixture source `q3-r1`, Next action `Read RESULT.txt and report its sole marker: Q3-R1-DURABLE-MARKER-7C91.`; empreinte d'approbation de clôture `e42828b0b1d1aa90a4e0d988032307636079c329a32ac211502151e30f493816`. Scellement relu après redémarrage. La publication vérifiait les empreintes de LEARNINGS et de RESULT, puis a été consultée depuis `q3-next`. Aucune preuve scientifique n'a été revendiquée.

## Commandes de qualification exécutées

Ancien `scripts/e2e-renew.mjs` inspecté mais **jamais lancé** : il cible le chemin historique, omet le bootstrap d'instance Q2, prévoit un fallback opérateur pour le parcours autonome et utilise `git add -A`.

Conducteur ajouté : `node scripts/e2e-q3-live.mjs` (`Q3_RUN=preflight|r1|r2|d1|m1`, `Q3_BASE_URL`, `Q3_MODEL`). `preflight`, R2 et M1 sont sans inférence. Une exécution R1 et une exécution D1 ont été tentées, sans retry d'inférence. Le conducteur conserve désormais le clone et le répertoire agent sous `docs/qualification/q3-live-artifacts/` si une phase live future échoue; aucune preuve post-échec n'a été récupérée rétroactivement des deux runs initiaux.

Validation finale, exécutée séquentiellement hors Rune CI et hors inférence :

```text
node --test test/                         305 pass / 0 fail / 1 gated skip (306 total)
node scripts/check-skill-discovery.mjs    8/8
node scripts/e2e-rpc-two-process.mjs      60/60
git diff --check                          PASS (rapport et conducteur inclus)
```

## Décision

**BLOCKED** pour une qualification pré-déploiement intégrée : l'essai de renouvellement réel et le cycle documentaire avec inférence ne sont pas qualifiés, et Pi 1.4.0 est absent. R2, les mécanismes RPC 1.5.2 et le parcours fixture de clôture/publication ont réussi sans inférence, mais ne remplacent pas les transitions live requises. Ne pas utiliser ces résultats pour revendiquer un renouvellement autonome ou un parcours documentaire réel validé.
