// O "escritório" da KWIK: junta as fontes (Claude Code e Codex), aplica o que os hooks contam ao vivo e monta o
// retrato que o painel mostra (agentes, projetos, feed e números do dia).
import { EventEmitter } from 'node:events';
import { describePermission, describeWaitingFor } from './describe.mjs';
import { ClaudeSource, CodexSource, RECENT_OPEN_MS, registryStatus } from './sources.mjs';
import { dayKey, projectName, str, truncate } from './util.mjs';

const POLL_MS = 1_500;
const FEED_MAX = 60;
/** Um hook de "precisa de você" vale até a sessão escrever algo depois dele (ou por 30 min). */
const HOOK_WAIT_MS = 30 * 60_000;
/** Sessão aberta só por hook (sem escrita) some depois de 6 h sem notícias. */
const HOOK_OPEN_MS = 6 * 3600_000;

export function agentId(provider, accountId, sessionId) {
  return `${provider}-${accountId}-${sessionId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export class Office extends EventEmitter {
  constructor(accounts, { inDocker = false, version = '0.0.0' } = {}) {
    super();
    this.version = version;
    this.inDocker = inDocker;
    this.sources = accounts.map((a) => (a.provider === 'codex' ? new CodexSource(a) : new ClaudeSource(a, { inDocker })));
    this.live = new Map(); // `${provider}:${sessionId}` -> {status, waitingFor, at, open, ended, activity}
    this.hookSeen = { claude: undefined, codex: undefined };
    this.agents = [];
    this.byId = new Map();
    this.feed = [];
    this.prev = new Map();
    this.loaded = false;
    this.today = undefined;
    this.timer = undefined;
    this.signature = '';
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Um hook pediu: relê logo (com um respiro para o arquivo terminar de ser gravado). */
  soon() {
    if (this.soonTimer) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = undefined;
      this.tick();
    }, 150);
  }

  liveHint(provider) {
    return (sessionId) => {
      const l = this.live.get(`${provider}:${sessionId}`);
      if (!l) return undefined;
      if (l.ended) return 'ended';
      if (l.open && Date.now() - l.at < HOOK_OPEN_MS) return 'open';
      return undefined;
    };
  }

  tick() {
    const now = Date.now();
    const agents = [];
    const allSessions = [];
    for (const src of this.sources) {
      let res;
      try {
        res = src.poll(now, this.liveHint(src.account.provider));
      } catch (err) {
        src.status = { ok: false, error: String(err?.message ?? err) };
        continue;
      }
      for (const t of res.all) allSessions.push(t);
      for (const o of res.open) {
        if (!o.tracked && !o.entry) continue;
        agents.push(this.buildAgent(src, o, now));
      }
    }
    // Feed: o que cada sessão fez de novo + as mudanças de status.
    const fresh = [];
    for (const t of allSessions) {
      for (const ev of t.session.drainFeed()) {
        if (!this.loaded) continue;
        const a = this.byIdFor(t.session, agents);
        fresh.push(this.feedEntry(t.session, a, ev));
      }
    }
    const nextPrev = new Map();
    for (const a of agents) {
      nextPrev.set(a.id, a.status);
      if (!this.loaded) continue;
      const before = this.prev.get(a.id);
      if (before === undefined) fresh.push({ at: now, agentId: a.id, provider: a.provider, project: a.project, title: a.title, kind: 'start', text: 'Abriu uma sessão' });
      else if (before !== a.status) {
        if (a.status === 'waiting') fresh.push({ at: now, agentId: a.id, provider: a.provider, project: a.project, title: a.title, kind: 'wait', text: `Precisa de você: ${a.waitingFor}` });
        else if (a.status === 'idle' && (before === 'working' || before === 'shell')) fresh.push({ at: now, agentId: a.id, provider: a.provider, project: a.project, title: a.title, kind: 'done', text: 'Terminou e está livre' });
      }
    }
    if (this.loaded) {
      for (const [id] of this.prev) {
        if (nextPrev.has(id)) continue;
        const old = this.byId.get(id);
        if (old) fresh.push({ at: now, agentId: id, provider: old.provider, project: old.project, title: old.title, kind: 'done', text: 'Encerrou a sessão' });
      }
    }
    this.prev = nextPrev;
    // Primeira carga: o feed começa com o que as sessões de hoje já fizeram.
    if (!this.loaded) {
      const since = now - 12 * 3600_000;
      for (const t of allSessions) {
        const a = this.byIdFor(t.session, agents);
        for (const ev of t.session.activities.slice(-15)) if (ev.at >= since && ev.kind !== 'error') fresh.push(this.feedEntry(t.session, a, ev));
      }
    }
    fresh.sort((a, b) => a.at - b.at);
    this.feed.push(...fresh);
    if (this.feed.length > FEED_MAX) this.feed.splice(0, this.feed.length - FEED_MAX);

    agents.sort((a, b) => order(a) - order(b) || (b.lastAt ?? 0) - (a.lastAt ?? 0));
    this.agents = agents;
    this.byId = new Map(agents.map((a) => [a.id, a]));
    this.sessions = allSessions;
    this.today = this.summarizeDay(allSessions, now);
    this.loaded = true;
    // Limpa hooks velhos.
    for (const [k, l] of this.live) if (now - l.at > HOOK_OPEN_MS) this.live.delete(k);

    const sig = JSON.stringify([agents, this.feed.length, this.feed.at(-1)?.at, this.today, this.sources.map((s) => s.status)]);
    if (sig !== this.signature) {
      this.signature = sig;
      this.emit('change');
    }
  }

  byIdFor(session, agents) {
    const id = agentId(session.provider, session.account.id, session.sessionId);
    return agents.find((a) => a.id === id);
  }

  feedEntry(session, agent, ev) {
    return {
      at: ev.at ?? Date.now(),
      agentId: agent?.id ?? agentId(session.provider, session.account.id, session.sessionId),
      provider: session.provider,
      project: projectName(session.cwd),
      title: session.title,
      kind: ev.kind,
      text: ev.text,
    };
  }

  buildAgent(src, o, now) {
    const account = src.account;
    const s = o.tracked?.session;
    const e = o.entry;
    const sessionId = e?.sessionId ?? s?.sessionId;
    const key = `${account.provider}:${sessionId}`;
    const hook = this.live.get(key);
    const lastWrite = Math.max(s?.lastAt ?? 0, o.tracked?.mtimeMs ?? 0);
    let status = registryStatus(e);
    let waitingFor = status === 'waiting' ? describeWaitingFor(e?.waitingFor) : undefined;
    if (!status) status = s ? s.inferStatus(now, o.tracked?.mtimeMs) : 'idle';
    // O hook sabe antes: "precisa de você" vale até a sessão escrever algo depois dele.
    if (hook && hook.status === 'waiting' && hook.at >= lastWrite - 500 && now - hook.at < HOOK_WAIT_MS && status !== 'waiting') {
      status = 'waiting';
      waitingFor = hook.waitingFor ?? 'responder no terminal';
    } else if (hook && !e && hook.at > lastWrite && now - hook.at < RECENT_OPEN_MS) {
      if (hook.status === 'working' && status === 'idle') status = 'working';
      if (hook.status === 'idle' && status === 'working' && account.provider === 'codex') status = 'idle';
    }
    const cwd = e?.cwd ?? s?.cwd ?? hook?.cwd;
    const act = status === 'waiting' ? { kind: 'wait', text: capitalize(waitingFor), at: hook?.at ?? now } : s?.currentActivity();
    const today = s?.days.get(dayKey(now));
    const todos = s?.todos;
    return {
      id: agentId(account.provider, account.id, sessionId),
      provider: account.provider,
      account: account.id,
      accountLabel: account.label,
      sessionId,
      cwd,
      project: projectName(cwd),
      title: e?.name ? truncate(e.name, 90) : (s?.title ?? 'Sessão nova'),
      status,
      waitingFor,
      activity: act ? { kind: act.kind, text: act.text, at: act.at } : undefined,
      model: s?.model,
      branch: s?.branch,
      version: e?.version ?? s?.version,
      startedAt: e?.startedAt ?? s?.startedAt,
      lastAt: Math.max(lastWrite, hook?.at ?? 0) || undefined,
      tokens: s ? { ...s.tokens } : { input: 0, output: 0, cache: 0 },
      tools: s?.toolCount ?? 0,
      prompts: s?.promptCount ?? 0,
      today: today ? { prompts: today.prompts, tools: today.tools, tokens: today.tokens } : { prompts: 0, tools: 0, tokens: 0 },
      subagents: o.subagents ?? 0,
      todos: todos?.length ? { done: todos.filter((t) => t.status === 'completed').length, total: todos.length } : undefined,
    };
  }

  // ------------------------------------------------------------------ hooks

  /** Evento de hook (Claude Code ou Codex). Devolve false para evento sem sessão. */
  applyHook(provider, input) {
    const sessionId = str(input?.session_id);
    const event = str(input?.hook_event_name);
    if (!sessionId || !event || (provider !== 'claude' && provider !== 'codex')) return false;
    const now = Date.now();
    this.hookSeen[provider] = now;
    const key = `${provider}:${sessionId}`;
    const l = this.live.get(key) ?? { open: true };
    l.at = now;
    l.cwd = str(input.cwd) ?? l.cwd;
    switch (event) {
      case 'SessionStart':
        l.open = true;
        l.ended = false;
        l.status = 'idle';
        break;
      case 'SessionEnd':
        l.open = false;
        l.ended = true;
        l.status = 'idle';
        break;
      case 'UserPromptSubmit':
      case 'PreToolUse':
      case 'PostToolUse':
      case 'SubagentStart':
        l.status = 'working';
        l.open = true;
        l.ended = false;
        break;
      case 'Stop':
      case 'SubagentStop':
        if (event === 'Stop') l.status = 'idle';
        break;
      case 'PermissionRequest': {
        l.status = 'waiting';
        const tool = str(input.tool_name);
        l.waitingFor = tool ? describePermission(tool, input.tool_input) : 'aprovar uma permissão';
        break;
      }
      case 'Notification': {
        const type = str(input.notification_type) ?? '';
        const msg = str(input.message) ?? '';
        if (type === 'idle_prompt') {
          l.status = 'idle';
        } else if (type === 'permission_prompt' || /permission/i.test(msg)) {
          // O PermissionRequest (que chega antes) já diz o quê; sem ele, fica o genérico.
          if (l.status !== 'waiting' || !l.waitingFor || l.waitingFor === 'responder no terminal') l.waitingFor = 'aprovar uma permissão';
          l.status = 'waiting';
        } else if (type === 'elicitation_dialog' || /question/i.test(msg)) {
          l.status = 'waiting';
          l.waitingFor = 'responder uma pergunta';
        }
        break;
      }
      default:
        return false;
    }
    if (l.status !== 'waiting') l.waitingFor = undefined;
    this.live.set(key, l);
    if (provider === 'codex') for (const s of this.sources) if (s instanceof CodexSource) s.want(sessionId);
    if (provider === 'claude') for (const s of this.sources) if (s instanceof ClaudeSource) s.nudge();
    this.soon();
    return true;
  }

  // ------------------------------------------------------------------ leitura

  summarizeDay(sessions, now) {
    const key = dayKey(now);
    const hours = new Array(24).fill(0);
    const minutes = new Uint8Array(1440);
    let prompts = 0;
    let tools = 0;
    let tokens = 0;
    let count = 0;
    const projects = new Set();
    for (const t of sessions) {
      const d = t.session.days.get(key);
      if (!d) continue;
      count++;
      prompts += d.prompts;
      tools += d.tools;
      tokens += d.tokens;
      for (let h = 0; h < 24; h++) hours[h] += d.hours[h];
      for (let m = 0; m < 1440; m++) if (d.minutes[m]) minutes[m] = 1;
      if (t.session.cwd) projects.add(t.session.cwd);
    }
    return { date: key, sessions: count, projects: projects.size, prompts, tools, tokens, hours, activeMinutes: minutes.reduce((a, b) => a + b, 0) };
  }

  /** "Meu dia": números do dia por projeto. */
  dayDetail(now = Date.now()) {
    const key = dayKey(now);
    const byProject = new Map();
    for (const t of this.sessions ?? []) {
      const s = t.session;
      const d = s.days.get(key);
      if (!d) continue;
      const cwd = s.cwd ?? '?';
      let p = byProject.get(cwd);
      if (!p) {
        p = { cwd, project: projectName(cwd), sessions: 0, prompts: 0, tools: 0, tokens: 0, minutes: new Uint8Array(1440), providers: new Set(), lastAt: 0, titles: [] };
        byProject.set(cwd, p);
      }
      p.sessions++;
      p.prompts += d.prompts;
      p.tools += d.tools;
      p.tokens += d.tokens;
      for (let m = 0; m < 1440; m++) if (d.minutes[m]) p.minutes[m] = 1;
      p.providers.add(s.provider);
      p.lastAt = Math.max(p.lastAt, d.lastAt ?? 0);
      if (p.titles.length < 5) p.titles.push(s.title);
    }
    const projects = [...byProject.values()]
      .map((p) => ({ ...p, minutes: p.minutes.reduce((a, b) => a + b, 0), providers: [...p.providers] }))
      .sort((a, b) => b.minutes - a.minutes || b.tools - a.tools);
    return { ...this.summarizeDay(this.sessions ?? [], now), projectsDetail: projects };
  }

  snapshot() {
    return {
      meta: { name: 'KWIK Agentes', version: this.version, now: Date.now(), docker: this.inDocker, hooks: { ...this.hookSeen } },
      accounts: this.accountsInfo(),
      agents: this.agents,
      feed: this.feed.slice(-40),
      today: this.today,
    };
  }

  accountsInfo() {
    return this.sources.map((s) => ({
      provider: s.account.provider,
      id: s.account.id,
      label: s.account.label,
      dir: s.account.hostDir ?? s.account.dir,
      ok: s.status.ok,
      error: s.status.error,
      open: this.agents.filter((a) => a.provider === s.account.provider && a.account === s.account.id).length,
    }));
  }

  sessionFor(id) {
    for (const t of this.sessions ?? []) {
      const s = t.session;
      if (agentId(s.provider, s.account.id, s.sessionId) === id) return s;
    }
    return undefined;
  }

  detail(id) {
    const a = this.byId.get(id);
    const s = this.sessionFor(id);
    if (!a && !s) return undefined;
    return {
      agent: a,
      cwd: a?.cwd ?? s?.cwd,
      activities: (s?.activities ?? []).slice(-60).reverse(),
      todos: s?.todos ?? [],
      tokens: s?.tokens,
    };
  }

  conversation(id) {
    const s = this.sessionFor(id);
    if (!s) return undefined;
    return { id, title: s.title, provider: s.provider, project: projectName(s.cwd), messages: s.conversation.slice(-120) };
  }
}

const capitalize = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

function order(a) {
  return a.status === 'waiting' ? 0 : a.status === 'working' ? 1 : a.status === 'shell' ? 2 : 3;
}
