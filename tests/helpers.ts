import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../src/config.ts';
import type { QueryFn } from '../src/server.ts';

export const TOKEN = 'jeton-de-test-0123456789';

export interface Sandbox {
  root: string;
  project: string;
  outside: string;
  cfg: Config;
}

/** Dossiers temporaires : un périmètre autorisé, un dossier hors périmètre et un lien qui en sort. */
export function makeSandbox(overrides: Partial<Config> = {}): Sandbox {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ccg-')));
  const root = join(base, 'root');
  const project = join(root, 'projet');
  const outside = join(base, 'dehors');
  mkdirSync(project, { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(root, 'evasion'));
  const cfg: Config = {
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    roots: [root],
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxConcurrent: 2,
    timeoutMs: 30_000,
    maxBudgetUsd: 1,
    maxTurns: 20,
    maxBodyBytes: 100_000,
    ...overrides,
  };
  return { root, project, outside, cfg };
}

export const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage;

export const INIT = msg({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'fake-model', cwd: '/x', tools: ['Read'] });
export const ASSISTANT = msg({ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'text', text: 'Bonjour' }] } });
export const RESULT = msg({
  type: 'result',
  subtype: 'success',
  session_id: 'sess-1',
  is_error: false,
  result: 'Bonjour',
  num_turns: 1,
  total_cost_usd: 0.0123,
  duration_ms: 42,
  usage: { input_tokens: 10, output_tokens: 5 },
  permission_denials: [],
});

export interface FakeQuery {
  fn: QueryFn;
  calls: { prompt: string; options: Options }[];
  interrupted: number;
}

/**
 * Faux SDK. `block` : après les messages, attend l'annulation (abort) avant de lever
 * une erreur, comme le ferait le SDK quand on l'interrompt. `failWith` : lève cette erreur
 * d'emblée ; `failAfter` : la lève une fois les messages émis (un `result` d'erreur, puis l'exception).
 */
export function fakeQuery(messages: SDKMessage[], opts: { block?: boolean; failWith?: Error; failAfter?: Error } = {}): FakeQuery {
  const state: FakeQuery = { fn: undefined as unknown as QueryFn, calls: [], interrupted: 0 };
  state.fn = ({ prompt, options }) => {
    state.calls.push({ prompt, options });
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      if (opts.failWith) throw opts.failWith;
      for (const m of messages) {
        if (opts.block && m.type === 'result') break;
        yield m;
      }
      if (opts.failAfter) throw opts.failAfter;
      if (opts.block) {
        const signal = options.abortController!.signal;
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('interrompu');
      }
    }
    const it = gen();
    return Object.assign(it, {
      interrupt: async () => {
        state.interrupted++;
      },
    });
  };
  return state;
}
