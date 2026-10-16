import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandFor, EVENTS, planInstall, planUninstall } from '../scripts/codex-install.mjs';

const cmd = commandFor('/usr/bin/node');
const other = { type: 'command', command: 'outro-app hook' };

test('acrescenta no fim de cada evento e mantém os hooks de outros apps', () => {
  const before = { description: 'meus hooks', hooks: { Stop: [{ hooks: [other] }] } };
  const { data, changed } = planInstall(before, cmd);
  assert.equal(changed, true);
  assert.equal(data.description, 'meus hooks');
  assert.deepEqual(data.hooks.Stop[0], { hooks: [other] });
  assert.match(data.hooks.Stop[1].hooks[0].command, /plugin\/kwik\/hooks\/hook\.mjs" codex$/);
  for (const ev of EVENTS) assert.ok(data.hooks[ev].some((g) => g.hooks.some((h) => h.command === cmd)), ev);
  assert.equal(data.hooks.PreToolUse.at(-1).hooks[0].async, true);
  assert.equal(data.hooks.PermissionRequest.at(-1).hooks[0].async, undefined);
  // O original não muda.
  assert.equal(before.hooks.Stop.length, 1);
});

test('rodar de novo não duplica; atualizar troca no mesmo lugar', () => {
  const first = planInstall({}, cmd).data;
  const again = planInstall(first, cmd);
  assert.equal(again.changed, false);
  const moved = planInstall(first, commandFor('/opt/node/bin/node'));
  assert.equal(moved.changed, true);
  assert.equal(moved.data.hooks.Stop.length, 1);
  assert.match(moved.data.hooks.Stop[0].hooks[0].command, /^"\/opt\/node\/bin\/node"/);
});

test('remover tira só os da KWIK', () => {
  const installed = planInstall({ hooks: { Stop: [{ hooks: [other] }] } }, cmd).data;
  const { data, changed } = planUninstall(installed);
  assert.equal(changed, true);
  assert.deepEqual(data.hooks, { Stop: [{ hooks: [other] }] });
});

test('formato desconhecido: não mexe', () => {
  assert.ok(planInstall({ hooks: [] }, cmd).error);
  assert.ok(planInstall({ hooks: { Stop: 'x' } }, cmd).error);
});
