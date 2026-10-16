// Traduz uma chamada de ferramenta (do Claude Code ou do Codex) numa frase curta, no tom da KWIK:
// direta e sem sigla sem explicação. `kind` é a categoria mostrada como etiqueta no painel.
import { basename } from 'node:path';
import { firstLine, maskSecrets, rec, str, truncate } from './util.mjs';

/** Categorias (etiquetas do painel). */
export const KINDS = {
  read: 'Leitura',
  edit: 'Edição',
  terminal: 'Terminal',
  test: 'Testes',
  search: 'Busca',
  web: 'Pesquisa',
  agent: 'Subagente',
  plan: 'Plano',
  question: 'Pergunta',
  tool: 'Ferramenta',
  prompt: 'Pedido',
  reply: 'Resposta',
  done: 'Concluído',
  error: 'Erro',
  wait: 'Aguardando',
};

const file = (p) => (str(p) ? basename(String(p)) : 'um arquivo');
/** Comando que roda testes (só a primeira linha conta; "test" solto no meio de um script não vale). */
const TEST_CMD = /(^|[\s;&|(])(vitest|jest|pytest|mocha|phpunit|rspec)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnpm t\b|\b(go|cargo|deno|bun) test\b|\bnode --test\b|\bplaywright test\b/i;

function shell(cmd, desc) {
  const command = maskSecrets(Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? ''));
  const clean = command.replace(/^(bash|sh|zsh)\s+-l?c\s+/, '').replace(/^["']|["']$/g, '');
  if (TEST_CMD.test(firstLine(clean))) return { kind: 'test', text: `Rodando testes: ${truncate(desc || firstLine(clean), 70)}` };
  if (desc) return { kind: 'terminal', text: truncate(desc, 80) };
  return { kind: 'terminal', text: `Rodando: ${truncate(firstLine(clean), 70)}` };
}

/** Descreve a ferramenta `name` chamada com `input`. */
export function describeTool(name, input) {
  const i = rec(input) ?? {};
  switch (name) {
    case 'Read':
    case 'NotebookRead':
    case 'view_image':
      return { kind: 'read', text: `Lendo ${file(i.file_path ?? i.notebook_path ?? i.path)}` };
    case 'Write':
      return { kind: 'edit', text: `Criando ${file(i.file_path)}` };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { kind: 'edit', text: `Editando ${file(i.file_path ?? i.notebook_path)}` };
    case 'apply_patch': {
      const patch = String(i.input ?? i.patch ?? '');
      const files = [...patch.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((m) => basename(m[1].trim()));
      if (files.length === 1) return { kind: 'edit', text: `Editando ${files[0]}` };
      if (files.length > 1) return { kind: 'edit', text: `Editando ${files.length} arquivos` };
      return { kind: 'edit', text: 'Editando arquivos' };
    }
    case 'Bash':
    case 'BashOutput':
    case 'shell':
    case 'shell_command':
    case 'local_shell':
    case 'exec_command':
    case 'container.exec':
      return shell(i.command ?? i.cmd, str(i.description));
    case 'KillShell':
    case 'KillBash':
    case 'TaskStop':
      return { kind: 'terminal', text: 'Parando um comando' };
    case 'Grep':
      return { kind: 'search', text: `Procurando "${truncate(i.pattern, 40)}"` };
    case 'Glob':
      return { kind: 'search', text: `Procurando arquivos ${truncate(i.pattern, 40)}` };
    case 'LS':
      return { kind: 'search', text: `Olhando a pasta ${file(i.path)}` };
    case 'WebSearch':
    case 'web_search':
    case 'web_search_preview':
      return { kind: 'web', text: `Pesquisando "${truncate(i.query ?? i.q ?? '', 50)}"` };
    case 'WebFetch': {
      let host = '';
      try {
        host = new URL(String(i.url)).hostname;
      } catch {
        host = truncate(i.url, 40);
      }
      return { kind: 'web', text: `Lendo a página ${host}` };
    }
    case 'Task':
    case 'Agent':
    case 'spawn_agent':
      return { kind: 'agent', text: `Chamou um subagente: ${truncate(i.description ?? i.prompt ?? i.message ?? '', 60)}` };
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'update_plan':
      return { kind: 'plan', text: 'Atualizando a lista de tarefas' };
    case 'ExitPlanMode':
      return { kind: 'plan', text: 'Apresentou um plano' };
    case 'AskUserQuestion':
    case 'request_user_input':
      return { kind: 'question', text: 'Fez uma pergunta para você' };
    case 'Skill':
      return { kind: 'tool', text: `Usando a skill ${truncate(i.skill ?? i.name ?? '', 40)}` };
    default: {
      const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(String(name));
      if (mcp) return { kind: 'tool', text: `Usando ${mcp[1].replace(/_/g, ' ')}: ${mcp[2].replace(/_/g, ' ')}` };
      return { kind: 'tool', text: `Usando ${truncate(name || 'uma ferramenta', 40)}` };
    }
  }
}

/** O que o agente espera de você, a partir do texto cru do Claude Code ou do Codex. */
export function describeWaitingFor(raw) {
  if (!raw) return 'responder no terminal';
  const r = String(raw).toLowerCase();
  if (r === 'input needed' || /question|pergunta|elicitation/.test(r)) return 'responder uma pergunta';
  if (/permission|approve|allow|aprova/.test(r)) return 'aprovar uma permissão';
  if (/trust/.test(r)) return 'confiar nesta pasta';
  if (r === 'dialog open') return 'fechar um diálogo aberto';
  if (/sandbox/.test(r)) return 'liberar o acesso do sandbox';
  return truncate(raw, 48);
}

/** O que um pedido de permissão quer aprovar, em uma frase curta ("aprovar o comando npm test"). */
export function describePermission(name, input) {
  const i = rec(input) ?? {};
  const d = describeTool(name, input);
  if (d.kind === 'terminal' || d.kind === 'test') {
    const cmd = maskSecrets(Array.isArray(i.command) ? i.command.join(' ') : String(i.command ?? i.cmd ?? ''));
    return cmd ? `aprovar o comando ${truncate(firstLine(cmd), 70)}` : 'aprovar um comando';
  }
  if (d.kind === 'edit') return `aprovar: ${d.text.toLowerCase().startsWith('criando') ? 'criar' : 'editar'} ${d.text.replace(/^\S+\s/, '')}`;
  if (d.kind === 'web') return `aprovar: ${d.text[0].toLowerCase()}${d.text.slice(1)}`;
  if (d.kind === 'question') return 'responder uma pergunta';
  return `aprovar: ${d.text[0].toLowerCase()}${d.text.slice(1)}`;
}
