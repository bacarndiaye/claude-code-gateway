# claude-code-gateway

> An authenticated HTTP gateway (JSON + Server-Sent Events) around the **Claude Agent SDK**, so any program can drive Claude Code over the network — safely.

🇫🇷 Version française : [README.fr.md](README.fr.md) · 🌐 Project page: <https://bacarndiaye.github.io/claude-code-gateway/>

---

## Table of contents

1. [What it is](#what-it-is)
2. [Why it exists](#why-it-exists)
3. [How it works](#how-it-works)
4. [Tech stack](#tech-stack)
5. [Installation](#installation)
6. [Configuration](#configuration)
7. [Security model](#security-model)
8. [API reference](#api-reference)
9. [Usage examples](#usage-examples)
10. [Project layout](#project-layout)
11. [Development and testing](#development-and-testing)
12. [Design decisions](#design-decisions)
13. [Limitations](#limitations)
14. [Troubleshooting](#troubleshooting)

---

## What it is

Claude Code is a command-line agent. It can be driven programmatically in two official ways:

- **Headless mode** — `claude -p "<prompt>"`, a non-interactive run that returns a result and an exit code.
- **Agent SDK** — `@anthropic-ai/claude-agent-sdk` (TypeScript) and `claude-agent-sdk` (Python), which expose the same agent loop, tools and context management as typed objects.

Neither is a network service: there is no REST/HTTP API out of the box. **This project is that missing service.** It is a small Node.js server that accepts a prompt as JSON, runs it through the Agent SDK, and returns either the final result (`POST /v1/run`) or a live event stream (`POST /v1/stream`).

It is deliberately *not* a thin pass-through. Whoever holds the token steers an agent that can read — and, if you allow it, modify — files on the host, so the gateway enforces limits **on the server side** (folders, tools, permission mode, budget, concurrency) instead of trusting the client.

## Why it exists

- **Call Claude Code from anything.** A web backend, a CI job, a chatbot, a cron task, a script in any language: if it can send an HTTP request, it can use Claude Code.
- **Keep the agent on one machine.** The agent runs where the code and the credentials live; clients only need a URL and a token.
- **Get the safety controls a shared service needs.** Running `claude` with broad permissions behind an endpoint is easy and dangerous. The gateway makes the safe configuration the default and the unsafe one unavailable.
- **Observe runs.** Every run has an id, a cost, a duration and a session id; runs can be listed, resumed and interrupted.

## How it works

```
                        ┌──────────────────────────── claude-code-gateway ─────────────────────────────┐
  HTTP client           │                                                                              │
  (curl, backend,  ───▶ │  Bearer auth ─▶ validate.ts ─▶ JobRegistry ─▶ Agent SDK query() ─────────────┼──▶ Claude Code
   CI, script)          │   (401)          (400/403)       (429/409)     abortController, options      │     process ──▶ Anthropic API
        ▲               │                                                                              │
        └── JSON / SSE ◀┼──────────── summarized result · or events: started, init, assistant, result ──┘
                        └──────────────────────────────────────────────────────────────────────────────┘
```

For each request the gateway:

1. **Authenticates** the `Authorization: Bearer <token>` header (constant-time comparison).
2. **Validates** the body (`validate.ts`): the working directory must resolve, through symlinks, inside an allowed root; requested tools must be a subset of the server-side cap; unsafe permission modes are rejected; budget, turns and ids are bounded.
3. **Reserves a slot** in the `JobRegistry`. If the gateway is full it answers `429`; if the `run_id` is already running, `409`.
4. **Calls `query()`** from the Agent SDK with options built *by the server*: an explicit `permissionMode` (never the SDK's default, which may be `auto`), isolated `settingSources`, the validated `cwd`, tools, turns and budget, and an `AbortController`.
5. **Streams or summarizes.** `/v1/run` waits for the final `result` message and returns a compact summary; `/v1/stream` relays selected messages as SSE events.
6. **Cleans up.** A timeout, an interrupt request, or a client that disconnects aborts the run and frees the slot.

## Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Language | **TypeScript** (strict, `noUncheckedIndexedAccess`) | The Agent SDK is first-class in TypeScript; the types of messages and options catch mistakes at compile time. |
| Runtime | **Node.js ≥ 20** | Native `fetch`, `node:test`, and a mature HTTP server — no framework needed. |
| Agent | **`@anthropic-ai/claude-agent-sdk`** | Same agent loop, tools and context handling as Claude Code, with abort/interrupt and typed messages. |
| HTTP | **`node:http`** (no framework) | The surface is five routes; a framework would add dependencies and attack surface for nothing. |
| Dev runner | **`tsx`** | Runs TypeScript directly, for `npm start`, `npm run dev` and the tests. |
| Type checking / build | **`tsc`** | `npm run typecheck`, and `npm run build` emits plain JavaScript into `dist/`. |
| Tests | **`node:test`** + `node:assert` | Zero test dependencies; a fake SDK replaces Claude so tests run offline and free. |

**One runtime dependency** (the SDK). Everything else is development tooling.

## Installation

### Requirements

- **Node.js 20 or newer** and npm.
- **Claude authentication on the host**, either:
  - a logged-in Claude Code (`claude login`, subscription), or
  - an API key exported as `ANTHROPIC_API_KEY`.

### Steps

```bash
git clone <this repository> claude-code-gateway
cd claude-code-gateway
npm install

# 1. A secret token (16 characters minimum; the server refuses to start without one)
export GATEWAY_TOKEN=$(openssl rand -hex 32)

# 2. The folders Claude is allowed to work in (absolute paths, separated by ':')
export GATEWAY_ROOTS=$HOME/projects

# 3. Start
npm start            # listening on http://127.0.0.1:8787
```

Check that it is up (no token needed for this route):

```bash
curl -s http://127.0.0.1:8787/health
# {"status":"ok","running":0,"capacity":2}
```

### Running a built copy

```bash
npm run build        # compiles src/ to dist/
node dist/main.js    # same configuration, same environment variables
```

## Configuration

Everything is configured through environment variables; see [`.env.example`](.env.example). The server exits with code `2` and an explicit message on an invalid value.

| Variable | Default | Description |
| --- | --- | --- |
| `GATEWAY_TOKEN` | *(required)* | Bearer token, 16 characters minimum. |
| `GATEWAY_ROOTS` | *(required)* | Absolute folders Claude may work in, separated by `:`. The first one is the default `cwd`. |
| `GATEWAY_HOST` | `127.0.0.1` | Listen address. Loopback only by default. |
| `GATEWAY_PORT` | `8787` | Listen port. |
| `GATEWAY_ALLOWED_TOOLS` | `Read,Glob,Grep` | Server-side **cap** on tools. A request can only narrow it. Adding `Edit`, `Write` or `Bash` gives those powers to every holder of the token. |
| `GATEWAY_MAX_CONCURRENT` | `2` | Simultaneous runs; beyond that, `429`. |
| `GATEWAY_TIMEOUT_MS` | `600000` | Hard limit per run (10 min). |
| `GATEWAY_MAX_BUDGET_USD` | `1` | Cap on the cost of one run. |
| `GATEWAY_MAX_TURNS` | `20` | Cap on agent turns per run. |
| `GATEWAY_MAX_BODY_BYTES` | `1000000` | Maximum request body size. |

## Security model

The threat model is simple: **the token is powerful, and the prompt can be influenced by untrusted content** (a file the agent reads may contain instructions). So the limits live in the server, not in the client's good behavior.

| Risk | Safeguard |
| --- | --- |
| Unauthorized access | Bearer token on every route except `/health`; constant-time comparison; the server will not start without a token. |
| Escaping the allowed folders | `cwd` is checked on its **real path** (`realpath`), so a symlink inside an allowed root that points outside is rejected (`403 cwd_forbidden`). |
| Dangerous tools | Server-side cap `GATEWAY_ALLOWED_TOOLS`, read-only by default; requests may only restrict it (`403 tool_forbidden`). The cap is passed to the SDK as `tools`, which limits the tools that exist for the model, so it holds in every permission mode (`acceptEdits` cannot bring back `Edit`/`Write`). `allowedTools` is also set, but only to pre-approve them. |
| Permission bypass | `bypassPermissions` and `auto` are **refused**. The default mode is `dontAsk`: any tool that is not pre-approved is *denied without asking*. The permission mode is always sent explicitly, because the SDK's own default may be `auto`. |
| Host configuration leaking in | `settingSources: []` by default — no user hooks, no `CLAUDE.md`, no local settings. Opt in per request with `loadProjectSettings`. `strictMcpConfig` with an empty `mcpServers` keeps the host's MCP servers out (claude.ai connectors such as Gmail or Drive, `.mcp.json`, plugins): `tools` only limits built-in tools, and without this the agent saw 100 connector tools. |
| Runaway cost or loops | Server-side caps on budget, turns and duration. A client that disconnects cancels its run. |
| Overload | Bounded concurrency; over capacity the gateway answers `429` instead of queuing. |
| Information leaks | Errors are returned as `{error:{code,message}}`, never as stack traces. Prompts are not written to the log. |

This was verified against the real SDK, not only with mocks. Asking for a `Write` while only `Read` was allowed produced two permission denials and no file. With the `tools` cap and `strictMcpConfig`, a write request in `acceptEdits` mode gets an `init` event listing only `Glob`, `Grep` and `Read`, the model reports it has no `Write` tool, and no file is created. A one-turn cap returns `422 max_turns_exceeded` and a `maxBudgetUsd` too small to finish returns `422 budget_exceeded`; in both cases the SDK throws after the error result, and the subtype is what decides the code.

> **The gateway does not do TLS.** It listens on loopback by default. To expose it, put an HTTPS reverse proxy (nginx, Caddy…) in front; otherwise the token travels in clear text. The server prints a warning when bound to a non-loopback address.

## API reference

All routes except `GET /health` require `Authorization: Bearer <token>`.

### `POST /v1/run` — run and return the result

Request body (only `prompt` is required):

| Field | Description |
| --- | --- |
| `prompt` | The instruction (up to 100,000 characters). |
| `cwd` | Working directory, inside `GATEWAY_ROOTS` (default: the first root). |
| `allowedTools` | Subset of the server-side cap. |
| `permissionMode` | `dontAsk` (default), `default`, `plan` or `acceptEdits`. |
| `resume` | A `session_id` from a previous run, to continue that conversation. |
| `maxTurns`, `maxBudgetUsd` | Per-run limits, bounded by the server caps. |
| `model` | Model name. |
| `systemPrompt` | Text **appended** to Claude Code's system prompt. |
| `run_id` | Client-chosen id (8–64 chars of `[A-Za-z0-9_-]`), so the run can be interrupted while in flight. A UUID is generated otherwise. |
| `loadProjectSettings` | Load the project's `CLAUDE.md` and settings. |
| `includePartialMessages` | (`/v1/stream`) also relay partial text fragments. |

Response `200`:

```json
{
  "run_id": "08488712-aaef-4e90-b008-4d7291cce4ae",
  "session_id": "38d5ebd7-b0fb-4464-b0aa-948eb8f0fa8d",
  "subtype": "success",
  "is_error": false,
  "result": "OK",
  "num_turns": 1,
  "total_cost_usd": 0.021115,
  "duration_ms": 2730,
  "usage": { "input_tokens": 2, "output_tokens": 4 },
  "permission_denials": 0
}
```

The `X-Run-Id` response header carries the run id.

### `POST /v1/stream` — same body, Server-Sent Events

| Event | Payload |
| --- | --- |
| `started` | `{ run_id }` |
| `init` | `{ session_id, model, cwd, tools }` |
| `assistant` / `user` | `{ session_id, content }` — text blocks, tool calls and tool results |
| `partial` | Partial text fragments (only with `includePartialMessages`) |
| `result` | Same summary as `/v1/run` |
| `error` | `{ code, message }` |

A `: ping` comment is sent every 15 s to keep the connection alive behind proxies.

### Other routes

| Route | Description |
| --- | --- |
| `GET /health` | No token. `{ status, running, capacity }`. |
| `GET /v1/runs` | Runs currently in progress. |
| `POST /v1/runs/:id/interrupt` | Interrupts a run: `202`, or `404` if unknown. |

### Errors

Every error has the shape `{ "error": { "code": "...", "message": "..." } }`.

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request`, `invalid_json` | Malformed body or invalid field. |
| 401 | `unauthorized` | Missing or wrong token. |
| 403 | `cwd_forbidden`, `tool_forbidden` | Outside the allowed folders, or tool outside the cap. |
| 404 | `run_not_found`, `not_found` | No running run with that id (interrupt), or unknown route. |
| 409 | `run_id_in_use` | That `run_id` is already running. |
| 413 | `body_too_large` | Body larger than `GATEWAY_MAX_BODY_BYTES`. |
| 422 | `budget_exceeded`, `max_turns_exceeded` | The run hit its budget or turn limit. Read from the SDK's `error_max_budget_usd` / `error_max_turns` result on `/v1/run`; on `/v1/stream` the same subtype arrives in the `result` event. |
| 429 | `too_many_runs` | The gateway is at capacity. |
| 499 | `aborted` | Interrupted, client disconnected, or timed out. |
| 500 | `internal_error` | Unexpected server error. The detail is logged, never returned. |
| 502 | `sdk_error`, `no_result` | SDK-side failure (for instance, Claude is not authenticated), or the run ended without a result (`499` instead if it was aborted). |

## Usage examples

### curl

```bash
curl -s http://127.0.0.1:8787/v1/run \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "prompt": "Summarize README.md in three bullet points",
        "cwd": "/home/me/projects/app",
        "allowedTools": ["Read"]
      }'
```

### Continue a conversation

```bash
SESSION=$(curl -s http://127.0.0.1:8787/v1/run -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" -d '{"prompt":"Remember the word BAOBAB. Reply OK."}' \
  | jq -r .session_id)

curl -s http://127.0.0.1:8787/v1/run -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"Which word did I ask you to remember?\",\"resume\":\"$SESSION\"}"
# → "BAOBAB"
```

### Watch a run live, and interrupt it

```bash
curl -N http://127.0.0.1:8787/v1/stream -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"List the TypeScript files and describe each","run_id":"demo-run-0001"}'

# from another terminal
curl -X POST http://127.0.0.1:8787/v1/runs/demo-run-0001/interrupt \
  -H "Authorization: Bearer $GATEWAY_TOKEN"
```

### From TypeScript

```ts
const res = await fetch("http://127.0.0.1:8787/v1/run", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.GATEWAY_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ prompt: "What does src/server.ts do?", allowedTools: ["Read"] }),
});
const { result, total_cost_usd } = await res.json();
```

## Project layout

```
claude-code-gateway/
├── src/
│   ├── main.ts        # entry point: loads config, starts the server, graceful shutdown
│   ├── config.ts      # environment variables → typed, validated Config
│   ├── errors.ts      # HttpError: status + code + message, mapped to the JSON error body
│   ├── validate.ts    # request validation — where the safeguards live
│   ├── jobs.ts        # registry of in-flight runs (capacity, ids, interrupt)
│   └── server.ts      # HTTP routes, auth, SSE, error mapping
├── tests/
│   ├── helpers.ts          # sandbox folders + a fake Agent SDK
│   ├── validate.test.ts    # request validation and safeguards
│   └── server.test.ts      # HTTP behavior end to end, with the fake SDK
├── .env.example
├── README.md / README.fr.md
└── package.json · tsconfig.json · tsconfig.build.json
```

## Development and testing

```bash
npm test             # 25 tests, offline, no Claude credentials needed
npm run typecheck    # tsc --noEmit
npm run dev          # restarts on change (tsx watch)
npm run build        # emit JavaScript to dist/
```

The server receives the SDK's `query` function as a dependency (`createGateway(cfg, { query })`). Production passes the real one; the tests pass a fake that can stream canned messages, fail, or block until aborted. That is what lets the suite cover authentication, every validation rule, capacity limits, interruption, client disconnection, timeouts and SSE framing **without spending a cent or touching the network**.

The tests also exercise real edges: a symlink that escapes an allowed root, a sibling folder sharing a path prefix with a root, and forbidden permission modes.

## Design decisions

- **A gateway, not an HTTP passthrough of `claude -p`.** The value is in the server-side limits. Anything the client may choose is something an attacker holding the token may choose.
- **Reject, don't sanitize.** An out-of-policy `cwd` or tool list is an error (`403`), never silently corrected, so callers learn immediately.
- **`dontAsk` as the default permission mode.** A headless service cannot answer interactive prompts. `dontAsk` denies whatever is not pre-approved, which is the only safe non-interactive behavior.
- **Permission mode is always explicit.** Left unset, the SDK may start in `auto` (a model classifier approves tool calls). The gateway never relies on that.
- **Isolation by default** (`settingSources: []`). The host's hooks and `CLAUDE.md` should not silently change what a remote caller gets.
- **TypeScript rather than Go.** Anthropic ships the Agent SDK for TypeScript and Python, not Go. In Go the gateway would have to drive `claude -p --output-format stream-json` by hand and re-implement abort, interrupt and message typing.
- **No web framework.** Five routes do not justify one.
- **Caps are ceilings.** Requests can lower `maxTurns` and `maxBudgetUsd`, never raise them.

## Limitations

- **No TLS, no multi-user model.** One shared token, one trust level. Put it behind a reverse proxy and treat the token like a password. Per-user tokens, quotas and audit logs are not implemented.
- **In-memory state.** Running jobs are not persisted; restarting the gateway cancels them. Conversations survive through Claude Code's own session store (`resume`).
- **Interactive approvals are not exposed.** `permissionMode: "default"` would normally ask the user; over HTTP there is nobody to answer, so use `dontAsk` with an explicit tool list.
- **Cost figures are the SDK's estimate**, not a billing statement.
- **It runs the real agent.** Anything in `GATEWAY_ALLOWED_TOOLS` is actually executable on the host. `Bash` in particular is a shell: only add it in an isolated environment (container, dedicated user, restricted roots).

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `configuration invalide : GATEWAY_TOKEN est obligatoire` | Token missing or shorter than 16 characters. |
| `502 sdk_error` mentioning authentication | Claude is not logged in on the host: run `claude login` or set `ANTHROPIC_API_KEY`. |
| `422 budget_exceeded` on a trivial prompt | `maxBudgetUsd` is too low. With the host's MCP servers excluded a trivial run measured about $0.003; if a run hits this error, raise the cap. |
| `403 cwd_forbidden` for a folder that looks allowed | The real path is outside the roots (a symlink), or the folder is a sibling sharing a prefix with a root. |
| `403 tool_forbidden` | The tool is not in `GATEWAY_ALLOWED_TOOLS`. Add it deliberately, or remove it from the request. |
| `permission_denials > 0` and a refusal in `result` | Working as designed: a tool was requested that the run was not allowed to use. |
| `429 too_many_runs` | Raise `GATEWAY_MAX_CONCURRENT`, or retry later. |

## License

[MIT](LICENSE) © 2026 bacarndiaye
