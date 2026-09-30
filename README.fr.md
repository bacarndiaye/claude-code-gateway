# claude-code-gateway

Passerelle HTTP autour de l'**Agent SDK de Claude Code** (`@anthropic-ai/claude-agent-sdk`).
Elle transforme `claude -p` en service : un programme envoie un prompt en JSON et reçoit
le résultat, ou suit l'exécution en direct (SSE). TypeScript, Node ≥ 20, une seule
dépendance d'exécution.

> Claude Code n'expose pas d'API HTTP par défaut. Ce projet est le « petit serveur qui
> appelle le SDK », avec les garde-fous qu'un service réseau impose.

## Démarrage

```bash
npm install
export GATEWAY_TOKEN=$(openssl rand -hex 32)
export GATEWAY_ROOTS=$HOME/projets          # dossiers où Claude a le droit de travailler
npm start                                   # http://127.0.0.1:8787
```

Claude doit être authentifié sur la machine (`claude login`) ou `ANTHROPIC_API_KEY` défini.
Toutes les variables sont dans `.env.example`.

## Sécurité : ce que le service garantit

Quiconque détient le jeton pilote un agent qui lit (et, si vous l'autorisez, modifie)
votre disque. Les garde-fous sont donc **par construction**, pas par bonne volonté du client :

| Risque | Garde-fou |
| --- | --- |
| Accès sans droit | Jeton Bearer obligatoire (comparaison à temps constant). Le service refuse de démarrer sans. |
| Sortie du périmètre | `cwd` validé par **chemin réel** : un lien symbolique ne permet pas de sortir de `GATEWAY_ROOTS`. |
| Outils dangereux | Plafond serveur `GATEWAY_ALLOWED_TOOLS` (lecture seule par défaut) : une requête ne peut que le restreindre. |
| Contournement des permissions | `bypassPermissions` et `auto` sont refusés. Mode par défaut `dontAsk` : tout outil non pré-autorisé est **refusé**, sans question. Vérifié en réel : `Write` demandé sans être autorisé → 2 refus, fichier non créé. |
| Réglages de la machine | `settingSources: []` par défaut : ni hooks, ni `CLAUDE.md`, ni réglages utilisateur (opt-in : `loadProjectSettings`). |
| Coût et boucles | Plafonds serveur de budget (USD), de tours et de durée. Un client qui se déconnecte annule le run. |
| Saturation | `GATEWAY_MAX_CONCURRENT` runs simultanés, sinon `429`. |

Le service écoute en boucle locale. **Il ne fait pas de TLS** : pour l'exposer, placer un
proxy HTTPS devant, sinon le jeton circule en clair.

## API

Toutes les routes, sauf `/health`, exigent `Authorization: Bearer <jeton>`.

### `POST /v1/run` : exécute et renvoie le résultat

```bash
curl -s http://127.0.0.1:8787/v1/run \
  -H "Authorization: Bearer $GATEWAY_TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt":"Résume le fichier README.md","cwd":"/home/moi/projets/app","allowedTools":["Read"]}'
```

```json
{ "run_id": "…", "session_id": "…", "subtype": "success", "is_error": false,
  "result": "…", "num_turns": 2, "total_cost_usd": 0.021, "duration_ms": 2730,
  "usage": { "input_tokens": 2, "output_tokens": 4 }, "permission_denials": 0 }
```

Champs de la requête (seul `prompt` est obligatoire) :

| Champ | Rôle |
| --- | --- |
| `prompt` | Instruction (100 000 caractères max). |
| `cwd` | Dossier de travail, dans `GATEWAY_ROOTS` (défaut : le premier). |
| `allowedTools` | Sous-ensemble du plafond serveur. Le plafond est transmis au SDK comme `tools` : il tient quel que soit `permissionMode` (`acceptEdits` ne ramène pas `Edit`/`Write`). Les serveurs MCP de la machine (connecteurs claude.ai, `.mcp.json`, plugins) sont exclus. |
| `permissionMode` | `dontAsk` (défaut), `default`, `plan`, `acceptEdits`. |
| `resume` | `session_id` d'un run précédent : continue la conversation. |
| `maxTurns`, `maxBudgetUsd` | Plafonds du run, bornés par le serveur. |
| `model`, `systemPrompt` | Modèle ; texte **ajouté** au prompt système de Claude Code. |
| `run_id` | Identifiant choisi par le client (8 à 64 caractères `[A-Za-z0-9_-]`), pour pouvoir l'interrompre. |
| `loadProjectSettings` | Charge `CLAUDE.md` et les réglages du projet. |
| `includePartialMessages` | (stream) relaie les fragments de texte au fil de l'eau. |

### `POST /v1/stream` : même corps, flux SSE

Événements : `started` → `init` → `assistant` / `user` (blocs de texte et d'outils) →
`result`, ou `error`. `partial` si `includePartialMessages`. Un commentaire `: ping`
toutes les 15 s garde la connexion ouverte derrière un proxy.

```bash
curl -N http://127.0.0.1:8787/v1/stream -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" -d '{"prompt":"Liste les fichiers TypeScript"}'
```

### Autres routes

| Route | Rôle |
| --- | --- |
| `GET /health` | Sans jeton. `{status, running, capacity}`. |
| `GET /v1/runs` | Runs en cours. |
| `POST /v1/runs/:id/interrupt` | Interrompt un run (`202`, ou `404` s'il est inconnu). |

### Codes d'erreur

`{"error":{"code":"…","message":"…"}}`

| HTTP | `code` | Cause |
| --- | --- | --- |
| 400 | `invalid_request`, `invalid_json` | Corps ou champ invalide. |
| 401 | `unauthorized` | Jeton absent ou faux. |
| 403 | `cwd_forbidden`, `tool_forbidden` | Hors périmètre, ou outil hors plafond. |
| 404 | `run_not_found`, `not_found` | Aucun run en cours avec cet identifiant (interruption), ou route inconnue. |
| 409 | `run_id_in_use` | Ce `run_id` est déjà en cours. |
| 413 | `body_too_large` | Corps trop gros. |
| 422 | `budget_exceeded`, `max_turns_exceeded` | Plafond du run atteint. Lu sur le résultat `error_max_budget_usd` / `error_max_turns` du SDK sur `/v1/run` ; sur `/v1/stream`, le même sous-type arrive dans l'événement `result`. |
| 429 | `too_many_runs` | Capacité maximale atteinte. |
| 499 | `aborted` | Run interrompu, client parti ou délai dépassé. |
| 500 | `internal_error` | Erreur inattendue du serveur. Le détail est journalisé, jamais renvoyé. |
| 502 | `sdk_error`, `no_result` | Panne côté SDK (authentification Claude absente, par exemple), ou run terminé sans résultat (`499` s'il a été interrompu). |

## Développement

```bash
npm test          # 25 tests, sans réseau : un faux SDK remplace Claude
npm run typecheck
npm run build     # dist/ en JavaScript
```

Le code est découpé pour être testé : `config.ts` (environnement), `validate.ts` (la requête,
là où vivent les garde-fous), `errors.ts` (`HttpError`), `jobs.ts` (runs en cours),
`server.ts` (HTTP), `main.ts`.
Le serveur reçoit `query` en dépendance, d'où le faux SDK dans `tests/helpers.ts`.

## Pourquoi TypeScript et pas Go

Anthropic fournit l'Agent SDK en TypeScript et en Python. En Go, il faudrait piloter
`claude -p --output-format stream-json` à la main. Le SDK donne le même résultat en moins
de code, avec l'annulation, l'interruption et les types des messages.

## Licence

[MIT](LICENSE) © 2026 bacarndiaye
