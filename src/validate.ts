import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import type { Config } from './config.ts';
import { HttpError } from './errors.ts';

/**
 * Modes acceptés. `bypassPermissions` et `auto` sont refusés : le premier
 * désactive tout contrôle, le second délègue la décision à un classifieur. Une
 * passerelle réseau ne doit offrir ni l'un ni l'autre.
 */
export const PERMISSION_MODES = ['dontAsk', 'default', 'plan', 'acceptEdits'] as const;
export type SafePermissionMode = (typeof PERMISSION_MODES)[number];

export interface RunRequest {
  runId: string;
  prompt: string;
  cwd: string;
  allowedTools: string[];
  permissionMode: SafePermissionMode;
  resume?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  model?: string;
  systemPromptAppend?: string;
  loadProjectSettings: boolean;
  includePartialMessages: boolean;
}

export class ValidationError extends HttpError {
  constructor(message: string, status: 400 | 403 = 400, code = 'invalid_request') {
    super(status, code, message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MODEL = /^[A-Za-z0-9._:/\[\]-]{1,100}$/;

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('le corps doit être un objet JSON');
  }
  return body as Record<string, unknown>;
}

function optString(o: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new ValidationError(`${key} doit être une chaîne de 1 à ${max} caractères`);
  }
  return v;
}

/** Nombre optionnel, borné par `cap` (le plafond de la config) ; absent → `cap`. */
function optNumber(o: Record<string, unknown>, key: string, cap: number, integer: boolean): number {
  const v = o[key];
  if (v === undefined || v === null) return cap;
  if (typeof v !== 'number' || !(integer ? Number.isInteger(v) && v >= 1 : v > 0) || v > cap) {
    throw new ValidationError(`${key} doit être ${integer ? 'un entier entre 1' : 'un nombre > 0'} et ${cap}`);
  }
  return v;
}

function optBool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw new ValidationError(`${key} doit être un booléen`);
  return v;
}

export function parseRunRequest(body: unknown, cfg: Config, newRunId: () => string): RunRequest {
  const o = asObject(body);

  const prompt = optString(o, 'prompt', 100_000);
  if (prompt === undefined) throw new ValidationError('prompt est obligatoire');

  const runId = optString(o, 'run_id', 64) ?? newRunId();
  if (!RUN_ID.test(runId)) {
    throw new ValidationError('run_id doit contenir 8 à 64 caractères [A-Za-z0-9_-]');
  }

  // cwd : chemin réel, donc les liens symboliques ne permettent pas de sortir.
  const askedCwd = optString(o, 'cwd', 4096);
  const cwdInput = askedCwd ?? cfg.roots[0]!;
  if (!isAbsolute(cwdInput)) throw new ValidationError('cwd doit être un chemin absolu');
  let cwd: string;
  try {
    cwd = realpathSync(cwdInput);
  } catch {
    throw new ValidationError(`cwd introuvable : ${cwdInput}`);
  }
  if (!cfg.roots.some((root) => isInside(root, cwd))) {
    throw new ValidationError('cwd hors des dossiers autorisés (GATEWAY_ROOTS)', 403, 'cwd_forbidden');
  }

  let allowedTools = cfg.allowedTools;
  if (o.allowedTools !== undefined && o.allowedTools !== null) {
    const list: unknown = o.allowedTools;
    if (!Array.isArray(list) || list.length > 50 || !list.every((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 200)) {
      throw new ValidationError('allowedTools doit être une liste de 50 chaînes au plus');
    }
    const refused = list.filter((t) => !cfg.allowedTools.includes(t));
    if (refused.length > 0) {
      throw new ValidationError(`outil(s) non autorisé(s) : ${refused.join(', ')}`, 403, 'tool_forbidden');
    }
    allowedTools = [...new Set(list)];
  }

  const modeRaw = o.permissionMode ?? 'dontAsk';
  if (typeof modeRaw !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(modeRaw)) {
    throw new ValidationError(`permissionMode doit valoir : ${PERMISSION_MODES.join(', ')}`);
  }

  const resume = optString(o, 'resume', 64);
  if (resume !== undefined && !UUID.test(resume)) throw new ValidationError('resume doit être un identifiant de session (UUID)');

  const maxTurns = optNumber(o, 'maxTurns', cfg.maxTurns, true);
  const maxBudgetUsd = optNumber(o, 'maxBudgetUsd', cfg.maxBudgetUsd, false);

  const model = optString(o, 'model', 100);
  if (model !== undefined && !MODEL.test(model)) throw new ValidationError('model contient des caractères non autorisés');

  return {
    runId,
    prompt,
    cwd,
    allowedTools,
    permissionMode: modeRaw as SafePermissionMode,
    resume,
    maxTurns,
    maxBudgetUsd,
    model,
    systemPromptAppend: optString(o, 'systemPrompt', 20_000),
    loadProjectSettings: optBool(o, 'loadProjectSettings'),
    includePartialMessages: optBool(o, 'includePartialMessages'),
  };
}
