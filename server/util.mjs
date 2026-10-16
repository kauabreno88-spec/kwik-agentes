// Utilitários pequenos, sem dependências. Usados pelo servidor e pelos scripts.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_PORT = 5945; // K-W-I-K no teclado do telefone

/** Objeto simples (não array, não null). */
export const rec = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
export const str = (v) => (typeof v === 'string' && v.trim() ? v : undefined);
export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

export function truncate(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export function firstLine(text) {
  return String(text ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
}

/** Esconde chaves e senhas óbvias antes de mostrar um comando ou texto no painel. */
export function maskSecrets(text) {
  return String(text ?? '')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, '••••')
    .replace(/((?:password|passwd|senha|secret|token|api[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1••••')
    .replace(/(Authorization:\s*(?:Bearer|Basic)\s+)\S+/gi, '$1••••');
}

/** Expande ~, $HOME e ${HOME} e devolve o caminho absoluto, sem barra no fim. */
export function expandHome(p, home = homedir()) {
  const out = resolve(String(p).trim().replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME\b/g, home));
  return out.length > 1 ? out.replace(/\/+$/, '') : out;
}

export function splitList(v) {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pasta de configuração local da KWIK (porta lida pelos hooks). */
export const KWIK_HOME = () => process.env.KWIK_HOME || join(homedir(), '.kwik');

/** Porta do painel: KWIK_PORT, depois ~/.kwik/config.json, depois 5945. */
export function resolvePort(env = process.env) {
  const fromEnv = Number.parseInt(env.KWIK_PORT ?? '', 10);
  if (fromEnv > 0 && fromEnv < 65536) return fromEnv;
  try {
    const cfg = JSON.parse(readFileSync(join(KWIK_HOME(), 'config.json'), 'utf8'));
    const p = Number.parseInt(String(cfg.port ?? ''), 10);
    if (p > 0 && p < 65536) return p;
  } catch {
    // sem arquivo: vale o padrão
  }
  return DEFAULT_PORT;
}

/** Início do dia local (meia-noite) do instante dado. */
export function startOfDay(ms = Date.now()) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Data local AAAA-MM-DD. */
export function dayKey(ms = Date.now()) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Nome do projeto a partir da pasta (último pedaço do caminho). */
export function projectName(cwd) {
  const parts = String(cwd ?? '').split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? (cwd || 'sem projeto');
}

/** Pasta do projeto como o Claude Code grava em projects/: todo caractere fora de [a-zA-Z0-9] vira "-". */
export function encodeCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}
