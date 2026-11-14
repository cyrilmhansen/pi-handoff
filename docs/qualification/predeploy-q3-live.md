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

Conducteur ajouté : `node scripts/e2e-q3-live.mjs` (`Q3_RUN=preflight|r1|r2|d1|m1`, `Q3_BASE_URL`, `Q3_MODEL`). `preflight`, R2 et M1 sont sans inférence. Une exécution R1 et une exécution D1 ont été tentées, sans retry d'inférence. Le conducteur corrigé conserve désormais uniquement un rapport d'événements et de métadonnées expurgé, sous un répertoire unique à permissions restreintes dans `/var/tmp`; il ne conserve ni clone, ni transcript, ni arguments ou contenu des prompts. Aucune preuve post-échec n'a été récupérée rétroactivement des deux runs initiaux.

Validation finale, exécutée séquentiellement hors Rune CI et hors inférence :

```text
node --test test/                         305 pass / 0 fail / 1 gated skip (306 total)
node scripts/check-skill-discovery.mjs    8/8
node scripts/e2e-rpc-two-process.mjs      60/60
git diff --check                          PASS (rapport et conducteur inclus)
```

## Décision

**BLOCKED** pour une qualification pré-déploiement intégrée : l'essai de renouvellement réel et le cycle documentaire avec inférence ne sont pas qualifiés, et Pi 1.4.0 est absent. R2, les mécanismes RPC 1.5.2 et le parcours fixture de clôture/publication ont réussi sans inférence, mais ne remplacent pas les transitions live requises. Ne pas utiliser ces résultats pour revendiquer un renouvellement autonome ou un parcours documentaire réel validé.

## Q3-DIAG — 2026-11-14

### Classification

**INCONCLUSIVE** quant à la cause des expirations R1/D1 d'origine. Les éléments Q3-DIAG établissent que les deux transports testés ont progressé, mais les traces structurées des anciennes campagnes ont été supprimées par l'ancien conducteur. Elles ne permettent pas de déterminer jusqu'où R1 ou D1 était arrivé.

Le premier diagnostic direct a reçu une réponse HTTP 200 et un flux SSE : en-têtes vers 1269 ms, premier chunk vers 1270 ms, fin vers 1272 ms. Il a épuisé `max_tokens=24` sans texte visible (`finish_reason=length`, 19 tokens d'entrée, 24 de sortie). La requête réellement exécutée n'incluait pas `reasoning_effort` et utilisait donc l'effort par défaut `medium` annoncé par Sushi; le contenu de pensée non visible n'a pas été capturé, donc la cause du plafond n'est pas établie. Ce résultat ne constitue pas une panne du provider. Le script livré explicite `reasoning_effort: "off"`, mais cette modification n'a pas été rejouée. Le test Pi, deuxième et dernière génération, a démarré et terminé un tour en Bubblewrap, mais n'a pas produit le texte visible attendu. Le harnais Pi de ce diagnostic n'avait pas le `thinkingLevelMap` explicite utilisé par les campagnes Q3 et sa limite de 24 tokens était volontairement très basse. L'attribution la plus précise est donc une **limitation du smoke test**, sans preuve d'une panne Sushi, Pi/RPC ou Handoff.

Le premier diagnostic a aussi rencontré après le tour l'erreur de classification `directPassed is not defined`. Elle n'a pas affecté le dispatch ou la trace du tour, mais rendait son classement final défectueux. Cette erreur de harnais est corrigée dans le fichier livré. Aucune génération n'a été répétée pour valider le correctif.

### Protocole RPC et séquence observée

La documentation installée pour Pi **1.5.2** décrit la réponse RPC à `prompt` comme l'accusé de prise en charge du prompt, pas comme le résultat final du tour. `disposition: "handled"` signifie qu'aucun tour modèle n'a démarré. Les événements observables incluent notamment `agent_start`, `turn_start`, `message_start`, `message_update`, les événements d'exécution d'outil, `turn_end`, `agent_end` et `agent_settled`. `agent_end` n'est pas une preuve d'inactivité finale; `agent_settled` est l'événement de fin utile pour ce conducteur.

Dans le smoke Pi, l'ordre enregistré était : requêtes `get_state` et `set_auto_retry` envoyées/répondues ; `prompt` envoyé puis répondu `success` avec `disposition: "started"` ; `agent_start` et `turn_start` environ 1,32 s après le début du conducteur ; `message_start` vers 3,69 s ; premier `message_update` vers 3,694 s ; mise à jour de pensée, `message_end`, `turn_end`, `agent_end(willRetry=false)` et `agent_settled(aborted=false)`. Le tour s'est achevé dans le délai de 30 s, sans `tool_execution_start`, sans compaction observée et sans erreur stderr. Pi a consommé 549 tokens d'entrée et 24 de sortie. Le processus est ensuite sorti avec code 0. Le premier événement de streaming était une mise à jour de pensée, sans contenu texte visible. Ces compteurs proviennent de l'usage du tour Pi, pas du budget théorique.

Le diagnostic a ainsi observé un tour réel Pi RPC → Sushi → Pi terminé, pas une transition Handoff ni un successeur. Le message exact attendu (`Q3_SMOKE_OK`) n'a pas été observé. Le `thinkingLevelMap` a été ajouté au harnais après cette génération ; son comportement corrigé reste non testé.

### Lecture des expirations R1/D1 historiques

- **R1** : le conducteur Q3 historique attendait `agent_settled` jusqu'à expiration, puis détruisait son répertoire temporaire. Il n'avait pas conservé le transcript, l'événement de streaming, l'usage final, ni un instantané RPC de l'état au timeout. Aucun point précis d'arrêt ne peut être reconstitué. Le smoke Pi démontre seulement que le chemin RPC/Sushi minimal peut terminer un tour dans une autre session et avec une requête très courte.
- **D1** : le conducteur attendait la réponse RPC de `/handoff cycle plan` avant d'attendre `agent_settled`. Son timeout concernait donc d'abord l'accusé de réception de la commande, pas directement un timeout modèle prouvé. Le code actuel persiste la phase `planning`, puis attend `ctx.newSession`; dans le callback de remplacement, il envoie une notification et attend `sendMessage(..., {triggerTurn:true})`. Le handler attend la fin de ce dispatch. Cet ordre rend plausible un délai du handler pendant le changement de session ou le déclenchement, mais faute d'événements/session/journaux D1 conservés, cela reste une hypothèse, pas une cause démontrée. Aucune planification n'a été approuvée, aucun `cycle continue` lancé.
- Les anciens artefacts de session R1/D1 avaient été nettoyés; ils n'ont pas été reconstruits. Le transcript du smoke courant a lui aussi été retiré avec son dossier temporaire. Seuls les événements résumés ci-dessus sont conservés dans ce rapport. Sushi était servi par un proxy local `mitmdump -q`; aucun journal détaillé du proxy ou du serveur Sushi n'a été trouvé, hormis la disponibilité `/models` et les mesures de la requête directe.

### Portée du diagnostic

Deux générations courtes exactement ont été consommées : une requête directe au provider (20 s max, 24 tokens) et une requête Pi RPC sous Bubblewrap (30 s max, 24 tokens, retries désactivés, aucun outil). Pas de renouvellement, pas de nouvelle campagne R1/D1, aucune approbation et aucun `cycle continue`. La génération directe a eu lieu depuis l'hôte ; le test Pi a utilisé Bubblewrap. Aucun changement de modèle/provider, aucune inférence de secours.

Le code de Handoff n'a pas été modifié : aucun défaut du cœur n'a été reproduit. Le conducteur Q3-DIAG ajoute des événements horodatés distincts pour l'envoi/réponse RPC, le cycle agent, le premier flux, les appels d'outils, le règlement et l'état du processus après expiration. Le conducteur Q3 live conserve pour les échecs futurs un artefact limité et expurgé (événements, empreintes et métadonnées de cycle; sans transcript, contenu de prompt, arguments d'outil ni clés). Une expiration ne devient pas un PASS et un `UNTESTED` obligatoire ne peut plus produire une qualification globale réussie. Les compteurs mesurés après règlement sont explicitement distingués des limites budgétaires planifiées, qui ne sont pas des coupe-circuits cumulatifs.

Le conducteur isole maintenant R2 dans son propre projet même si R1 a laissé un projet partiel, et M1 utilise un fixture complété si les trois étapes R1 n'ont pas toutes réussi. Les suites déterministes/RPC ci-dessous ne consomment pas d'inférence et ne valident pas ces parcours live.

### Suites sans inférence

Les commandes ont été exécutées séquentiellement, hors Rune CI et sans inférence :

```text
node --test test/                         305 pass / 0 fail / 1 gated skip (306 total)
node scripts/check-skill-discovery.mjs    8/8
node scripts/e2e-rpc-two-process.mjs      60/60
git diff --check                          PASS
```

Ces suites ne remplacent pas R1/D1 réel.

### Décision

La classification demeure **INCONCLUSIVE** : la progression s'est arrêtée après la réception/émission d'un tour Pi terminé dans le smoke minimal, mais cela ne localise pas l'arrêt des campagnes historiques. Le point exact R1 entre prompt, streaming et fin, ainsi que le point D1 entre dispatch de commande, changement de session et début du tour, restent impossibles à déterminer sans leurs traces originales. Le prochain essai éventuel devra utiliser le conducteur corrigé et une requête courte instrumentée avant toute campagne bornée ; cette qualification ne relance ni n'autorise les campagnes complètes.
