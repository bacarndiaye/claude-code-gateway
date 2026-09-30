import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { Config } from '../src/config.ts';
import { createGateway } from '../src/server.ts';
import { ASSISTANT, INIT, RESULT, TOKEN, fakeQuery, makeSandbox, msg, type FakeQuery } from './helpers.ts';

async function start(t: TestContext, cfg: Config, q: FakeQuery) {
  const gw = createGateway(cfg, { query: q.fn, log: () => {} });
  await new Promise<void>((resolve) => gw.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(gw.server.address() as AddressInfo).port}`;
  t.after(
    () =>
      new Promise<void>((resolve) => {
        gw.jobs.abortAll();
        gw.server.closeAllConnections();
        gw.server.close(() => resolve());
      }),
  );
  return { gw, base };
}

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const post = (base: string, path: string, body: unknown, init: RequestInit = {}) =>
  fetch(base + path, { method: 'POST', headers: auth, body: JSON.stringify(body), ...init });

async function waitFor(cond: () => boolean, label: string, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) assert.fail(`délai dépassé : ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function parseSse(text: string): { event: string; data: unknown }[] {
  return text
    .split('\n\n')
    .filter((block) => block.includes('event:'))
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)![1]!;
      const data = JSON.parse(/^data: (.+)$/m.exec(block)![1]!);
      return { event, data };
    });
}

test('/health répond sans jeton', async (t) => {
  const { cfg } = makeSandbox();
  const { base } = await start(t, cfg, fakeQuery([]));
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', running: 0, capacity: 2 });
});

test('toutes les autres routes exigent le jeton', async (t) => {
  const { cfg } = makeSandbox();
  const q = fakeQuery([INIT, RESULT]);
  const { base } = await start(t, cfg, q);
  for (const headers of [{}, { Authorization: 'Bearer mauvais-jeton-0123456789' }, { Authorization: TOKEN }]) {
    const res = await fetch(base + '/v1/run', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"prompt":"x"}' });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  }
  assert.equal((await fetch(base + '/v1/runs')).status, 401);
  assert.equal(q.calls.length, 0, 'aucun run ne doit partir sans authentification');
});

test('/v1/run : résumé du résultat et options sûres transmises au SDK', async (t) => {
  const { cfg, root } = makeSandbox();
  const q = fakeQuery([INIT, ASSISTANT, RESULT]);
  const { base } = await start(t, cfg, q);

  const res = await post(base, '/v1/run', { prompt: 'Dis bonjour', run_id: 'run-abcdef01' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-run-id'), 'run-abcdef01');
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.result, 'Bonjour');
  assert.equal(body.session_id, 'sess-1');
  assert.equal(body.subtype, 'success');
  assert.equal(body.total_cost_usd, 0.0123);
  assert.deepEqual(body.usage, { input_tokens: 10, output_tokens: 5 });

  assert.equal(q.calls.length, 1);
  const { prompt, options } = q.calls[0]!;
  assert.equal(prompt, 'Dis bonjour');
  assert.equal(options.cwd, root);
  assert.equal(options.permissionMode, 'dontAsk');
  assert.deepEqual(options.tools, ['Read', 'Glob', 'Grep']);
  assert.deepEqual(options.allowedTools, ['Read', 'Glob', 'Grep']);
  // Aucun serveur MCP de la machine (connecteurs claude.ai, .mcp.json…) ne doit entrer dans la session.
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.maxTurns, 20);
  assert.equal(options.maxBudgetUsd, 1);
  assert.equal((options as Record<string, unknown>).allowDangerouslySkipPermissions, undefined);
});

test('/v1/run : requêtes invalides refusées avant tout appel au SDK', async (t) => {
  const { cfg, outside } = makeSandbox({ maxBodyBytes: 2_000 });
  const q = fakeQuery([INIT, RESULT]);
  const { base } = await start(t, cfg, q);

  const badJson = await fetch(base + '/v1/run', { method: 'POST', headers: auth, body: '{pas du json' });
  assert.equal(badJson.status, 400);
  assert.equal(((await badJson.json()) as { error: { code: string } }).error.code, 'invalid_json');

  assert.equal((await fetch(base + '/v1/run', { method: 'POST', headers: auth })).status, 400);
  assert.equal((await post(base, '/v1/run', { prompt: 'x', cwd: outside })).status, 403);
  assert.equal((await post(base, '/v1/run', { prompt: 'x', allowedTools: ['Bash'] })).status, 403);
  assert.equal((await post(base, '/v1/run', { prompt: 'x', permissionMode: 'bypassPermissions' })).status, 400);
  assert.equal((await post(base, '/v1/run', { prompt: 'x'.repeat(5_000) })).status, 413);
  assert.equal(q.calls.length, 0);
});

test('/v1/run : une erreur du SDK devient un 502 sans fuite de pile', async (t) => {
  const { cfg } = makeSandbox();
  const q = fakeQuery([], { failWith: new Error('authentification Claude absente') });
  const { base, gw } = await start(t, cfg, q);
  const res = await post(base, '/v1/run', { prompt: 'x' });
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'sdk_error');
  assert.match(body.error.message, /authentification Claude absente/);
  assert.equal(gw.jobs.size, 0, 'l\'emplacement doit être libéré');
});

const limitResult = (subtype: string) => msg({ ...(RESULT as unknown as Record<string, unknown>), subtype, is_error: true });

test('/v1/run : budget ou tours dépassés = 422 explicite, pas une panne', async (t) => {
  const { cfg } = makeSandbox();
  const cases: { name: string; q: FakeQuery; code: string }[] = [
    // Forme documentée par le SDK : un `result` d'erreur, sans exception.
    { name: 'result budget', q: fakeQuery([INIT, limitResult('error_max_budget_usd')]), code: 'budget_exceeded' },
    { name: 'result tours', q: fakeQuery([INIT, limitResult('error_max_turns')]), code: 'max_turns_exceeded' },
    // `result` d'erreur puis exception : le sous-type fait foi, même si le texte diffère.
    { name: 'result puis exception', q: fakeQuery([INIT, limitResult('error_max_turns')], { failAfter: new Error('process exited with code 1') }), code: 'max_turns_exceeded' },
    // Repli : le SDK lève sans avoir émis de `result`.
    { name: 'exception budget', q: fakeQuery([], { failWith: new Error('Claude Code returned an error result: Reached maximum budget ($0.05)') }), code: 'budget_exceeded' },
    { name: 'exception tours', q: fakeQuery([], { failWith: new Error('Reached maximum number of turns (3)') }), code: 'max_turns_exceeded' },
  ];
  for (const { name, q, code } of cases) {
    const { base, gw } = await start(t, cfg, q);
    const res = await post(base, '/v1/run', { prompt: 'x' });
    assert.equal(res.status, 422, name);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, code, name);
    assert.equal(gw.jobs.size, 0, `${name} : l'emplacement doit être libéré`);
  }
});

test('/v1/run : un result d\'erreur qui n\'est pas un plafond reste un 200 avec is_error', async (t) => {
  const { cfg } = makeSandbox();
  const { base } = await start(t, cfg, fakeQuery([INIT, limitResult('error_during_execution')]));
  const res = await post(base, '/v1/run', { prompt: 'x' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.subtype, 'error_during_execution');
  assert.equal(body.is_error, true);
});

test('plafond d\'outils : `tools` borne les outils existants, quel que soit le mode', async (t) => {
  // `Bash(...)` est une règle de permission : `tools` n'attend que le nom de l'outil.
  const { cfg } = makeSandbox({ allowedTools: ['Read', 'Glob', 'Bash(git status:*)'] });
  const q = fakeQuery([INIT, RESULT]);
  const { base } = await start(t, cfg, q);

  assert.equal((await post(base, '/v1/run', { prompt: 'x' })).status, 200);
  assert.deepEqual(q.calls[0]!.options.tools, ['Read', 'Glob', 'Bash']);
  assert.deepEqual(q.calls[0]!.options.allowedTools, ['Read', 'Glob', 'Bash(git status:*)']);

  // Une requête ne fait que restreindre ; `acceptEdits` ne peut pas faire apparaître Edit/Write.
  assert.equal((await post(base, '/v1/run', { prompt: 'x', allowedTools: ['Read'], permissionMode: 'acceptEdits' })).status, 200);
  const { options } = q.calls[1]!;
  assert.equal(options.permissionMode, 'acceptEdits');
  assert.deepEqual(options.tools, ['Read']);
  assert.deepEqual(options.allowedTools, ['Read']);
});

test('capacité atteinte : 429, liste des runs, puis interruption', async (t) => {
  const { cfg } = makeSandbox({ maxConcurrent: 1 });
  const q = fakeQuery([INIT, RESULT], { block: true });
  const { base, gw } = await start(t, cfg, q);

  const first = post(base, '/v1/run', { prompt: 'long', run_id: 'run-bloque-01' });
  await waitFor(() => gw.jobs.size === 1, 'le premier run démarre');

  assert.equal((await post(base, '/v1/run', { prompt: 'autre' })).status, 429);

  const list = (await (await fetch(base + '/v1/runs', { headers: auth })).json()) as { runs: { run_id: string }[] };
  assert.deepEqual(list.runs.map((r) => r.run_id), ['run-bloque-01']);

  const interrupt = await post(base, '/v1/runs/run-bloque-01/interrupt', {});
  assert.equal(interrupt.status, 202);
  const done = await first;
  assert.equal(done.status, 499);
  assert.equal(q.interrupted, 1);
  await waitFor(() => gw.jobs.size === 0, 'le run interrompu libère sa place');
});

test('run_id déjà en cours : 409 quand il reste de la capacité', async (t) => {
  const { cfg } = makeSandbox({ maxConcurrent: 2 });
  const q = fakeQuery([INIT, RESULT], { block: true });
  const { base, gw } = await start(t, cfg, q);

  const first = post(base, '/v1/run', { prompt: 'long', run_id: 'run-doublon-1' });
  await waitFor(() => gw.jobs.size === 1, 'le premier run démarre');
  assert.equal((await post(base, '/v1/run', { prompt: 'autre', run_id: 'run-doublon-1' })).status, 409);
  await post(base, '/v1/runs/run-doublon-1/interrupt', {});
  await first;
});

test('interruption d\'un run inconnu : 404', async (t) => {
  const { cfg } = makeSandbox();
  const { base } = await start(t, cfg, fakeQuery([]));
  assert.equal((await post(base, '/v1/runs/run-inconnu-1/interrupt', {})).status, 404);
});

test('le client qui se déconnecte annule le run', async (t) => {
  const { cfg } = makeSandbox();
  const q = fakeQuery([INIT, RESULT], { block: true });
  const { base, gw } = await start(t, cfg, q);

  const controller = new AbortController();
  const pending = post(base, '/v1/run', { prompt: 'long' }, { signal: controller.signal }).catch(() => null);
  await waitFor(() => gw.jobs.size === 1, 'le run démarre');
  controller.abort();
  await pending;
  await waitFor(() => gw.jobs.size === 0, 'le run est annulé après le départ du client');
  assert.equal(q.calls[0]!.options.abortController!.signal.aborted, true);
});

test('le délai maximal annule le run', async (t) => {
  const { cfg } = makeSandbox({ timeoutMs: 100 });
  const { base, gw } = await start(t, cfg, fakeQuery([INIT, RESULT], { block: true }));
  const res = await post(base, '/v1/run', { prompt: 'trop long' });
  assert.equal(res.status, 499);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'aborted');
  assert.equal(gw.jobs.size, 0);
});

test('/v1/stream : événements SSE dans l\'ordre, messages internes non relayés', async (t) => {
  const { cfg } = makeSandbox();
  const interne = msg({ type: 'rate_limit_event', session_id: 'sess-1' });
  const q = fakeQuery([INIT, interne, ASSISTANT, RESULT]);
  const { base, gw } = await start(t, cfg, q);

  const res = await post(base, '/v1/stream', { prompt: 'flux', run_id: 'run-flux-001' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(res.headers.get('x-run-id'), 'run-flux-001');

  const events = parseSse(await res.text());
  assert.deepEqual(events.map((e) => e.event), ['started', 'init', 'assistant', 'result']);
  assert.deepEqual(events[0]!.data, { run_id: 'run-flux-001' });
  assert.equal((events[3]!.data as { result: string }).result, 'Bonjour');
  await waitFor(() => gw.jobs.size === 0, 'le flux libère sa place');
});

test('/v1/stream : une erreur du SDK arrive en événement « error »', async (t) => {
  const { cfg } = makeSandbox();
  const { base } = await start(t, cfg, fakeQuery([], { failWith: new Error('panne SDK') }));
  const events = parseSse(await (await post(base, '/v1/stream', { prompt: 'x' })).text());
  assert.deepEqual(events.map((e) => e.event), ['started', 'error']);
  assert.match((events[1]!.data as { message: string }).message, /panne SDK/);
});

test('routes inconnues : 404 après authentification', async (t) => {
  const { cfg } = makeSandbox();
  const { base } = await start(t, cfg, fakeQuery([]));
  const res = await fetch(base + '/v1/inconnu', { headers: auth });
  assert.equal(res.status, 404);
});
