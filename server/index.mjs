#!/usr/bin/env node
// Servidor do KWIK Agentes. Node puro (22.12+), sem dependências.
//
//   npm start                      http://127.0.0.1:5945
//   KWIK_PORT=6000 npm start       outra porta
//
// Rotas:
//   GET  /api/health         situação: versão, contas lidas, hooks vistos, agentes
//   GET  /api/snapshot       retrato atual (agentes, feed, números do dia)
//   GET  /api/stream         SSE: evento "snapshot" a cada mudança, "ping" a cada 15 s
//   GET  /api/agents/:id     detalhe (linha do tempo e tarefas)
//   GET  /api/agents/:id/conversation   conversa recente (somente leitura)
//   GET  /api/day            "Meu dia": números de hoje por projeto
//   POST /api/events         hooks do Claude Code e do Codex ({provider, event})
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccounts } from './accounts.mjs';
import { hostAllowed, originAllowed } from './guard.mjs';
import { Office } from './office.mjs';
import { DEFAULT_PORT, rec, splitList } from './util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const PORT = Number.parseInt(process.env.KWIK_PORT ?? '', 10) || DEFAULT_PORT;
const HOST = process.env.KWIK_HOST || '127.0.0.1';
const IN_DOCKER = process.env.KWIK_IN_DOCKER === '1';
const ALLOWED_HOSTS = new Set(splitList(process.env.KWIK_ALLOWED_HOSTS).map((h) => h.toLowerCase()));
const MAX_BODY = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

const accounts = loadAccounts();
const office = new Office(accounts, { inDocker: IN_DOCKER, version: PKG.version });

// ------------------------------------------------------------------ borda

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...headers,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('corpo grande demais'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveFile(res, file, cache = 'no-cache') {
  let st;
  try {
    st = statSync(file);
  } catch {
    return send(res, 404, 'não encontrado');
  }
  if (!st.isFile()) return send(res, 404, 'não encontrado');
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + sep)) return send(res, 403, 'proibido');
  // Fontes da marca (Montserrat e Inter, licença OFL) vêm de public/fonts: nada sai do computador.
  return serveFile(res, file, pathname.startsWith('/fonts/') ? 'public, max-age=604800' : 'no-cache');
}

// ------------------------------------------------------------------ SSE

const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

let pending;
office.on('change', () => {
  if (pending) return;
  pending = setTimeout(() => {
    pending = undefined;
    broadcast('snapshot', office.snapshot());
  }, 250);
});

setInterval(() => broadcast('ping', { now: Date.now() }), 15_000).unref();

function stream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(`event: snapshot\ndata: ${JSON.stringify(office.snapshot())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

// ------------------------------------------------------------------ API

function health() {
  const agents = office.agents;
  return {
    ok: true,
    name: 'kwik-agentes',
    version: PKG.version,
    port: PORT,
    docker: IN_DOCKER,
    accounts: office.accountsInfo(),
    claude: office.accountsInfo().filter((a) => a.provider === 'claude').map((a) => a.label),
    codex: office.accountsInfo().filter((a) => a.provider === 'codex').map((a) => a.label),
    hooks: {
      claude: office.hookSeen.claude ? new Date(office.hookSeen.claude).toISOString() : null,
      codex: office.hookSeen.codex ? new Date(office.hookSeen.codex).toISOString() : null,
    },
    agents: {
      open: agents.length,
      working: agents.filter((a) => a.status === 'working' || a.status === 'shell').length,
      waiting: agents.filter((a) => a.status === 'waiting').length,
    },
  };
}

async function api(req, res, url) {
  const path = url.pathname;
  if (req.method === 'GET') {
    if (path === '/api/health') return send(res, 200, health());
    if (path === '/api/snapshot') return send(res, 200, office.snapshot());
    if (path === '/api/stream') return stream(req, res);
    if (path === '/api/day') return send(res, 200, office.dayDetail());
    const m = /^\/api\/agents\/([A-Za-z0-9_-]+)(\/conversation)?$/.exec(path);
    if (m) {
      const data = m[2] ? office.conversation(m[1]) : office.detail(m[1]);
      return data ? send(res, 200, data) : send(res, 404, { error: 'agente não encontrado' });
    }
    return send(res, 404, { error: 'rota não encontrada' });
  }
  if (req.method === 'POST' && path === '/api/events') {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'use application/json' });
    if (!originAllowed(req.headers.origin, ALLOWED_HOSTS)) return send(res, 403, { error: 'origem não permitida' });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'JSON inválido' });
    }
    const event = rec(body?.event);
    const ok = event ? office.applyHook(body.provider, event) : false;
    return send(res, ok ? 202 : 200, { ok });
  }
  return send(res, 405, { error: 'método não permitido' });
}

const server = createServer(async (req, res) => {
  try {
    if (!hostAllowed(req.headers.host, ALLOWED_HOSTS)) return send(res, 403, 'endereço não permitido (use localhost ou kwik.localhost)');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'método não permitido');
    return serveStatic(res, url.pathname);
  } catch (err) {
    if (!res.headersSent) send(res, 500, { error: String(err?.message ?? err) });
    else res.end();
  }
});

office.start();
server.listen(PORT, HOST, () => {
  const list = accounts.map((a) => `${a.provider === 'codex' ? 'Codex' : 'Claude Code'} (${a.label}: ${a.hostDir})`).join(', ') || 'nenhuma conta encontrada';
  console.log(`KWIK Agentes ${PKG.version} em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Contas: ${list}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    office.stop();
    for (const res of clients) res.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
