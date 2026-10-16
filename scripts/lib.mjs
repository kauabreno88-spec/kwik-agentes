// Ajudantes dos scripts (rodam no computador, não no container).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KWIK_HOME, resolvePort } from '../server/util.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint('38;2;40;190;82');
const red = paint('38;2;214;69;58');
const amber = paint('38;2;232;163;23');
const dim = paint('2');
const bold = paint('1');

export const say = {
  title: (s) => console.log(`\n${green('▮▮▮')} ${bold(s)}`),
  ok: (s) => console.log(`  ${green('✓')} ${s}`),
  warn: (s) => console.log(`  ${amber('!')} ${s}`),
  err: (s) => console.log(`  ${red('✗')} ${s}`),
  info: (s) => console.log(`  ${dim('·')} ${s}`),
  plain: (s) => console.log(s),
  green,
  dim,
  bold,
};

/** Roda um comando e devolve {code, out, err}. Nunca lança. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  return { code: r.status ?? (r.error ? 127 : 1), out: r.stdout ?? '', err: (r.stderr ?? '') + (r.error ? String(r.error.message) : '') };
}

export const PORT = resolvePort();

/** Grava a porta em ~/.kwik/config.json (o hook lê dali, porque o ambiente dele nem sempre tem KWIK_PORT). */
export function writeConfig(port = PORT) {
  const dir = KWIK_HOME();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'config.json');
  let cur = {};
  try {
    cur = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    cur = {};
  }
  writeFileSync(file, `${JSON.stringify({ ...cur, port }, null, 2)}\n`);
  return file;
}

/** /api/health do painel, ou undefined se não responder. */
export async function ping(port = PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

export function backupName(file) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${file}.kwik-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function args() {
  const a = process.argv.slice(2);
  const flags = new Set(a.filter((x) => x.startsWith('--')));
  const pos = a.filter((x) => !x.startsWith('--'));
  return { cmd: pos[0], flags, pos };
}
