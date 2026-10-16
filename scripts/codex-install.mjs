#!/usr/bin/env node
// Liga o Codex ao painel, em cada pasta do Codex (CODEX_HOME, ~/.codex*, ou KWIK_CODEX_DIRS):
//
//   npm run codex:install     acrescenta os hooks da KWIK em <pasta>/hooks.json (backup antes; os outros ficam)
//   npm run codex:status      mostra se os hooks estão lá e se o painel recebeu algum
//   npm run codex:uninstall   tira só os hooks da KWIK
//
// O Codex só roda um hook novo depois que você o aprova, dentro dele, em /hooks. Este script NUNCA grava essa
// aprovação nem mexe no config.toml. Para não mudar de posição o que já existe (o Codex guarda a aprovação pela
// posição), o grupo da KWIK entra sempre no FIM da lista de cada evento e, ao atualizar, é trocado no mesmo lugar.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accountLabel, detectCodexDirs } from '../server/accounts.mjs';
import { args, backupName, ping, ROOT, run, say, writeConfig } from './lib.mjs';

export const HOOK = join(ROOT, 'plugin', 'kwik', 'hooks', 'hook.mjs');
const MARK = /plugin[\\/]+kwik[\\/]+hooks[\\/]+hook\.mjs/;
export const OBSERVE = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
export const EVENTS = [...OBSERVE, 'PermissionRequest', 'SessionEnd'];

function nodeBin() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 22) return process.execPath;
  const r = run('node', ['-p', 'process.execPath + " " + process.versions.node']);
  return r.code === 0 ? r.out.trim().split(' ')[0] : 'node';
}

export function commandFor(node = nodeBin()) {
  return `"${node}" "${HOOK}" codex`;
}

export function handlerFor(event, command) {
  if (event === 'SessionEnd') return { type: 'command', command, timeout: 1 };
  if (event === 'PermissionRequest') return { type: 'command', command, timeout: 5 };
  return { type: 'command', command, async: true, timeout: 5 };
}

const isOurs = (h) => typeof h?.command === 'string' && MARK.test(h.command);

/** Aplica os hooks da KWIK num hooks.json já lido. Devolve {data, changed, error}. */
export function planInstall(data, command) {
  const out = data && typeof data === 'object' && !Array.isArray(data) ? structuredClone(data) : {};
  if (out.hooks === undefined) out.hooks = {};
  if (!out.hooks || typeof out.hooks !== 'object' || Array.isArray(out.hooks)) return { error: '"hooks" em formato desconhecido; nada foi alterado' };
  let changed = false;
  for (const ev of EVENTS) {
    const want = handlerFor(ev, command);
    if (out.hooks[ev] !== undefined && !Array.isArray(out.hooks[ev])) return { error: `"hooks.${ev}" em formato desconhecido; nada foi alterado` };
    const list = out.hooks[ev] ?? [];
    let found = false;
    for (const g of list) {
      if (!Array.isArray(g?.hooks)) continue;
      for (let i = 0; i < g.hooks.length; i++) {
        if (!isOurs(g.hooks[i])) continue;
        found = true;
        if (JSON.stringify(g.hooks[i]) !== JSON.stringify(want)) {
          g.hooks[i] = want;
          changed = true;
        }
      }
    }
    if (!found) {
      list.push({ hooks: [want] });
      changed = true;
    }
    out.hooks[ev] = list;
  }
  return { data: out, changed };
}

export function planUninstall(data) {
  if (!data?.hooks || typeof data.hooks !== 'object') return { data, changed: false };
  const out = structuredClone(data);
  let changed = false;
  for (const [ev, list] of Object.entries(out.hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = [];
    for (const g of list) {
      if (!Array.isArray(g?.hooks)) {
        kept.push(g);
        continue;
      }
      const hs = g.hooks.filter((h) => !isOurs(h));
      if (hs.length !== g.hooks.length) changed = true;
      if (hs.length) kept.push({ ...g, hooks: hs });
    }
    if (kept.length) out.hooks[ev] = kept;
    else delete out.hooks[ev];
  }
  return { data: out, changed };
}

function read(file) {
  if (!existsSync(file)) return { data: undefined };
  try {
    return { data: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { error: `hooks.json inválido (${err.message}); nada foi alterado` };
  }
}

function write(file, data) {
  if (existsSync(file)) copyFileSync(file, backupName(file));
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function installed(data) {
  return EVENTS.filter((ev) => (data?.hooks?.[ev] ?? []).some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOurs)));
}

async function main() {
  const { cmd } = args();
  if (!['install', 'uninstall', 'status'].includes(cmd)) {
    say.plain('Uso: npm run codex:<install|status|uninstall>');
    return 2;
  }

  const dirs = detectCodexDirs();
  if (!dirs.length) {
    say.err('Nenhuma pasta do Codex encontrada (~/.codex). Abra o Codex uma vez e rode de novo.');
    return 1;
  }

  let allOk = true;
  const command = commandFor();
  for (const dir of dirs) {
    const file = join(dir, 'hooks.json');
    say.title(`Codex · ${accountLabel('codex', dir)} ${say.dim(`(${file})`)}`);
    const cur = read(file);
    if (cur.error) {
      say.err(cur.error);
      allOk = false;
      continue;
    }
    if (cmd === 'install') {
      const plan = planInstall(cur.data, command);
      if (plan.error) {
        say.err(plan.error);
        allOk = false;
        continue;
      }
      if (plan.changed) {
        const existed = existsSync(file);
        write(file, plan.data);
        say.ok(`hooks da KWIK em ${EVENTS.length} eventos ${existed ? say.dim('(backup do anterior ao lado)') : ''}`);
      } else say.ok('hooks da KWIK já estavam lá');
      say.info(`comando: ${command}`);
    } else if (cmd === 'uninstall') {
      const plan = planUninstall(cur.data);
      if (plan.changed) {
        write(file, plan.data);
        say.ok('hooks da KWIK removidos (os outros ficaram)');
      } else say.info('não havia hooks da KWIK');
    } else {
      const have = installed(cur.data);
      if (have.length === EVENTS.length) say.ok(`hooks da KWIK em todos os ${EVENTS.length} eventos`);
      else if (have.length) {
        say.warn(`hooks da KWIK em ${have.length} de ${EVENTS.length} eventos (rode npm run codex:install)`);
        allOk = false;
      } else {
        say.err('sem hooks da KWIK (rode npm run codex:install)');
        allOk = false;
      }
    }
  }

  if (cmd === 'install') {
    writeConfig();
    say.plain('');
    say.warn('Falta uma coisa que só você pode fazer: abra o Codex, digite /hooks e aprove os hooks da KWIK.');
  }
  if (cmd !== 'uninstall') {
    const h = await ping();
    if (h) say.ok(`Painel respondendo (versão ${h.version}). Último hook do Codex: ${h.hooks.codex ?? 'nenhum ainda (aprove em /hooks e mande uma mensagem)'}`);
    else say.warn('O painel não respondeu agora (rode npm run docker:up).');
  }
  return allOk ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main());
