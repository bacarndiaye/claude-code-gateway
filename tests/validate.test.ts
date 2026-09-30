import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { isInside, parseRunRequest, ValidationError } from '../src/validate.ts';
import { makeSandbox } from './helpers.ts';

const newId = () => 'run-00000001';

function rejects(fn: () => unknown, status: number, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof ValidationError && e.status === status && e.code === code);
}

test('prompt obligatoire', () => {
  const { cfg } = makeSandbox();
  rejects(() => parseRunRequest({}, cfg, newId), 400, 'invalid_request');
  rejects(() => parseRunRequest({ prompt: '' }, cfg, newId), 400, 'invalid_request');
  rejects(() => parseRunRequest('texte', cfg, newId), 400, 'invalid_request');
});

test('valeurs par défaut : premier dossier autorisé, outils plafonnés, mode dontAsk', () => {
  const { cfg, root } = makeSandbox();
  const r = parseRunRequest({ prompt: 'salut' }, cfg, newId);
  assert.equal(r.cwd, root);
  assert.deepEqual(r.allowedTools, ['Read', 'Glob', 'Grep']);
  assert.equal(r.permissionMode, 'dontAsk');
  assert.equal(r.maxTurns, cfg.maxTurns);
  assert.equal(r.maxBudgetUsd, cfg.maxBudgetUsd);
  assert.equal(r.loadProjectSettings, false);
  assert.equal(r.runId, 'run-00000001');
});

test('cwd : sous-dossier accepté, hors périmètre et lien symbolique refusés', () => {
  const { cfg, project, outside, root } = makeSandbox();
  assert.equal(parseRunRequest({ prompt: 'x', cwd: project }, cfg, newId).cwd, project);
  rejects(() => parseRunRequest({ prompt: 'x', cwd: outside }, cfg, newId), 403, 'cwd_forbidden');
  // Le lien « evasion » est dans le périmètre mais mène dehors : le chemin réel décide.
  rejects(() => parseRunRequest({ prompt: 'x', cwd: join(root, 'evasion') }, cfg, newId), 403, 'cwd_forbidden');
  rejects(() => parseRunRequest({ prompt: 'x', cwd: join(root, '..', 'dehors') }, cfg, newId), 403, 'cwd_forbidden');
  rejects(() => parseRunRequest({ prompt: 'x', cwd: 'relatif' }, cfg, newId), 400, 'invalid_request');
  rejects(() => parseRunRequest({ prompt: 'x', cwd: join(root, 'inexistant') }, cfg, newId), 400, 'invalid_request');
});

test('isInside ne confond pas un dossier frère au préfixe commun', () => {
  assert.equal(isInside('/a/root', '/a/root'), true);
  assert.equal(isInside('/a/root', '/a/root/x/y'), true);
  assert.equal(isInside('/a/root', '/a/root-autre'), false);
  assert.equal(isInside('/a/root', '/a'), false);
});

test('allowedTools : sous-ensemble accepté, outil hors plafond refusé', () => {
  const { cfg } = makeSandbox();
  assert.deepEqual(parseRunRequest({ prompt: 'x', allowedTools: ['Read'] }, cfg, newId).allowedTools, ['Read']);
  rejects(() => parseRunRequest({ prompt: 'x', allowedTools: ['Read', 'Bash'] }, cfg, newId), 403, 'tool_forbidden');
  rejects(() => parseRunRequest({ prompt: 'x', allowedTools: 'Read' }, cfg, newId), 400, 'invalid_request');
});

test('permissionMode : bypassPermissions et auto sont refusés', () => {
  const { cfg } = makeSandbox();
  for (const mode of ['bypassPermissions', 'auto', 'inconnu', 3]) {
    rejects(() => parseRunRequest({ prompt: 'x', permissionMode: mode }, cfg, newId), 400, 'invalid_request');
  }
  for (const mode of ['dontAsk', 'default', 'plan', 'acceptEdits']) {
    assert.equal(parseRunRequest({ prompt: 'x', permissionMode: mode }, cfg, newId).permissionMode, mode);
  }
});

test('resume doit être un UUID', () => {
  const { cfg } = makeSandbox();
  const uuid = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(parseRunRequest({ prompt: 'x', resume: uuid }, cfg, newId).resume, uuid);
  rejects(() => parseRunRequest({ prompt: 'x', resume: '../../etc/passwd' }, cfg, newId), 400, 'invalid_request');
});

test('maxTurns et maxBudgetUsd : plafonnés par la configuration', () => {
  const { cfg } = makeSandbox({ maxTurns: 5, maxBudgetUsd: 0.5 });
  const r = parseRunRequest({ prompt: 'x', maxTurns: 3, maxBudgetUsd: 0.25 }, cfg, newId);
  assert.equal(r.maxTurns, 3);
  assert.equal(r.maxBudgetUsd, 0.25);
  rejects(() => parseRunRequest({ prompt: 'x', maxTurns: 6 }, cfg, newId), 400, 'invalid_request');
  rejects(() => parseRunRequest({ prompt: 'x', maxTurns: 1.5 }, cfg, newId), 400, 'invalid_request');
  rejects(() => parseRunRequest({ prompt: 'x', maxBudgetUsd: 0.51 }, cfg, newId), 400, 'invalid_request');
  rejects(() => parseRunRequest({ prompt: 'x', maxBudgetUsd: 0 }, cfg, newId), 400, 'invalid_request');
});

test('run_id et model : formats contrôlés', () => {
  const { cfg } = makeSandbox();
  assert.equal(parseRunRequest({ prompt: 'x', run_id: 'mon-run_42' }, cfg, newId).runId, 'mon-run_42');
  rejects(() => parseRunRequest({ prompt: 'x', run_id: 'court' }, cfg, newId), 400, 'invalid_request');
  rejects(() => parseRunRequest({ prompt: 'x', run_id: '../../x/../../y' }, cfg, newId), 400, 'invalid_request');
  assert.equal(parseRunRequest({ prompt: 'x', model: 'claude-sonnet-5-5' }, cfg, newId).model, 'claude-sonnet-5-5');
  rejects(() => parseRunRequest({ prompt: 'x', model: 'a b; rm -rf /' }, cfg, newId), 400, 'invalid_request');
});
