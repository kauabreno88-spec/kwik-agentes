#!/usr/bin/env node
// Sobe o KWIK Agentes no Docker:
//
//   npm run docker:up                 acha as contas, gera o docker-compose.override.yml e sobe o container
//   npm run docker:up -- --no-build   sobe sem reconstruir a imagem
//   npm run docker:down               para o container
//
// O override (fora do git) monta SOMENTE LEITURA, de cada conta do Claude Code, só <conta>/projects e
// <conta>/sessions; de cada pasta do Codex, só <pasta>/sessions. Nunca a pasta inteira: lá ficam credenciais.
// Pastas: as mesmas do servidor (~/.claude*, CLAUDE_CONFIG_DIR, ~/.codex*, CODEX_HOME) ou KWIK_CLAUDE_DIRS e
// KWIK_CODEX_DIRS (separadas por vírgula; no Windows com WSL: /mnt/c/Users/<você>/.claude, por exemplo).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAccounts } from '../server/accounts.mjs';
import { args, PKG, PORT, ping, ROOT, run, say, writeConfig } from './lib.mjs';

const { flags } = args();
const compose = (extra) => run('docker', ['compose', ...extra], { cwd: ROOT, stdio: 'inherit', timeout: 15 * 60_000 });

if (flags.has('--help') || flags.has('-h')) {
  say.plain('Uso: npm run docker:up [-- --no-build]  |  npm run docker:down');
  process.exit(0);
}

if (run('docker', ['info'], { timeout: 20_000 }).code !== 0) {
  say.err('O Docker não está respondendo. Abra o Docker Desktop (ou inicie o serviço docker) e rode de novo.');
  process.exit(1);
}

if (flags.has('--down')) {
  say.title('Parando o KWIK Agentes');
  process.exit(compose(['down']).code);
}

say.title(`KWIK Agentes ${PKG.version} no Docker`);

// Tirar o KWIK_ACCOUNTS do ambiente: aqui a descoberta é sempre no computador.
const env = { ...process.env };
delete env.KWIK_ACCOUNTS;
const accounts = loadAccounts({ env });
if (!accounts.length) {
  say.err('Nenhuma pasta do Claude Code (~/.claude) nem do Codex (~/.codex) foi encontrada.');
  say.info('Abra o Claude Code ou o Codex uma vez, ou aponte as pastas com KWIK_CLAUDE_DIRS / KWIK_CODEX_DIRS.');
  process.exit(1);
}

const q = (s) => JSON.stringify(String(s)).replace(/\$/g, "$$$$"); // $ vira $$ (o Compose interpola $)
const mounts = [];
const inContainer = [];
for (const a of accounts) {
  const target = `/${a.provider}/${a.id}`;
  const subdirs = a.provider === 'claude' ? ['projects', 'sessions'] : ['sessions'];
  for (const sub of subdirs) {
    const src = join(a.dir, sub);
    // A pasta precisa existir para virar montagem (vazia, ela não muda nada para o agente).
    if (!existsSync(src)) mkdirSync(src, { recursive: true, mode: 0o700 });
    mounts.push({ source: src, target: `${target}/${sub}` });
  }
  inContainer.push({ provider: a.provider, id: a.id, label: a.label, dir: target, hostDir: a.dir });
  say.ok(`${a.provider === 'codex' ? 'Codex' : 'Claude Code'} · ${a.label} ${say.dim(`(${a.dir})`)}`);
}

let tz = process.env.TZ;
try {
  tz ||= Intl.DateTimeFormat().resolvedOptions().timeZone;
} catch {
  tz ||= 'America/Sao_Paulo';
}

const lines = [
  '# Gerado por `npm run docker:up`. Não edite: ele é refeito a cada execução (e fica fora do git).',
  'services:',
  '  kwik:',
];
// No Linux, o container roda com o seu usuário, para conseguir ler os arquivos (que só você lê).
if (process.platform === 'linux' && typeof process.getuid === 'function') lines.push(`    user: ${q(`${process.getuid()}:${process.getgid()}`)}`);
lines.push('    environment:');
lines.push(`      KWIK_ACCOUNTS: ${q(JSON.stringify(inContainer))}`);
lines.push(`      TZ: ${q(tz)}`);
lines.push('    volumes:');
for (const m of mounts) {
  lines.push('      - type: bind');
  lines.push(`        source: ${q(m.source)}`);
  lines.push(`        target: ${q(m.target)}`);
  lines.push('        read_only: true');
}
writeFileSync(join(ROOT, 'docker-compose.override.yml'), `${lines.join('\n')}\n`);
say.ok('docker-compose.override.yml gerado (montagens somente leitura)');
writeConfig(PORT);

const up = ['up', '-d', '--remove-orphans'];
if (!flags.has('--no-build')) up.push('--build');
const res = compose(up);
if (res.code !== 0) {
  say.err('O docker compose falhou. Veja a mensagem acima (e o README, em "Solução de problemas").');
  process.exit(res.code);
}

say.info('Esperando o painel responder…');
let health;
for (let i = 0; i < 40 && !health; i++) {
  health = await ping(PORT);
  if (!health) await new Promise((r) => setTimeout(r, 1_000));
}
if (!health) {
  say.err(`O container subiu, mas http://localhost:${PORT}/api/health não respondeu. Veja: npm run docker:logs`);
  process.exit(1);
}
say.ok(`No ar: http://localhost:${PORT}  (com o portless: https://kwik.localhost)`);
say.ok(`${health.accounts.length} conta(s) lida(s), ${health.agents.open} agente(s) aberto(s) agora`);
say.info('O container reinicia sozinho junto com o Docker.');
