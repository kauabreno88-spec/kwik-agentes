import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { accountLabel, detectClaudeDirs, detectCodexDirs, loadAccounts } from '../server/accounts.mjs';
import { hostAllowed, originAllowed } from '../server/guard.mjs';
import { JsonlReader } from '../server/jsonl.mjs';
import { Office } from '../server/office.mjs';
import { encodeCwd } from '../server/util.mjs';

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'kwik-'));
  const cwd = '/home/ana/site-kwik';
  const claude = join(home, '.claude');
  mkdirSync(join(claude, 'projects', encodeCwd(cwd)), { recursive: true });
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  mkdirSync(join(home, '.claude-trabalho', 'projects'), { recursive: true });
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const day = join(home, '.codex', 'sessions', String(now.getFullYear()), p(now.getMonth() + 1), p(now.getDate()));
  mkdirSync(day, { recursive: true });
  return { home, cwd, claude, codexDay: day };
}

const line = (o) => `${JSON.stringify(o)}\n`;

test('descoberta das contas', () => {
  const { home } = fakeHome();
  const env = {};
  assert.deepEqual(detectClaudeDirs({ env, home }), [join(home, '.claude'), join(home, '.claude-trabalho')]);
  assert.deepEqual(detectCodexDirs({ env, home }), [join(home, '.codex')]);
  assert.deepEqual(detectClaudeDirs({ env: { KWIK_CLAUDE_DIRS: '~/.claude-trabalho' }, home }), [join(home, '.claude-trabalho')]);
  assert.equal(accountLabel('claude', '/x/.claude'), 'Principal');
  assert.equal(accountLabel('claude', '/x/.claude-trabalho'), 'trabalho');
  const fromDocker = loadAccounts({ env: { KWIK_ACCOUNTS: JSON.stringify([{ provider: 'codex', id: 'codex', dir: '/codex/codex', hostDir: '/Users/a/.codex' }]) }, home });
  assert.deepEqual(fromDocker, [{ provider: 'codex', id: 'codex', label: 'Principal', dir: '/codex/codex', hostDir: '/Users/a/.codex' }]);
});

test('escritório: registro + transcript, hook de permissão e Codex', () => {
  const { home, cwd, claude, codexDay } = fakeHome();
  const sid = '11111111-2222-3333-4444-555555555555';
  const transcript = join(claude, 'projects', encodeCwd(cwd), `${sid}.jsonl`);
  const ts = () => new Date().toISOString();
  writeFileSync(transcript, line({ type: 'user', cwd, gitBranch: 'main', timestamp: ts(), message: { content: 'Monta a landing do split payment' } }));
  writeFileSync(join(claude, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, cwd, status: 'busy', version: '2.1.301' }));
  const tid = '0199a213-81c0-7800-8aa1-bbab2a035a53';
  writeFileSync(
    join(codexDay, `rollout-2026-10-16T12-00-00-${tid}.jsonl`),
    line({ type: 'session_meta', timestamp: ts(), payload: { id: tid, cwd } }) + line({ type: 'event_msg', timestamp: ts(), payload: { type: 'task_started' } }) + line({ type: 'event_msg', timestamp: ts(), payload: { type: 'user_message', message: 'Revisa os textos' } }),
  );

  const office = new Office(loadAccounts({ env: {}, home }), { version: 't' });
  office.tick();
  const snap = office.snapshot();
  assert.equal(snap.agents.length, 2);
  const cc = snap.agents.find((a) => a.provider === 'claude');
  const cx = snap.agents.find((a) => a.provider === 'codex');
  assert.equal(cc.status, 'working');
  assert.equal(cc.title, 'Monta a landing do split payment');
  assert.equal(cc.project, 'site-kwik');
  assert.equal(cx.status, 'working');
  assert.equal(cx.project, 'site-kwik');
  assert.equal(snap.today.prompts, 2);

  // Hook do Codex: pedido de permissão -> precisa de você.
  assert.equal(office.applyHook('codex', { hook_event_name: 'PermissionRequest', session_id: tid, tool_name: 'shell', tool_input: { command: 'npm publish' } }), true);
  office.tick();
  const waiting = office.snapshot().agents.find((a) => a.provider === 'codex');
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.waitingFor, 'aprovar o comando npm publish');
  assert.ok(office.feed.some((f) => f.kind === 'wait'));

  // Registro diz "waiting": vale mesmo sem hook.
  writeFileSync(join(claude, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, cwd, status: 'waiting', waitingFor: 'permission' }));
  office.tick();
  assert.equal(office.snapshot().agents.find((a) => a.provider === 'claude').waitingFor, 'aprovar uma permissão');

  // Algo novo no rollout depois do hook: deixa de esperar.
  appendFileSync(join(codexDay, `rollout-2026-10-16T12-00-00-${tid}.jsonl`), line({ type: 'event_msg', timestamp: new Date(Date.now() + 2000).toISOString(), payload: { type: 'task_complete' } }));
  office.tick();
  assert.equal(office.snapshot().agents.find((a) => a.provider === 'codex').status, 'idle');

  // Fim da sessão no hook: some na hora.
  office.applyHook('codex', { hook_event_name: 'SessionEnd', session_id: tid });
  office.tick();
  assert.equal(office.snapshot().agents.filter((a) => a.provider === 'codex').length, 0);

  const day = office.dayDetail();
  assert.equal(day.projectsDetail[0].project, 'site-kwik');
  assert.deepEqual(day.projectsDetail[0].providers.sort(), ['claude', 'codex']);
  assert.ok(office.detail(cc.id).activities.length >= 1);
  assert.equal(office.conversation(cc.id).messages[0].role, 'user');
  office.stop();
});

test('leitura incremental: linha cortada e acento dividido entre leituras', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kwik-jsonl-'));
  const f = join(dir, 'a.jsonl');
  const full = Buffer.from(line({ t: 'ação' }));
  const cut = full.indexOf(Buffer.from('ç')) + 1; // no meio do "ç" (2 bytes)
  writeFileSync(f, full.subarray(0, cut));
  const r = new JsonlReader(f);
  assert.deepEqual(r.read().lines, []);
  appendFileSync(f, full.subarray(cut));
  assert.deepEqual(r.read().lines, [{ t: 'ação' }]);
});

test('borda: só endereços locais', () => {
  assert.equal(hostAllowed('kwik.localhost'), true);
  assert.equal(hostAllowed('localhost:5945'), true);
  assert.equal(hostAllowed('127.0.0.1:5945'), true);
  assert.equal(hostAllowed('[::1]:5945'), true);
  assert.equal(hostAllowed('evil.example.com'), false);
  assert.equal(hostAllowed('meu-mac.local', new Set(['meu-mac.local'])), true);
  assert.equal(originAllowed(undefined), true);
  assert.equal(originAllowed('https://kwik.localhost'), true);
  assert.equal(originAllowed('https://evil.example.com'), false);
});
