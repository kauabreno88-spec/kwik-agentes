import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describePermission, describeTool, describeWaitingFor } from '../server/describe.mjs';
import { SessionState } from '../server/session.mjs';
import { maskSecrets } from '../server/util.mjs';

const T0 = Date.parse('2026-10-16T12:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const claude = () => new SessionState({ provider: 'claude', account: { id: 'claude' }, sessionId: 's1', path: '/x/s1.jsonl' });
const codex = () => new SessionState({ provider: 'codex', account: { id: 'codex' }, sessionId: 'c1', path: '/x/c1.jsonl' });

test('Claude Code: pedido, ferramenta, resultado e fim de turno', () => {
  const s = claude();
  s.applyClaude({ type: 'user', cwd: '/home/ana/site', gitBranch: 'main', timestamp: at(0), message: { role: 'user', content: '@"/tmp/manual.pdf" Ajusta o botão do topo' } }, true);
  s.applyClaude({ type: 'assistant', timestamp: at(2), message: { id: 'm1', model: 'claude-opus-4-1', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/home/ana/site/Hero.tsx' } }], usage: { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 1000, output_tokens: 5 }, stop_reason: 'tool_use' } }, true);
  // A mesma resposta em outra linha, com o uso final: conta só a diferença.
  s.applyClaude({ type: 'assistant', timestamp: at(2), message: { id: 'm1', model: 'claude-opus-4-1', content: [], usage: { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 1000, output_tokens: 25 } } }, true);
  assert.equal(s.inferStatus(T0 + 3000), 'working');
  s.applyClaude({ type: 'user', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }, true);
  s.applyClaude({ type: 'assistant', timestamp: at(5), message: { id: 'm2', content: [{ type: 'text', text: 'Pronto.' }], usage: { input_tokens: 1, output_tokens: 3 }, stop_reason: 'end_turn' } }, true);

  assert.equal(s.title, 'Ajusta o botão do topo');
  assert.equal(s.cwd, '/home/ana/site');
  assert.equal(s.branch, 'main');
  assert.equal(s.model, 'claude-opus-4-1');
  assert.equal(s.promptCount, 1);
  assert.equal(s.toolCount, 1);
  assert.deepEqual(s.tokens, { input: 101, output: 28, cache: 1000 });
  assert.equal(s.currentActivity().text, 'Editando Hero.tsx');
  assert.equal(s.inferStatus(T0 + 60_000), 'idle');
  const feed = s.drainFeed();
  assert.deepEqual(feed.map((f) => f.kind), ['prompt', 'edit']);
  assert.equal(s.conversation.at(-1).text, 'Pronto.');
});

test('Claude Code: título manual, comando /, interrupção e linhas ignoradas', () => {
  const s = claude();
  s.applyClaude({ type: 'user', timestamp: at(0), isMeta: true, message: { content: 'aviso interno' } }, false);
  s.applyClaude({ type: 'user', timestamp: at(1), message: { content: '<command-name>/review</command-name><command-args>PR 12</command-args>' } }, false);
  s.applyClaude({ type: 'user', timestamp: at(2), message: { content: '<local-command-stdout>saída</local-command-stdout>' } }, false);
  s.applyClaude({ type: 'user', timestamp: at(3), isSidechain: true, message: { content: 'de um subagente' } }, false);
  assert.equal(s.promptCount, 1);
  assert.equal(s.lastPrompt, '/review PR 12');
  s.applyClaude({ type: 'custom-title', customTitle: 'Revisão do PR 12' }, false);
  assert.equal(s.title, 'Revisão do PR 12');
  s.applyClaude({ type: 'user', timestamp: at(4), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }, true);
  assert.equal(s.turnOpen, false);
  assert.equal(s.currentActivity().text, 'Interrompido por você');
  s.applyClaude({ type: 'user', gitBranch: 'HEAD', timestamp: at(5), message: { content: 'oi' } }, false);
  assert.equal(s.branch, undefined);
});

test('Claude Code: TodoWrite vira lista de tarefas', () => {
  const s = claude();
  s.applyClaude({ type: 'assistant', timestamp: at(0), message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos: [{ content: 'Ler', status: 'completed' }, { content: 'Editar', status: 'in_progress' }] } }] } }, false);
  assert.deepEqual(s.todos, [
    { text: 'Ler', status: 'completed' },
    { text: 'Editar', status: 'in_progress' },
  ]);
});

test('Codex (legacy): meta, pedido, ferramenta, tokens e fim de turno', () => {
  const s = codex();
  s.applyCodex({ type: 'session_meta', timestamp: at(0), payload: { id: '0199a213-81c0-7800-8aa1-bbab2a035a53', cwd: '/home/ana/dre', cli_version: '0.50.0', git: { branch: 'main' } } }, false);
  s.applyCodex({ type: 'turn_context', timestamp: at(0), payload: { model: 'gpt-5-codex', cwd: '/home/ana/dre' } }, false);
  s.applyCodex({ type: 'event_msg', timestamp: at(1), payload: { type: 'task_started' } }, true);
  s.applyCodex({ type: 'event_msg', timestamp: at(1), payload: { type: 'user_message', message: 'Gera o DRE de setembro' } }, true);
  s.applyCodex({ type: 'response_item', timestamp: at(2), payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'python gerar_dre.py'] }) } }, true);
  assert.equal(s.inferStatus(T0 + 3000), 'working');
  s.applyCodex({ type: 'response_item', timestamp: at(3), payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } }, true);
  s.applyCodex({ type: 'event_msg', timestamp: at(4), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 300 } } } }, true);
  s.applyCodex({ type: 'event_msg', timestamp: at(5), payload: { type: 'task_complete', last_agent_message: 'Feito.' } }, true);

  assert.equal(s.sessionId, '0199a213-81c0-7800-8aa1-bbab2a035a53');
  assert.equal(s.title, 'Gera o DRE de setembro');
  assert.equal(s.model, 'gpt-5-codex');
  assert.equal(s.branch, 'main');
  assert.equal(s.toolCount, 1);
  assert.deepEqual(s.tokens, { input: 1000, output: 300, cache: 200 });
  assert.equal(s.currentActivity().text, 'Rodando: python gerar_dre.py');
  assert.equal(s.inferStatus(T0 + 6000), 'idle');
  assert.equal(s.conversation.at(-1).text, 'Feito.');
});

test('Codex (paginated): itens concluídos e subagente', () => {
  const s = codex();
  s.applyCodex({ type: 'session_meta', timestamp: at(0), payload: { id: 'x', cwd: '/p', history_mode: 'paginated' } }, false);
  s.applyCodex({ type: 'event_msg', timestamp: at(1), payload: { type: 'user_message', message: 'ignorado no paginated' } }, false);
  s.applyCodex({ type: 'event_msg', timestamp: at(1), payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Corrige o teste' }] } } }, false);
  s.applyCodex({ type: 'event_msg', timestamp: at(2), payload: { type: 'item_completed', item: { type: 'FileChange', id: 'f1', changes: { '/p/a.ts': {} } } } }, false);
  assert.equal(s.promptCount, 1);
  assert.equal(s.currentActivity().text, 'Editando a.ts');
  const sub = codex();
  sub.applyCodex({ type: 'session_meta', payload: { id: 'y', source: { subagent: { thread_spawn: {} } } } }, false);
  assert.equal(sub.isSubagent, true);
});

test('descrições no tom da KWIK', () => {
  assert.equal(describeTool('Read', { file_path: '/a/b/c.md' }).text, 'Lendo c.md');
  assert.equal(describeTool('Bash', { command: 'npm test', description: 'Roda a suíte' }).kind, 'test');
  assert.equal(describeTool('Bash', { command: 'python - <<EOF\nlatest test\nEOF' }).kind, 'terminal');
  assert.equal(describeTool('mcp__github__create_issue', {}).text, 'Usando github: create issue');
  assert.equal(describeTool('apply_patch', { input: '*** Update File: a.ts\n*** Add File: b.ts' }).text, 'Editando 2 arquivos');
  assert.equal(describePermission('Bash', { command: 'rm -rf dist' }), 'aprovar o comando rm -rf dist');
  assert.equal(describePermission('Write', { file_path: '/x/novo.ts' }), 'aprovar: criar novo.ts');
  assert.equal(describeWaitingFor('input needed'), 'responder uma pergunta');
  assert.equal(describeWaitingFor('permission'), 'aprovar uma permissão');
});

test('segredos não aparecem no painel', () => {
  assert.equal(maskSecrets('curl -H "Authorization: Bearer abc.def" x'), 'curl -H "Authorization: Bearer •••• x');
  assert.match(maskSecrets('export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234'), /••••/);
  assert.doesNotMatch(maskSecrets('gh auth ghp_abcdefghijklmnopqrstuvwxyz0123'), /ghp_/);
  assert.equal(maskSecrets('senha=segredo123 ok'), 'senha=•••• ok');
});
