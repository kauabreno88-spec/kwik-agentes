#!/usr/bin/env node
// Hook do KWIK Agentes, usado pelo Claude Code (plugin kwik-agentes) e pelo Codex (hooks.json):
//
//   node ".../plugin/kwik/hooks/hook.mjs" claude
//   node ".../plugin/kwik/hooks/hook.mjs" codex
//
// Lê o evento do stdin e manda para o painel (POST http://127.0.0.1:<porta>/api/events) com prazo curto.
// Serve só para o painel saber NA HORA que algo mudou (e quando o agente precisa de você).
//
// Regras: Node puro, sem dependências; nunca atrasa nem quebra a sessão. Qualquer erro = sai com 0 e sem imprimir
// nada (no SessionStart e no UserPromptSubmit, o que sai no stdout vira contexto do modelo). Só fala com 127.0.0.1.
// Porta: KWIK_PORT, depois ~/.kwik/config.json ({"port": 5945}), depois 5945.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const provider = process.argv[2] === 'codex' ? 'codex' : 'claude';
const MAX_STDIN = 4 * 1024 * 1024;
const MAX_STRING = 2_000;

function port() {
  const fromEnv = Number.parseInt(process.env.KWIK_PORT ?? '', 10);
  if (fromEnv > 0 && fromEnv < 65536) return fromEnv;
  try {
    const cfg = JSON.parse(readFileSync(join(process.env.KWIK_HOME || join(homedir(), '.kwik'), 'config.json'), 'utf8'));
    const p = Number.parseInt(String(cfg.port ?? ''), 10);
    if (p > 0 && p < 65536) return p;
  } catch {
    // sem config: padrão
  }
  return 5945;
}

function readStdin() {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(done, 3_000);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size <= MAX_STDIN) chunks.push(c);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      done();
    });
  });
}

/** Corta textos longos: o painel só mostra prévias (e nada de conteúdo grande sai daqui). */
function trim(v, depth = 0) {
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  if (Array.isArray(v)) return depth > 3 ? [] : v.slice(0, 20).map((x) => trim(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 3) return {};
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 40)) out[k] = trim(x, depth + 1);
    return out;
  }
  return v;
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (!input || typeof input !== 'object') return;
  const event = {
    hook_event_name: input.hook_event_name,
    session_id: input.session_id,
    cwd: input.cwd,
    transcript_path: input.transcript_path,
    tool_name: input.tool_name,
    tool_input: trim(input.tool_input),
    notification_type: input.notification_type,
    message: trim(input.message),
  };
  await fetch(`http://127.0.0.1:${port()}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, event }),
    signal: AbortSignal.timeout(event.hook_event_name === 'SessionEnd' ? 500 : 1_200),
  }).catch(() => {});
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
