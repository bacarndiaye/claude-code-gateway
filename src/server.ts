import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.ts';
import { HttpError } from './errors.ts';
import { JobRegistry, type Interruptible } from './jobs.ts';
import { parseRunRequest, type RunRequest } from './validate.ts';

/** Ce que le serveur attend du SDK : `query` de l'Agent SDK y satisfait tel quel. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage> & Interruptible;

export interface Deps {
  query: QueryFn;
  log?: (line: string) => void;
}

export interface Gateway {
  server: Server;
  jobs: JobRegistry;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** `expected` est l'empreinte du jeton configuré, calculée une fois au démarrage. */
function authorized(req: IncomingMessage, expected: Buffer): boolean {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  // Comparaison à temps constant sur des empreintes de même longueur.
  return timingSafeEqual(digest(m[1]!), expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: { code, message } }, headers);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new HttpError(413, 'body_too_large', `corps > ${maxBytes} octets`);
    chunks.push(buf);
  }
  if (size === 0) throw new HttpError(400, 'invalid_request', 'corps vide');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'JSON invalide');
  }
}

interface Failure {
  status: number;
  code: string;
  message: string;
}

/**
 * Plafond atteint, lu sur le sous-type du message `result` : c'est la forme que
 * documente le SDK (`error_max_budget_usd`, `error_max_turns`).
 */
function limitFailure(result: SDKResultMessage, r: RunRequest): Failure | undefined {
  switch (result.subtype) {
    case 'error_max_budget_usd':
      return { status: 422, code: 'budget_exceeded', message: `budget de ${r.maxBudgetUsd} USD atteint` };
    case 'error_max_turns':
      return { status: 422, code: 'max_turns_exceeded', message: `limite de ${r.maxTurns} tours atteinte` };
    default:
      return undefined;
  }
}

/**
 * Repli quand le SDK lève au lieu de (ou après) un `result` d'erreur : on lit le
 * texte de l'exception pour distinguer un plafond d'une vraie panne.
 */
export function classifySdkError(err: unknown): Failure {
  const message = err instanceof Error ? err.message : 'erreur du SDK';
  if (/maximum budget/i.test(message)) return { status: 422, code: 'budget_exceeded', message };
  if (/maximum number of turns|max.?turns/i.test(message)) return { status: 422, code: 'max_turns_exceeded', message };
  return { status: 502, code: 'sdk_error', message };
}

/** Échec d'un run annulé (délai, client parti, /interrupt, arrêt du serveur). */
const ABORTED: Failure = { status: 499, code: 'aborted', message: 'run annulé ou délai dépassé' };

/** `Bash(git status:*)` → `Bash` : `tools` attend des noms d'outils, pas des règles de permission. */
const toolNames = (rules: string[]): string[] => [...new Set(rules.map((rule) => rule.replace(/\(.*$/s, '')))];

function buildOptions(r: RunRequest, abortController: AbortController, streaming: boolean): Options {
  const options: Options = {
    abortController,
    cwd: r.cwd,
    // `tools` borne les outils qui existent pour le modèle : le plafond tient donc quel que
    // soit `permissionMode` (`acceptEdits` ne peut pas activer Edit/Write s'ils n'existent
    // pas). `allowedTools` ne fait que pré-approuver ceux-là, pour que `dontAsk` les laisse passer.
    tools: toolNames(r.allowedTools),
    allowedTools: r.allowedTools,
    // `tools` ne borne que les outils natifs : sans ceci, les serveurs MCP de la machine
    // (connecteurs claude.ai, .mcp.json, plugins) apparaissent dans la session.
    mcpServers: {},
    strictMcpConfig: true,
    // Toujours explicite : sans lui, le SDK peut démarrer en mode `auto`.
    permissionMode: r.permissionMode,
    maxTurns: r.maxTurns,
    maxBudgetUsd: r.maxBudgetUsd,
    // Isolation : ni hooks, ni CLAUDE.md, ni réglages de l'utilisateur de la machine.
    settingSources: r.loadProjectSettings ? ['project'] : [],
    // Les messages partiels ne servent qu'au flux SSE : /v1/run les jetterait.
    includePartialMessages: streaming && r.includePartialMessages,
  };
  if (r.resume) options.resume = r.resume;
  if (r.model) options.model = r.model;
  if (r.systemPromptAppend) {
    options.systemPrompt = { type: 'preset', preset: 'claude_code', append: r.systemPromptAppend };
  }
  return options;
}

type Loose = Record<string, unknown>;

/** Résumé d'un message `result`, sans détails internes du SDK. */
export function summarizeResult(msg: SDKMessage, runId: string): Loose {
  const m = msg as unknown as Loose;
  const usage = (m.usage ?? {}) as Loose;
  const denials = Array.isArray(m.permission_denials) ? m.permission_denials.length : 0;
  return {
    run_id: runId,
    session_id: m.session_id,
    subtype: m.subtype,
    is_error: m.is_error,
    result: m.subtype === 'success' ? m.result : undefined,
    errors: Array.isArray(m.errors) ? m.errors : undefined,
    num_turns: m.num_turns,
    total_cost_usd: m.total_cost_usd,
    duration_ms: m.duration_ms,
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    permission_denials: denials,
  };
}

/** Message SDK → événement SSE compact ; null = message interne non relayé. */
export function toEvent(msg: SDKMessage, runId: string): { event: string; data: unknown } | null {
  const m = msg as unknown as Loose;
  switch (m.type) {
    case 'system':
      if (m.subtype !== 'init') return null;
      return { event: 'init', data: { session_id: m.session_id, model: m.model, cwd: m.cwd, tools: m.tools } };
    case 'assistant':
    case 'user':
      return { event: String(m.type), data: { session_id: m.session_id, content: (m.message as Loose | undefined)?.content } };
    case 'stream_event':
      return { event: 'partial', data: { session_id: m.session_id, event: m.event } };
    case 'result':
      return { event: 'result', data: summarizeResult(msg, runId) };
    default:
      return null;
  }
}

export function createGateway(cfg: Config, deps: Deps): Gateway {
  const log = deps.log ?? ((line: string) => console.log(line));
  const jobs = new JobRegistry(cfg.maxConcurrent);
  const tokenDigest = digest(cfg.token);

  /** Démarre un run : valide, réserve un emplacement, arme timeout et annulation. */
  async function startRun(req: IncomingMessage, res: ServerResponse, streaming: boolean) {
    const body = await readJson(req, cfg.maxBodyBytes);
    const r = parseRunRequest(body, cfg, randomUUID);
    const job = jobs.tryStart(r.runId, r.cwd, Date.now());
    if (job === 'duplicate') throw new HttpError(409, 'run_id_in_use', 'run_id déjà en cours');
    if (job === 'full') throw new HttpError(429, 'too_many_runs', 'capacité maximale atteinte, réessayer plus tard');

    const timer = setTimeout(() => job.abort.abort(), cfg.timeoutMs);
    const finish = (outcome: string, extra = '') => {
      clearTimeout(timer);
      jobs.finish(job.id);
      log(`run=${job.id} cwd=${job.cwd} durée=${Date.now() - job.startedAt}ms ${outcome}${extra}`);
    };
    // Le client part avant la fin : on annule, inutile de dépenser pour personne.
    res.on('close', () => {
      if (!res.writableFinished) job.abort.abort();
    });

    let q: ReturnType<QueryFn>;
    try {
      q = deps.query({ prompt: r.prompt, options: buildOptions(r, job.abort, streaming) });
    } catch (err) {
      finish('erreur');
      throw err;
    }
    job.query = q;
    return { r, job, q, finish };
  }

  async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { r, job, q, finish } = await startRun(req, res, false);
    let result: SDKResultMessage | undefined;
    try {
      for await (const msg of q) {
        if (msg.type === 'result') result = msg;
      }
    } catch (err) {
      const aborted = job.abort.signal.aborted;
      finish(aborted ? 'annulé' : 'erreur');
      // Un `result` d'erreur déjà reçu fait foi ; le texte de l'exception n'est qu'un repli.
      const f = aborted ? ABORTED : (result && limitFailure(result, r)) || classifySdkError(err);
      return sendError(res, f.status, f.code, f.message);
    }
    if (!result) {
      const aborted = job.abort.signal.aborted;
      finish(aborted ? 'annulé' : 'sans résultat');
      return sendError(res, aborted ? 499 : 502, 'no_result', 'le run s\'est terminé sans résultat');
    }
    const summary = summarizeResult(result, r.runId);
    finish(String(summary.subtype), ` coût=${String(summary.total_cost_usd)}`);
    const limit = limitFailure(result, r);
    if (limit) return sendError(res, limit.status, limit.code, limit.message);
    sendJson(res, 200, summary, { 'X-Run-Id': r.runId });
  }

  async function handleStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { r, job, q, finish } = await startRun(req, res, true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Run-Id': r.runId,
    });
    const write = (chunk: string) => {
      if (!res.writableEnded && !res.destroyed) res.write(chunk);
    };
    const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // Commentaire SSE périodique : garde la connexion ouverte derrière un proxy.
    const heartbeat = setInterval(() => write(': ping\n\n'), 15_000);

    send('started', { run_id: r.runId });
    let subtype = 'sans résultat';
    try {
      for await (const msg of q) {
        const ev = toEvent(msg, r.runId);
        if (!ev) continue;
        send(ev.event, ev.data);
        if (ev.event === 'result') subtype = String((ev.data as Loose).subtype);
      }
    } catch (err) {
      const aborted = job.abort.signal.aborted;
      subtype = aborted ? 'annulé' : 'erreur';
      const f = aborted ? ABORTED : classifySdkError(err);
      send('error', { code: f.code, message: f.message });
    } finally {
      clearInterval(heartbeat);
      finish(subtype);
      if (!res.writableEnded) res.end();
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/health') {
      return sendJson(res, 200, { status: 'ok', running: jobs.size, capacity: cfg.maxConcurrent });
    }

    if (!authorized(req, tokenDigest)) {
      return sendError(res, 401, 'unauthorized', 'jeton Bearer absent ou invalide', { 'WWW-Authenticate': 'Bearer' });
    }

    if (method === 'POST' && path === '/v1/run') return handleRun(req, res);
    if (method === 'POST' && path === '/v1/stream') return handleStream(req, res);

    if (method === 'GET' && path === '/v1/runs') {
      return sendJson(res, 200, {
        runs: jobs.list().map((j) => ({ run_id: j.id, cwd: j.cwd, started_at: new Date(j.startedAt).toISOString() })),
      });
    }

    // Le format de l'identifiant n'est pas revérifié ici : un identifiant inconnu donne 404 de toute façon.
    const runId = /^\/v1\/runs\/([^/]+)\/interrupt$/.exec(path)?.[1];
    if (method === 'POST' && runId) {
      if (!(await jobs.interrupt(runId))) return sendError(res, 404, 'run_not_found', 'aucun run en cours avec cet identifiant');
      return sendJson(res, 202, { run_id: runId, interrupted: true });
    }

    sendError(res, 404, 'not_found', 'route inconnue');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
      log(`erreur interne: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'erreur interne');
      else res.end();
    });
  });
  // Un run peut durer des minutes : pas de délai de requête côté Node.
  server.requestTimeout = 0;

  return { server, jobs };
}
