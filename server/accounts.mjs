// Descoberta das contas: cada pasta do Claude Code (~/.claude, ~/.claude-*, CLAUDE_CONFIG_DIR) e cada pasta do
// Codex (~/.codex, ~/.codex-*, CODEX_HOME). Usado pelo servidor (fora do Docker) e pelos scripts no computador.
//
// Privacidade: daqui só saem caminhos e nomes de pasta. Credenciais (auth.json, .credentials.json, .claude.json)
// nunca são lidas.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { expandHome, splitList } from './util.mjs';

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Pasta do Codex: tem sessions/ junto de config.toml, auth.json ou hooks.json (ou se chama .codex*). */
export function isCodexHome(dir) {
  if (!isDir(dir)) return false;
  if (basename(dir).startsWith('.codex')) return true;
  return isDir(join(dir, 'sessions')) && ['config.toml', 'auth.json', 'hooks.json'].some((f) => existsSync(join(dir, f)));
}

/** Pasta do Claude Code: tem projects/ ou sessions/ e não é do Codex. */
export function isClaudeHome(dir) {
  if (!isDir(dir) || isCodexHome(dir)) return false;
  return isDir(join(dir, 'projects')) || isDir(join(dir, 'sessions'));
}

function uniqueDirs(list) {
  const seen = new Set();
  const out = [];
  for (const d of list) {
    const key = real(d);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

function homeCandidates(home, prefix) {
  let names = [];
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  return names
    .filter((n) => n === prefix || n.startsWith(`${prefix}-`) || n.startsWith(`${prefix}_`) || n.startsWith(`${prefix}.`))
    .filter((n) => !n.endsWith('.json') && !n.includes('backup'))
    .sort()
    .map((n) => join(home, n));
}

/** Pastas do Claude Code. KWIK_CLAUDE_DIRS (separadas por vírgula) substitui a descoberta. */
export function detectClaudeDirs({ env = process.env, home = homedir() } = {}) {
  if (env.KWIK_CLAUDE_DIRS) return uniqueDirs(splitList(env.KWIK_CLAUDE_DIRS).map((d) => expandHome(d, home)));
  const list = [];
  if (env.CLAUDE_CONFIG_DIR) list.push(expandHome(env.CLAUDE_CONFIG_DIR, home));
  list.push(join(home, '.claude'));
  list.push(...homeCandidates(home, '.claude'));
  return uniqueDirs(list.filter(isClaudeHome));
}

/** Pastas do Codex. KWIK_CODEX_DIRS (separadas por vírgula) substitui a descoberta. */
export function detectCodexDirs({ env = process.env, home = homedir() } = {}) {
  if (env.KWIK_CODEX_DIRS) return uniqueDirs(splitList(env.KWIK_CODEX_DIRS).map((d) => expandHome(d, home)));
  const list = [];
  if (env.CODEX_HOME) list.push(expandHome(env.CODEX_HOME, home));
  list.push(join(home, '.codex'));
  list.push(...homeCandidates(home, '.codex'));
  return uniqueDirs(list.filter((d) => isDir(d) && isCodexHome(d)));
}

/** Id curto e estável da conta: ".claude-trabalho" -> "claude-trabalho". */
export function accountId(dir) {
  return basename(dir).replace(/^\./, '').replace(/[^a-zA-Z0-9_-]/g, '-') || 'conta';
}

/** Nome para mostrar: a pasta padrão vira "Principal"; ".claude-trabalho" vira "trabalho". */
export function accountLabel(provider, dir) {
  const base = basename(dir).replace(/^\./, '');
  const root = provider === 'codex' ? 'codex' : 'claude';
  if (base === root) return 'Principal';
  const rest = base.startsWith(root) ? base.slice(root.length).replace(/^[-_.]+/, '') : base;
  return rest || 'Principal';
}

/**
 * Lista de contas para o servidor: KWIK_ACCOUNTS (JSON gravado pelo docker:up, com as pastas montadas no container)
 * ou a descoberta direta no computador.
 */
export function loadAccounts({ env = process.env, home = homedir() } = {}) {
  if (env.KWIK_ACCOUNTS) {
    try {
      const list = JSON.parse(env.KWIK_ACCOUNTS);
      if (Array.isArray(list)) {
        return list
          .filter((a) => a && (a.provider === 'claude' || a.provider === 'codex') && typeof a.dir === 'string')
          .map((a) => ({
            provider: a.provider,
            id: String(a.id || accountId(a.dir)),
            label: String(a.label || accountLabel(a.provider, a.hostDir || a.dir)),
            dir: a.dir,
            hostDir: typeof a.hostDir === 'string' ? a.hostDir : a.dir,
          }));
      }
    } catch {
      // JSON inválido: cai na descoberta
    }
  }
  const out = [];
  const used = new Set();
  const add = (provider, dir) => {
    let id = accountId(dir);
    for (let i = 2; used.has(`${provider}:${id}`); i++) id = `${accountId(dir)}-${i}`;
    used.add(`${provider}:${id}`);
    out.push({ provider, id, label: accountLabel(provider, dir), dir, hostDir: dir });
  };
  for (const d of detectClaudeDirs({ env, home })) add('claude', d);
  for (const d of detectCodexDirs({ env, home })) add('codex', d);
  return out;
}
