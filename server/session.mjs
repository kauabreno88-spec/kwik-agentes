// Estado de UMA sessão (Claude Code ou Codex), montado linha a linha a partir do transcript/rollout.
// Guarda só o que o painel mostra: título, projeto, modelo, números, as últimas atividades, a conversa recente,
// a lista de tarefas e os números de cada dia (para o "Meu dia").
import { describeTool } from './describe.mjs';
import { dayKey, firstLine, maskSecrets, num, rec, str, toMs, truncate } from './util.mjs';

const MAX_ACTIVITIES = 80;
const MAX_CONVERSATION = 150;
const MAX_TEXT = 3000;
const MAX_DAYS = 3;

const INTERRUPTED = /^\[Request interrupted by user/;
/** Textos de usuário que não são pedidos de verdade (avisos e saídas que o próprio agente injeta). */
const NOT_A_PROMPT = /^\s*<(local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|task-notification|user-prompt-submit-hook|bash-stdout|bash-stderr|environment_context|user_instructions|turn_aborted)\b/;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b === 'string' ? b : b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

export class SessionState {
  constructor({ provider, account, sessionId, path }) {
    this.provider = provider;
    this.account = account;
    this.sessionId = sessionId;
    this.path = path;
    this.cwd = undefined;
    this.branch = undefined;
    this.model = undefined;
    this.version = undefined;
    this.customTitle = undefined;
    this.aiTitle = undefined;
    this.summary = undefined;
    this.firstPrompt = undefined;
    this.lastPrompt = undefined;
    this.startedAt = undefined;
    this.lastAt = undefined;
    this.tokens = { input: 0, output: 0, cache: 0 };
    this.toolCount = 0;
    this.promptCount = 0;
    this.activities = [];
    this.conversation = [];
    this.todos = undefined;
    this.turnOpen = false;
    this.lastKind = undefined; // 'prompt' | 'tool' | 'result' | 'reply'
    this.pending = new Map();
    this.days = new Map();
    this.isSubagent = false;
    this.hidden = false;
    this.historyMode = 'legacy';
    this.feed = []; // eventos novos desde a última coleta (só ao vivo)
    this._usage = new Map(); // Claude: uso por message.id (as linhas de uma resposta repetem o uso)
    this._seenTools = new Set();
    this._codexTotal = undefined;
  }

  get title() {
    for (const t of [this.customTitle, this.aiTitle, this.summary, this.firstPrompt]) {
      // Tira as menções a arquivos (@"caminho" e @caminho), que só ocupam espaço no título.
      const clean = firstLine(String(t ?? '').replace(/@"[^"]*"/g, ' ').replace(/(^|\s)@[^\s]+/g, ' '));
      if (clean) return truncate(clean, 90);
    }
    return 'Sessão sem título';
  }

  // ------------------------------------------------------------------ registro comum

  day(at) {
    const key = dayKey(at ?? Date.now());
    let d = this.days.get(key);
    if (!d) {
      d = { prompts: 0, tools: 0, tokens: 0, hours: new Array(24).fill(0), minutes: new Uint8Array(1440), firstAt: at, lastAt: at };
      this.days.set(key, d);
      if (this.days.size > MAX_DAYS) this.days.delete(this.days.keys().next().value);
    }
    return d;
  }

  touch(at) {
    if (!at) return;
    if (!this.startedAt || at < this.startedAt) this.startedAt = at;
    if (!this.lastAt || at > this.lastAt) this.lastAt = at;
    const d = this.day(at);
    const t = new Date(at);
    d.minutes[t.getHours() * 60 + t.getMinutes()] = 1;
    d.firstAt = Math.min(d.firstAt ?? at, at);
    d.lastAt = Math.max(d.lastAt ?? at, at);
  }

  count(at, field, n = 1) {
    if (!at) return;
    const d = this.day(at);
    d[field] += n;
    if (field !== 'tokens') d.hours[new Date(at).getHours()] += n;
  }

  activity(a, live) {
    const entry = { id: a.id, at: a.at ?? Date.now(), kind: a.kind, text: maskSecrets(a.text) };
    if (a.id) {
      const i = this.activities.findIndex((x) => x.id === a.id);
      if (i >= 0) {
        this.activities[i] = { ...this.activities[i], ...entry };
        return;
      }
    }
    this.activities.push(entry);
    if (this.activities.length > MAX_ACTIVITIES) this.activities.splice(0, this.activities.length - MAX_ACTIVITIES);
    if (live) this.feed.push(entry);
  }

  say(role, text, at, kind) {
    const clean = maskSecrets(String(text ?? '').trim());
    if (!clean) return;
    this.conversation.push({ role, at, kind, text: clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}…` : clean });
    if (this.conversation.length > MAX_CONVERSATION) this.conversation.splice(0, this.conversation.length - MAX_CONVERSATION);
  }

  prompt(text, at, live) {
    const t = String(text ?? '').trim();
    if (!t) return;
    this.promptCount++;
    this.count(at, 'prompts');
    this.firstPrompt ??= t;
    this.lastPrompt = t;
    this.turnOpen = true;
    this.lastKind = 'prompt';
    this.say('user', t, at);
    this.activity({ at, kind: 'prompt', text: `Você pediu: ${truncate(firstLine(t), 80)}` }, live);
  }

  tool(id, name, input, at, live) {
    const d = describeTool(name, input);
    if (id && this._seenTools.has(id)) {
      this.activity({ id, at, ...d }, false);
      return;
    }
    if (id) {
      this._seenTools.add(id);
      if (this._seenTools.size > 2000) this._seenTools.delete(this._seenTools.values().next().value);
      this.pending.set(id, at);
    }
    this.toolCount++;
    this.count(at, 'tools');
    this.turnOpen = true;
    this.lastKind = 'tool';
    this.say('tool', d.text, at, d.kind);
    this.activity({ id, at, ...d }, live);
    if ((name === 'TodoWrite' || name === 'update_plan') && rec(input)) {
      const list = Array.isArray(input.todos) ? input.todos : Array.isArray(input.plan) ? input.plan : undefined;
      if (list) {
        this.todos = list
          .map((t) => ({ text: truncate(t.content ?? t.step ?? t.activeForm ?? '', 120), status: String(t.status ?? 'pending') }))
          .filter((t) => t.text);
      }
    }
  }

  result(id, isError, at, live) {
    if (id) this.pending.delete(id);
    this.lastKind = 'result';
    if (isError) this.activity({ at, kind: 'error', text: 'Um comando deu erro (o agente vai tentar de novo)' }, false);
    void live;
  }

  reply(text, at) {
    this.lastKind = 'reply';
    this.say('assistant', text, at);
  }

  endTurn(at, live, interrupted = false) {
    this.turnOpen = false;
    this.pending.clear();
    if (interrupted) this.activity({ at, kind: 'wait', text: 'Interrompido por você' }, live);
  }

  /** Coleta (e limpa) os eventos novos para o feed. */
  drainFeed() {
    const out = this.feed;
    this.feed = [];
    return out;
  }

  // ------------------------------------------------------------------ Claude Code

  applyClaude(j, live) {
    if (!rec(j)) return;
    const at = toMs(j.timestamp);
    switch (j.type) {
      case 'custom-title':
        this.customTitle = str(j.customTitle) ?? this.customTitle;
        return;
      case 'ai-title':
        this.aiTitle = str(j.aiTitle) ?? this.aiTitle;
        return;
      case 'summary':
        this.summary ??= str(j.summary);
        return;
      case 'system':
        if (j.isSidechain) return;
        this.touch(at);
        if (j.subtype === 'compact_boundary') this.activity({ at, kind: 'plan', text: 'Resumiu a conversa para liberar espaço' }, live);
        return;
      case 'user':
        return this.claudeUser(j, at, live);
      case 'assistant':
        return this.claudeAssistant(j, at, live);
      default:
        return;
    }
  }

  claudeMeta(j) {
    this.cwd = str(j.cwd) ?? this.cwd;
    // "HEAD" = fora de um repositório git (ou HEAD solto): não é um branch para mostrar.
    if (str(j.gitBranch)) this.branch = j.gitBranch === 'HEAD' ? undefined : j.gitBranch;
    this.version = str(j.version) ?? this.version;
  }

  claudeUser(j, at, live) {
    if (j.isSidechain) return;
    this.claudeMeta(j);
    if (j.isMeta === true) return;
    this.touch(at);
    const content = rec(j.message)?.content;
    if (Array.isArray(content)) {
      let hadResult = false;
      let interrupted = false;
      for (const b of content) {
        if (b?.type === 'tool_result') {
          hadResult = true;
          const t = textOf(b.content);
          if (INTERRUPTED.test(t.trimStart())) interrupted = true;
          this.result(b.tool_use_id, b.is_error === true && !interrupted, at, live);
        }
      }
      const text = textOf(content);
      if (INTERRUPTED.test(text.trimStart())) interrupted = true;
      if (interrupted) return this.endTurn(at, live, true);
      if (hadResult) return;
      return this.claudePromptText(text, at, live);
    }
    if (typeof content === 'string') this.claudePromptText(content, at, live);
  }

  claudePromptText(text, at, live) {
    const t = String(text ?? '');
    if (!t.trim()) return;
    if (INTERRUPTED.test(t.trimStart())) return this.endTurn(at, live, true);
    const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(t)?.[1]?.trim();
    if (cmd) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim();
      return this.prompt(`${cmd.startsWith('/') ? cmd : `/${cmd}`}${args ? ` ${args}` : ''}`, at, live);
    }
    if (NOT_A_PROMPT.test(t)) return;
    this.prompt(t, at, live);
  }

  claudeAssistant(j, at, live) {
    if (j.isSidechain) return;
    this.claudeMeta(j);
    this.touch(at);
    const m = rec(j.message);
    if (!m) return;
    const model = str(m.model);
    if (model && model !== '<synthetic>') this.model = model;
    const u = rec(m.usage);
    if (u) {
      const now = {
        input: (num(u.input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0),
        output: num(u.output_tokens) ?? 0,
        cache: num(u.cache_read_input_tokens) ?? 0,
      };
      const key = str(m.id) ?? `${at}`;
      const prev = this._usage.get(key) ?? { input: 0, output: 0, cache: 0 };
      const delta = {
        input: Math.max(0, now.input - prev.input),
        output: Math.max(0, now.output - prev.output),
        cache: Math.max(0, now.cache - prev.cache),
      };
      this._usage.set(key, { input: Math.max(now.input, prev.input), output: Math.max(now.output, prev.output), cache: Math.max(now.cache, prev.cache) });
      if (this._usage.size > 300) this._usage.delete(this._usage.keys().next().value);
      this.tokens.input += delta.input;
      this.tokens.output += delta.output;
      this.tokens.cache += delta.cache;
      this.count(at, 'tokens', delta.input + delta.output);
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    let hasTool = false;
    for (const b of blocks) {
      if (b?.type === 'tool_use') {
        hasTool = true;
        this.tool(b.id, b.name, b.input, at, live);
      } else if (b?.type === 'text' && str(b.text)) {
        this.reply(b.text, at);
      }
    }
    if (!hasTool && (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence')) this.endTurn(at, live);
  }

  // ------------------------------------------------------------------ Codex

  applyCodex(j, live) {
    if (!rec(j)) return;
    const at = toMs(j.timestamp);
    const p = rec(j.payload);
    if (!p) return;
    switch (j.type) {
      case 'session_meta':
        return this.codexMeta(p, at);
      case 'turn_context':
        this.model = str(p.model) ?? this.model;
        this.cwd = str(p.cwd) ?? this.cwd;
        return;
      case 'event_msg':
        this.touch(at);
        return this.codexEvent(p, at, live);
      case 'response_item':
        this.touch(at);
        return this.codexItem(p, at, live);
      case 'compacted':
        this.activity({ at, kind: 'plan', text: 'Resumiu a conversa para liberar espaço' }, live);
        return;
      default:
        return;
    }
  }

  codexMeta(p, at) {
    this.sessionId = str(p.id) ?? this.sessionId;
    this.cwd = str(p.cwd) ?? this.cwd;
    this.version = str(p.cli_version) ?? this.version;
    this.branch = str(rec(p.git)?.branch) ?? this.branch;
    this.historyMode = p.history_mode === 'paginated' ? 'paginated' : 'legacy';
    const src = p.source;
    const srcObj = rec(src);
    if (srcObj && ('subagent' in srcObj || 'spawn' in srcObj)) this.isSubagent = true;
    if (str(p.parent_thread_id)) this.isSubagent = true;
    if ((srcObj && 'internal' in srcObj) || /guardian|internal/i.test(String(p.thread_source ?? ''))) this.hidden = true;
    const started = toMs(p.timestamp) ?? at;
    if (started) this.touch(started);
  }

  codexEvent(p, at, live) {
    switch (p.type) {
      case 'task_started':
      case 'turn_started':
        this.turnOpen = true;
        return;
      case 'task_complete':
      case 'turn_complete':
        if (str(p.last_agent_message) && this.lastKind !== 'reply') this.reply(p.last_agent_message, at);
        return this.endTurn(at, live);
      case 'turn_aborted':
        return this.endTurn(at, live, p.reason === undefined || p.reason === 'interrupted');
      case 'token_count': {
        const total = rec(rec(p.info)?.total_token_usage);
        if (!total) return;
        const cached = num(total.cached_input_tokens) ?? 0;
        const input = Math.max(0, (num(total.input_tokens) ?? 0) - cached);
        const output = num(total.output_tokens) ?? 0;
        const prevSum = this._codexTotal ?? 0;
        const sum = input + output;
        this.tokens = { input, output, cache: cached };
        if (sum > prevSum) this.count(at, 'tokens', sum - prevSum);
        this._codexTotal = Math.max(sum, prevSum);
        return;
      }
      case 'user_message':
        if (this.historyMode === 'paginated') return;
        if (NOT_A_PROMPT.test(String(p.message ?? ''))) return;
        return this.prompt(p.message, at, live);
      case 'agent_message':
        if (this.historyMode === 'paginated') return;
        return this.reply(p.message, at);
      case 'exec_command_end':
      case 'patch_apply_end':
      case 'mcp_tool_call_end':
        return this.result(str(p.call_id), (num(p.exit_code) ?? 0) !== 0, at, live);
      case 'item_completed':
        return this.codexCompleted(rec(p.item), at, live);
      default:
        return;
    }
  }

  codexCompleted(item, at, live) {
    if (!item || this.historyMode !== 'paginated') return;
    const id = str(item.id) ?? str(item.call_id);
    switch (item.type) {
      case 'UserMessage': {
        const text = textOf(item.content) || str(item.text) || '';
        if (NOT_A_PROMPT.test(text)) return;
        return this.prompt(text, at, live);
      }
      case 'AgentMessage':
        return this.reply(textOf(item.content) || str(item.text) || '', at);
      case 'CommandExecution':
        this.tool(id, 'exec_command', { command: item.command ?? item.cmd }, at, live);
        return this.result(id, (num(item.exit_code) ?? num(item.exitCode) ?? 0) !== 0, at, live);
      case 'FileChange': {
        const changes = item.changes;
        const paths = Array.isArray(changes) ? changes.map((c) => c?.path).filter(Boolean) : rec(changes) ? Object.keys(changes) : [];
        const patch = paths.map((f) => `*** Update File: ${f}`).join('\n');
        this.tool(id, 'apply_patch', { input: patch }, at, live);
        return this.result(id, false, at, live);
      }
      case 'McpToolCall':
        this.tool(id, `mcp__${item.server ?? 'mcp'}__${item.tool ?? 'ferramenta'}`, item.arguments, at, live);
        return this.result(id, false, at, live);
      case 'WebSearch':
        this.tool(id, 'web_search', { query: item.query }, at, live);
        return this.result(id, false, at, live);
      default:
        return;
    }
  }

  codexItem(p, at, live) {
    switch (p.type) {
      case 'function_call': {
        let args = {};
        try {
          args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : rec(p.arguments) ?? {};
        } catch {
          args = {};
        }
        return this.tool(str(p.call_id), str(p.name) ?? 'ferramenta', args, at, live);
      }
      case 'custom_tool_call':
        return this.tool(str(p.call_id), str(p.name) ?? 'ferramenta', { input: p.input }, at, live);
      case 'local_shell_call':
        return this.tool(str(p.call_id), 'local_shell', { command: rec(p.action)?.command }, at, live);
      case 'web_search_call':
        return this.tool(str(p.id), 'web_search', { query: rec(p.action)?.query }, at, live);
      case 'function_call_output':
      case 'custom_tool_call_output':
        return this.result(str(p.call_id), false, at, live);
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ status deduzido

  /** Status deduzido só do arquivo (quando não há registro nem hook recente). */
  inferStatus(now = Date.now(), mtimeMs = this.lastAt ?? 0) {
    const last = Math.max(this.lastAt ?? 0, mtimeMs);
    const age = now - last;
    if (age > 10 * 60_000) return 'idle';
    // O Codex grava o começo e o fim de cada turno: dá para confiar.
    if (this.provider === 'codex') return this.turnOpen ? 'working' : 'idle';
    // Claude Code: um comando ainda sem resultado = trabalhando (ou esperando aprovação, que o registro/hook dizem).
    if (this.pending.size > 0) return 'working';
    // Última coisa foi uma resposta em texto: o turno acabou (com 4 s de folga para a próxima linha chegar).
    if (this.lastKind === 'reply') return age < 4_000 ? 'working' : 'idle';
    if (this.lastKind === 'prompt' || this.lastKind === 'result' || this.lastKind === 'tool') return age < 3 * 60_000 ? 'working' : 'idle';
    return this.turnOpen ? 'working' : 'idle';
  }

  /** A atividade mais recente (o que o agente está fazendo ou fez por último). */
  currentActivity() {
    for (let i = this.activities.length - 1; i >= 0; i--) if (this.activities[i].kind !== 'error') return this.activities[i];
    return undefined;
  }
}
