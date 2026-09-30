import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface Config {
  host: string;
  port: number;
  /** Jeton Bearer exigé sur toutes les routes sauf /health. */
  token: string;
  /** Dossiers (chemins réels) dans lesquels un run peut travailler. */
  roots: string[];
  /** Plafond des outils : une requête ne peut jamais en demander d'autres. */
  allowedTools: string[];
  maxConcurrent: number;
  timeoutMs: number;
  maxBudgetUsd: number;
  maxTurns: number;
  maxBodyBytes: number;
}

export class ConfigError extends Error {}

function numEnv(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number, integer = true): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!(integer ? Number.isInteger(n) : Number.isFinite(n)) || n < min || n > max) {
    throw new ConfigError(`${name} doit être ${integer ? 'un entier' : 'un nombre'} entre ${min} et ${max} (reçu « ${raw} »)`);
  }
  return n;
}

const list = (raw: string, separator: string): string[] =>
  raw
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.GATEWAY_TOKEN ?? '';
  if (token.length < 16) {
    throw new ConfigError('GATEWAY_TOKEN est obligatoire (16 caractères minimum)');
  }

  const rawRoots = list(env.GATEWAY_ROOTS ?? '', ':');
  if (rawRoots.length === 0) {
    throw new ConfigError('GATEWAY_ROOTS est obligatoire : dossiers absolus autorisés, séparés par « : »');
  }
  const roots = rawRoots.map((r) => {
    if (!isAbsolute(r)) throw new ConfigError(`GATEWAY_ROOTS : chemin non absolu : ${r}`);
    try {
      return realpathSync(r);
    } catch {
      throw new ConfigError(`GATEWAY_ROOTS : dossier introuvable : ${r}`);
    }
  });

  const allowedTools = list(env.GATEWAY_ALLOWED_TOOLS ?? 'Read,Glob,Grep', ',');
  if (allowedTools.length === 0) {
    throw new ConfigError('GATEWAY_ALLOWED_TOOLS ne peut pas être vide');
  }

  return {
    host: env.GATEWAY_HOST || '127.0.0.1',
    port: numEnv(env, 'GATEWAY_PORT', 8787, 1, 65535),
    token,
    roots,
    allowedTools,
    maxConcurrent: numEnv(env, 'GATEWAY_MAX_CONCURRENT', 2, 1, 64),
    timeoutMs: numEnv(env, 'GATEWAY_TIMEOUT_MS', 600_000, 1_000, 3_600_000),
    maxBudgetUsd: numEnv(env, 'GATEWAY_MAX_BUDGET_USD', 1, 0.01, 1000, false),
    maxTurns: numEnv(env, 'GATEWAY_MAX_TURNS', 20, 1, 500),
    maxBodyBytes: numEnv(env, 'GATEWAY_MAX_BODY_BYTES', 1_000_000, 1_024, 50_000_000),
  };
}
