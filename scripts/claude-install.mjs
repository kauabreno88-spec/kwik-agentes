#!/usr/bin/env node
// Liga o Claude Code ao painel, em cada conta:
//
//   npm run claude:install     marketplace "kwik" (esta pasta) + plugin kwik-agentes, em todas as contas
//   npm run claude:status      mostra, por conta, se o plugin está instalado e ligado
//   npm run claude:uninstall   tira o plugin e o marketplace de cada conta
//
// Tudo passa pelo próprio CLI do Claude Code (`claude plugin ...`), uma vez por conta, com CLAUDE_CONFIG_DIR
// apontando para a pasta dela (a conta padrão, ~/.claude, roda sem a variável). Nenhum arquivo do Claude Code é
// editado à mão. Contas: as mesmas do painel (~/.claude*, CLAUDE_CONFIG_DIR ou KWIK_CLAUDE_DIRS).
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectClaudeDirs } from '../server/accounts.mjs';
import { accountLabel } from '../server/accounts.mjs';
import { args, PKG, ping, ROOT, run, say, writeConfig } from './lib.mjs';

const CLAUDE = process.env.KWIK_CLAUDE_BIN || 'claude';
const MARKETPLACE = 'kwik';
const PLUGIN = 'kwik-agentes';
const ID = `${PLUGIN}@${MARKETPLACE}`;

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

function envFor(dir) {
  const env = { ...process.env };
  if (real(dir) === real(join(homedir(), '.claude'))) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

const claude = (dir, a) => run(CLAUDE, a, { env: envFor(dir) });

/** JSON no meio de uma saída que pode ter avisos antes. */
function parseJson(out) {
  const text = String(out ?? '').trim();
  const i = text.search(/^[[{]/m);
  if (i < 0) return undefined;
  try {
    return JSON.parse(text.slice(i));
  } catch {
    return undefined;
  }
}

function state(dir) {
  const plugins = parseJson(claude(dir, ['plugin', 'list', '--json']).out);
  const list = Array.isArray(plugins) ? plugins : Array.isArray(plugins?.installed) ? plugins.installed : [];
  const plugin = list.find((p) => p?.id === ID);
  const markets = parseJson(claude(dir, ['plugin', 'marketplace', 'list', '--json']).out);
  const market = Array.isArray(markets) ? markets.find((m) => m?.name === MARKETPLACE) : undefined;
  const marketPath = market && (market.path ?? (market.source === 'directory' ? market.installLocation : undefined));
  return { plugin, market, marketPath, parsed: Array.isArray(plugins) || Array.isArray(plugins?.installed) };
}

function claudeVersion() {
  const r = run(CLAUDE, ['--version'], { timeout: 20_000 });
  if (r.code !== 0) return undefined;
  return /(\d+\.\d+\.\d+)/.exec(r.out)?.[1] ?? 'desconhecida';
}

function step(dir, a, okMsg) {
  const r = claude(dir, a);
  if (r.code === 0) {
    say.ok(okMsg);
    return true;
  }
  say.err(`${okMsg.split(':')[0]}: falhou (claude ${a.join(' ')})`);
  const msg = (r.err || r.out).trim().split('\n').slice(-3).join(' ');
  if (msg) say.info(msg);
  return false;
}

function install(dir) {
  const s = state(dir);
  let ok = true;
  if (!s.market) ok = step(dir, ['plugin', 'marketplace', 'add', ROOT], `marketplace ${MARKETPLACE}: adicionado (${ROOT})`) && ok;
  else if (s.marketPath && real(s.marketPath) !== real(ROOT)) {
    ok = step(dir, ['plugin', 'marketplace', 'remove', MARKETPLACE], `marketplace ${MARKETPLACE}: tirado da pasta antiga`) && ok;
    ok = step(dir, ['plugin', 'marketplace', 'add', ROOT], `marketplace ${MARKETPLACE}: aponta para ${ROOT}`) && ok;
  } else ok = step(dir, ['plugin', 'marketplace', 'update', MARKETPLACE], `marketplace ${MARKETPLACE}: catálogo relido`) && ok;

  const after = state(dir);
  if (!after.plugin) ok = step(dir, ['plugin', 'install', ID, '--scope', 'user'], `${PLUGIN}: instalado`) && ok;
  else {
    if (after.plugin.enabled === false) ok = step(dir, ['plugin', 'enable', ID, '--scope', 'user'], `${PLUGIN}: religado`) && ok;
    if (after.plugin.version !== PKG.version) ok = step(dir, ['plugin', 'update', ID, '--scope', 'user'], `${PLUGIN}: atualizado para ${PKG.version}`) && ok;
    else say.ok(`${PLUGIN}: já instalado (${after.plugin.version})`);
  }
  return ok;
}

function uninstall(dir) {
  const s = state(dir);
  if (s.plugin) step(dir, ['plugin', 'uninstall', ID, '--scope', 'user'], `${PLUGIN}: removido`);
  else say.info(`${PLUGIN}: não estava instalado`);
  if (s.market) step(dir, ['plugin', 'marketplace', 'remove', MARKETPLACE], `marketplace ${MARKETPLACE}: removido`);
  else say.info(`marketplace ${MARKETPLACE}: não estava adicionado`);
}

function status(dir) {
  const s = state(dir);
  if (!s.parsed) {
    say.warn('não deu para ler `claude plugin list --json` (Claude Code antigo?): atualize o Claude Code');
    return false;
  }
  if (!s.market) say.err(`marketplace ${MARKETPLACE}: não adicionado`);
  else say.ok(`marketplace ${MARKETPLACE}: ${s.marketPath ?? 'adicionado'}`);
  if (!s.plugin) {
    say.err(`${PLUGIN}: não instalado (rode npm run claude:install)`);
    return false;
  }
  if (s.plugin.enabled === false) {
    say.err(`${PLUGIN}: instalado, mas desligado (rode npm run claude:install)`);
    return false;
  }
  say.ok(`${PLUGIN}: instalado e ligado (${s.plugin.version ?? '?'})`);
  for (const e of s.plugin.errors ?? []) say.warn(String(e));
  return true;
}

const { cmd } = args();
if (!['install', 'uninstall', 'status'].includes(cmd)) {
  say.plain('Uso: npm run claude:<install|status|uninstall>');
  process.exit(2);
}

const version = claudeVersion();
if (!version) {
  say.err(`Claude Code não encontrado (${CLAUDE}). Instale ou atualize: https://code.claude.com`);
  process.exit(1);
}
const dirs = detectClaudeDirs();
if (!dirs.length) {
  say.err('Nenhuma conta do Claude Code encontrada (~/.claude). Abra o Claude Code uma vez e rode de novo.');
  process.exit(1);
}

let allOk = true;
for (const dir of dirs) {
  say.title(`Claude Code ${version} · conta ${accountLabel('claude', dir)} ${say.dim(`(${dir})`)}`);
  if (cmd === 'install') allOk = install(dir) && allOk;
  else if (cmd === 'uninstall') uninstall(dir);
  else allOk = status(dir) && allOk;
}

if (cmd === 'install') {
  writeConfig();
  say.info('Sessões já abertas: rode /reload-plugins nelas (ou feche e abra de novo).');
}
if (cmd !== 'uninstall') {
  const h = await ping();
  if (h) say.ok(`Painel respondendo (versão ${h.version}). Último hook do Claude Code: ${h.hooks.claude ?? 'nenhum ainda'}`);
  else say.warn('O painel não respondeu agora (rode npm run docker:up). O plugin funciona assim que ele subir.');
}
process.exit(allOk ? 0 : 1);
