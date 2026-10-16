// KWIK Agentes — painel. JavaScript puro, sem dependências.
// Dados: GET /api/stream (SSE) com o retrato completo a cada mudança; detalhes, conversa e "Meu dia" sob demanda.
// ?mock=1 liga o modo demonstração (dados fictícios gerados aqui mesmo, nada vem do servidor).

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const MOCK = new URLSearchParams(location.search).get('mock') === '1';

const KIND = {
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
  start: 'Sessão',
};
const STATUS = { working: 'Trabalhando', waiting: 'Precisa de você', shell: 'Esperando comando', idle: 'Livre' };
const PROVIDER = { claude: 'Claude Code', codex: 'Codex' };

const state = {
  snap: undefined,
  filter: 'all',
  query: '',
  selected: undefined,
  detail: undefined,
  sheet: undefined,
  seenWaiting: new Set(),
  first: true,
};

// ------------------------------------------------------------------ formatos (pt-BR)

const nf = new Intl.NumberFormat('pt-BR');
const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const fmtN = (n) => nf.format(n ?? 0);
const fmtTokens = (n) => ((n ?? 0) >= 10_000 ? compact.format(n) : nf.format(n ?? 0));
const plural = (n, one, many) => `${fmtN(n)} ${n === 1 ? one : many}`;

function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return 'agora';
  if (s < 60) return `há ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `há ${Math.floor(h / 24)} d`;
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function duration(min) {
  const m = Math.round(min ?? 0);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

function shortPath(p) {
  return String(p ?? '')
    .replace(/^\/(Users|home)\/[^/]+/, '~')
    .replace(/^\/mnt\/[a-z]\/Users\/[^/]+/i, '~')
    .replace(/^[A-Z]:\\Users\\[^\\]+/i, '~');
}

function prettyModel(m) {
  if (!m) return '';
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  let r = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/i.exec(m);
  if (r) return `${cap(r[1])} ${r[2]}${r[3] ? `.${r[3]}` : ''}`;
  r = /claude-(\d)-(\d)-(opus|sonnet|haiku)/i.exec(m);
  if (r) return `${cap(r[3])} ${r[1]}.${r[2]}`;
  return m.replace(/\[.*\]$/, '');
}

const timeTag = (ms) => (ms ? `<time data-at="${ms}" title="${esc(new Date(ms).toLocaleString('pt-BR'))}">${esc(ago(ms))}</time>` : '');
const kindTag = (k) => `<span class="kind" data-kind="${esc(k)}">${esc(KIND[k] ?? k ?? '')}</span>`;
const statusTag = (s) => `<span class="status" data-s="${esc(s)}"><i aria-hidden="true"></i>${esc(STATUS[s] ?? s)}</span>`;

// ------------------------------------------------------------------ fonte de dados

function createLive() {
  const get = (url) =>
    fetch(url, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : undefined))
      .catch(() => undefined);
  return {
    connect(onSnap, onConn) {
      const es = new EventSource('/api/stream');
      es.addEventListener('snapshot', (e) => {
        onConn('on');
        try {
          onSnap(JSON.parse(e.data));
        } catch {
          // retrato inválido: espera o próximo
        }
      });
      es.addEventListener('open', () => onConn('on'));
      es.addEventListener('error', () => onConn(es.readyState === EventSource.CLOSED ? 'off' : 'connecting'));
    },
    detail: (id) => get(`/api/agents/${encodeURIComponent(id)}`),
    conversation: (id) => get(`/api/agents/${encodeURIComponent(id)}/conversation`),
    day: () => get('/api/day'),
  };
}

const source = MOCK ? createMock() : createLive();

// ------------------------------------------------------------------ helpers de dados

function visibleAgents() {
  const all = state.snap?.agents ?? [];
  const q = state.query.trim().toLowerCase();
  return all.filter((a) => {
    if (state.filter !== 'all' && a.provider !== state.filter) return false;
    if (!q) return true;
    return [a.title, a.project, a.cwd, a.activity?.text, a.branch, PROVIDER[a.provider], a.accountLabel].some((v) => String(v ?? '').toLowerCase().includes(q));
  });
}

function groupByProject(agents) {
  const map = new Map();
  for (const a of agents) {
    const key = a.cwd ?? a.project;
    let g = map.get(key);
    if (!g) {
      g = { key, cwd: a.cwd, project: a.project, agents: [] };
      map.set(key, g);
    }
    g.agents.push(a);
  }
  const rank = (g) => (g.agents.some((a) => a.status === 'waiting') ? 0 : g.agents.some((a) => a.status === 'working' || a.status === 'shell') ? 1 : 2);
  return [...map.values()].sort((a, b) => rank(a) - rank(b) || Math.max(...b.agents.map((x) => x.lastAt ?? 0)) - Math.max(...a.agents.map((x) => x.lastAt ?? 0)));
}

const counts = (agents) => ({
  open: agents.length,
  working: agents.filter((a) => a.status === 'working' || a.status === 'shell').length,
  waiting: agents.filter((a) => a.status === 'waiting').length,
  claude: agents.filter((a) => a.provider === 'claude').length,
  codex: agents.filter((a) => a.provider === 'codex').length,
});

// ------------------------------------------------------------------ render

function render() {
  const snap = state.snap;
  if (!snap) return;
  const c = counts(snap.agents);
  renderHero(c, snap.today);
  renderKpis(c, snap.today);
  renderProjects();
  renderWaiting(snap.agents.filter((a) => a.status === 'waiting'));
  renderBars($('#chart'), snap.today?.hours ?? [], { height: 120 });
  renderFeed(snap.feed ?? []);
  document.title = c.waiting ? `(${c.waiting}) KWIK Agentes` : 'KWIK Agentes';
  if (state.selected) refreshDrawer();
}

function renderHero(c, today) {
  const date = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#today-label').textContent = `Hoje · ${date}`;
  let h;
  if (c.waiting) h = c.waiting === 1 ? 'Tem um agente esperando <em>você</em>.' : `Tem ${c.waiting} agentes esperando <em>você</em>.`;
  else if (c.working) h = c.working === 1 ? 'Seu agente está <em>trabalhando</em>.' : `${c.working} agentes <em>trabalhando</em> agora.`;
  else if (c.open) h = 'Tudo <em>em dia</em>. Os agentes estão livres.';
  else h = 'Nenhum agente <em>aberto</em> agora.';
  $('#headline').innerHTML = h;
  const t = today ?? {};
  $('#lede').innerHTML =
    t.prompts || t.tools
      ? `Hoje a gente contou <b>${plural(t.prompts, 'pedido', 'pedidos')}</b>, <b>${plural(t.tools, 'ferramenta usada', 'ferramentas usadas')}</b> e <b>${esc(duration(t.activeMinutes))}</b> de trabalho em <b>${plural(t.projects, 'projeto', 'projetos')}</b>.`
      : 'Abra o Claude Code ou o Codex em qualquer projeto: o agente aparece aqui, ao vivo.';
}

function kpi(label, value, hint, cls = '') {
  return `<div class="kpi ${cls}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="hint">${esc(hint)}</div></div>`;
}

function renderKpis(c, today) {
  const t = today ?? {};
  $('#kpis').innerHTML = [
    kpi('Agentes abertos', fmtN(c.open), `${c.claude} Claude Code · ${c.codex} Codex`),
    kpi('Trabalhando', fmtN(c.working), c.working ? 'agora mesmo' : 'ninguém ocupado', c.working ? 'good' : ''),
    kpi('Precisam de você', fmtN(c.waiting), c.waiting ? 'tecla P abre o próximo' : 'nada pendente', c.waiting ? 'alert' : ''),
    kpi('Tempo de trabalho', duration(t.activeMinutes), plural(t.sessions ?? 0, 'sessão hoje', 'sessões hoje')),
    kpi('Tokens hoje', fmtTokens(t.tokens), 'entrada + saída'),
  ].join('');
}

function avatar(a) {
  const sub = a.subagents ? `<span class="sub" title="${esc(plural(a.subagents, 'subagente ativo', 'subagentes ativos'))}">${a.subagents}</span>` : '';
  return `<span class="avatar" data-provider="${esc(a.provider)}" aria-hidden="true">${a.provider === 'codex' ? 'CX' : 'CC'}${sub}</span>`;
}

function agentRow(a) {
  const act = a.activity;
  const meta = [PROVIDER[a.provider], a.accountLabel && a.accountLabel !== 'Principal' ? `conta ${a.accountLabel}` : '', prettyModel(a.model), a.subagents ? plural(a.subagents, 'subagente ativo', 'subagentes ativos') : '']
    .filter(Boolean)
    .map(esc)
    .join(' · ');
  const todos = a.todos
    ? ` · <span class="progress"><span class="meter" aria-hidden="true"><span style="width:${Math.round((a.todos.done / a.todos.total) * 100)}%"></span></span>${a.todos.done}/${a.todos.total} tarefas</span>`
    : '';
  const when = a.status === 'waiting' ? act?.at : a.lastAt;
  return `<li class="agent" tabindex="0" role="button" data-id="${esc(a.id)}" data-status="${esc(a.status)}" aria-current="${state.selected === a.id}" aria-label="${esc(`${a.title}: ${STATUS[a.status] ?? a.status}`)}">
    ${avatar(a)}
    <div class="a-main">
      <div class="a-title">${esc(a.title)}</div>
      ${act ? `<div class="a-act">${kindTag(act.kind)}<span class="text">${esc(act.text)}</span></div>` : ''}
      <div class="a-meta">${meta}${todos}</div>
    </div>
    <div class="a-side">${statusTag(a.status)}${timeTag(when)}</div>
  </li>`;
}

function renderProjects() {
  const el = $('#projects');
  const agents = visibleAgents();
  if (!agents.length) {
    const any = (state.snap?.agents ?? []).length;
    el.innerHTML = `<div class="empty">
      <svg class="mark" aria-hidden="true"><use href="#kwik-mark" /></svg>
      <h2>${any ? 'Nada com esse <em>filtro</em>.' : 'Ainda sem <em>agentes</em> por aqui.'}</h2>
      <p>${
        any
          ? 'Troque o filtro ou limpe a busca para ver todos.'
          : 'Abra o Claude Code ou o Codex em qualquer projeto. Cada projeto vira um cartão e cada sessão aparece com o que está fazendo, ao vivo.'
      }</p>
    </div>`;
    return;
  }
  el.innerHTML = groupByProject(agents)
    .map((g) => {
      const providers = [...new Set(g.agents.map((a) => a.provider))];
      const branches = [...new Set(g.agents.map((a) => a.branch).filter(Boolean))].slice(0, 2);
      return `<article class="project">
        <header>
          <div style="min-width:0">
            <p class="overline path" title="${esc(g.cwd ?? '')}">${esc(shortPath(g.cwd) || 'pasta desconhecida')}</p>
            <h2>${esc(g.project)}</h2>
          </div>
          <div class="tags">
            ${branches.map((b) => `<span class="tag soft" title="branch">${esc(b)}</span>`).join('')}
            ${providers.map((p) => `<span class="tag ${p === 'codex' ? 'solid' : ''}">${esc(PROVIDER[p])}</span>`).join('')}
            <span class="tag soft">${esc(plural(g.agents.length, 'agente', 'agentes'))}</span>
          </div>
        </header>
        <ul class="agents">${g.agents.map(agentRow).join('')}</ul>
      </article>`;
    })
    .join('');
}

function renderWaiting(list) {
  const el = $('#waiting');
  el.dataset.has = String(list.length > 0);
  if (!list.length) {
    el.innerHTML = `<p class="overline">Precisa de você</p><h3>Ninguém esperando você.</h3><p class="none">Quando um agente pedir uma permissão ou fizer uma pergunta, ele aparece aqui na hora.</p>`;
    return;
  }
  el.innerHTML = `<p class="overline">Precisa de você</p>
    <h3>${list.length === 1 ? 'Um agente parou e espera você.' : `${list.length} agentes pararam e esperam você.`}</h3>
    <ul class="wait-list">${list
      .map((a) => `<li><button data-id="${esc(a.id)}"><b>${esc(a.project)} · ${esc(PROVIDER[a.provider])}</b><span>${esc(a.waitingFor ?? 'responder no terminal')} · ${esc(ago(a.activity?.at ?? a.lastAt))}</span></button></li>`)
      .join('')}</ul>
    <p class="wait-hint">Responda no terminal do agente. A tecla <kbd>P</kbd> abre o próximo.</p>`;
}

function renderFeed(feed) {
  const el = $('#feed');
  if (!feed.length) {
    el.innerHTML = '<li class="none">Assim que um agente fizer algo, aparece aqui.</li>';
    return;
  }
  el.innerHTML = feed
    .slice(-30)
    .reverse()
    .map(
      (f) => `<li data-id="${esc(f.agentId)}"><time>${esc(clock(f.at))}</time><div><span class="who">${esc(f.project)} · ${esc(PROVIDER[f.provider] ?? '')}</span><span class="what">${esc(f.text)}</span></div></li>`,
    )
    .join('');
}

// ------------------------------------------------------------------ gráfico (uma série: ações por hora)

const niceCeil = (v) => {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};

function renderBars(el, hours, { height = 120 } = {}) {
  if (!el) return;
  const w = Math.max(240, Math.round(el.clientWidth || 320));
  const top = 14;
  const bottom = 20;
  const left = 0;
  const plotH = height - top - bottom;
  const slot = (w - left) / 24;
  const barW = Math.min(24, Math.max(3, slot - 2));
  const max = niceCeil(Math.max(1, ...hours));
  const nowH = new Date().getHours();
  const y = (v) => top + plotH - (v / max) * plotH;
  const bar = (x, v) => {
    const h = Math.max(0, (v / max) * plotH);
    if (h <= 0) return '';
    const r = Math.min(4, h, barW / 2);
    const y0 = top + plotH - h;
    return `M${x},${top + plotH}V${y0 + r}Q${x},${y0} ${x + r},${y0}H${x + barW - r}Q${x + barW},${y0} ${x + barW},${y0 + r}V${top + plotH}Z`;
  };
  let cols = '';
  for (let i = 0; i < 24; i++) {
    const v = hours[i] ?? 0;
    const x = left + i * slot + (slot - barW) / 2;
    cols += `<g data-h="${i}" data-v="${v}"><rect class="hit" x="${left + i * slot}" y="${top}" width="${slot}" height="${plotH + bottom}" />${v ? `<path class="col${i === nowH ? ' now' : ''}" d="${bar(x, v)}" />` : ''}</g>`;
  }
  const labels = [0, 6, 12, 18]
    .map((h) => `<text class="axis" x="${left + h * slot + slot / 2}" y="${height - 4}" text-anchor="middle">${h}h</text>`)
    .join('');
  const total = hours.reduce((a, b) => a + b, 0);
  el.innerHTML = `<svg viewBox="0 0 ${w} ${height}" role="img" aria-label="${esc(`Ações por hora hoje: ${fmtN(total)} no total`)}">
    <line class="grid" x1="0" x2="${w}" y1="${y(max)}" y2="${y(max)}" />
    <text class="axis" x="${w}" y="${y(max) - 4}" text-anchor="end">${fmtN(max)}</text>
    <line class="grid" x1="0" x2="${w}" y1="${top + plotH}" y2="${top + plotH}" />
    ${cols}${labels}
  </svg>
  <details class="chart-table"><summary>Ver em tabela</summary>${
    total
      ? `<div class="table-wrap"><table><thead><tr><th>Hora</th><th class="n">Ações</th></tr></thead><tbody>${hours
          .map((v, h) => (v ? `<tr><td>${h}h–${h + 1}h${h === nowH ? ' (agora)' : ''}</td><td class="n">${fmtN(v)}</td></tr>` : ''))
          .join('')}</tbody></table></div>`
      : '<p class="muted">Nenhuma ação registrada hoje.</p>'
  }</details>`;
  el.querySelectorAll('g[data-h]').forEach((g) => {
    g.addEventListener('mousemove', (e) => {
      const h = Number(g.dataset.h);
      showTip(e, `${h}h–${h + 1}h · ${plural(Number(g.dataset.v), 'ação', 'ações')}`);
    });
    g.addEventListener('mouseleave', hideTip);
  });
}

function showTip(e, text) {
  const tip = $('#tip');
  tip.textContent = text;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, e.clientX - r.width / 2))}px`;
  tip.style.top = `${Math.max(8, e.clientY - r.height - 12)}px`;
}
const hideTip = () => {
  $('#tip').hidden = true;
};

// ------------------------------------------------------------------ gaveta

async function openAgent(id) {
  state.selected = id;
  document.querySelectorAll('.agent').forEach((el) => el.setAttribute('aria-current', String(el.dataset.id === id)));
  await refreshDrawer(true);
}

let drawerBusy = false;
async function refreshDrawer(force = false) {
  if (!state.selected || (drawerBusy && !force)) return;
  drawerBusy = true;
  const id = state.selected;
  const d = await source.detail(id);
  drawerBusy = false;
  if (state.selected !== id) return;
  const a = state.snap?.agents.find((x) => x.id === id) ?? d?.agent;
  const el = $('#drawer');
  if (!a) {
    el.innerHTML = `<button class="btn icon close" data-act="close" aria-label="Fechar">✕</button><p class="overline">Sessão</p><h2>Esta sessão foi <em>encerrada</em>.</h2>`;
    el.hidden = false;
    return;
  }
  const closed = !state.snap?.agents.some((x) => x.id === id);
  const todos = d?.todos ?? [];
  const acts = d?.activities ?? [];
  const tokens = a.tokens ?? d?.tokens ?? { input: 0, output: 0, cache: 0 };
  el.innerHTML = `
    <button class="btn icon close" data-act="close" aria-label="Fechar (Esc)">✕</button>
    <p class="overline">${esc(PROVIDER[a.provider])} · conta ${esc(a.accountLabel ?? '')}</p>
    <h2>${esc(a.title)}</h2>
    <div class="row">${closed ? '<span class="status" data-s="idle"><i></i>Encerrada</span>' : statusTag(a.status)}
      <span class="muted">${esc(a.status === 'waiting' ? a.waitingFor : (a.activity?.text ?? ''))}</span></div>
    <div class="row">
      <span class="tag">${esc(a.project)}</span>
      ${a.branch ? `<span class="tag soft" title="branch">${esc(a.branch)}</span>` : ''}
      ${a.model ? `<span class="tag soft" title="${esc(a.model)}">${esc(prettyModel(a.model))}</span>` : ''}
      ${a.version ? `<span class="tag soft">v${esc(a.version)}</span>` : ''}
    </div>
    <div class="stats">
      <div class="stat"><div class="label">Pedidos seus</div><div class="value">${fmtN(a.prompts)}</div></div>
      <div class="stat"><div class="label">Ferramentas usadas</div><div class="value">${fmtN(a.tools)}</div></div>
      <div class="stat"><div class="label">Tokens (entrada + saída)</div><div class="value" title="${esc(`${fmtN(tokens.input)} entrada · ${fmtN(tokens.output)} saída · ${fmtN(tokens.cache)} lidos do cache`)}">${fmtTokens(tokens.input + tokens.output)}</div></div>
      <div class="stat"><div class="label">Aberta</div><div class="value">${esc(a.startedAt ? ago(a.startedAt).replace(/^há /, '') : '—')}</div></div>
    </div>
    <p class="mono muted">${esc(a.cwd ?? '')}</p>
    ${
      todos.length
        ? `<section><h3>Tarefas · ${todos.filter((t) => t.status === 'completed').length} de ${todos.length}</h3><ul class="todos">${todos
            .map((t) => `<li data-s="${esc(t.status)}">${esc(t.text)}</li>`)
            .join('')}</ul></section>`
        : ''
    }
    <section><h3>Linha do tempo</h3>
      ${
        acts.length
          ? `<ol class="timeline">${acts.map((x) => `<li><time>${esc(clock(x.at))}</time><div>${kindTag(x.kind)}<span class="t">${esc(x.text)}</span></div></li>`).join('')}</ol>`
          : '<p class="muted">Nada registrado ainda.</p>'
      }
    </section>
    <div class="actions">
      <button class="btn cta" data-act="convo">Ver conversa <kbd>T</kbd></button>
      ${a.cwd ? '<button class="btn ghost" data-act="copy">Copiar pasta</button>' : ''}
    </div>`;
  el.hidden = false;
  el.dataset.cwd = a.cwd ?? '';
}

function closeDrawer() {
  state.selected = undefined;
  $('#drawer').hidden = true;
  document.querySelectorAll('.agent[aria-current="true"]').forEach((el) => el.setAttribute('aria-current', 'false'));
}

// ------------------------------------------------------------------ folhas

function openSheet(kind, html) {
  state.sheet = kind;
  $('#sheet').innerHTML = `<button class="btn icon close" data-act="sheet-close" aria-label="Fechar (Esc)">✕</button>${html}`;
  $('#overlay').hidden = false;
  $('#sheet').focus?.();
}

function closeSheet() {
  state.sheet = undefined;
  $('#overlay').hidden = true;
}

async function openConversation(id = state.selected) {
  if (!id) return toast('Escolha um agente', 'Clique num agente e aperte T para ver a conversa.', undefined, 'ok');
  const c = await source.conversation(id);
  if (!c) return toast('Conversa indisponível', 'Essa sessão não está mais sendo lida.', undefined, 'ok');
  const who = { user: 'Você', assistant: PROVIDER[c.provider] ?? 'Agente', tool: '' };
  openSheet(
    'convo',
    `<p class="overline">${esc(PROVIDER[c.provider])} · ${esc(c.project)}</p>
     <h2 class="sheet-title">${esc(c.title)}</h2>
     <p class="lede">Somente leitura: as últimas mensagens desta sessão. Para responder, use o terminal do agente.</p>
     <div class="convo">${
       c.messages.length
         ? c.messages
             .map((m) =>
               m.role === 'tool'
                 ? `<div class="msg tool"><span class="who">${esc(KIND[m.kind] ?? 'Ferramenta')}</span>${esc(m.text)}</div>`
                 : `<div class="msg ${m.role === 'user' ? 'user' : ''}"><span class="who">${esc(who[m.role] ?? m.role)}${m.at ? ` · ${esc(clock(m.at))}` : ''}</span>${esc(m.text)}</div>`,
             )
             .join('')
         : '<p class="muted">Nenhuma mensagem ainda.</p>'
     }</div>`,
  );
  const sheet = $('#sheet');
  sheet.scrollTop = sheet.scrollHeight;
}

async function openDay() {
  const d = await source.day();
  if (!d) return toast('Meu dia indisponível', 'O painel não respondeu agora.', undefined, 'ok');
  const date = new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
  openSheet(
    'day',
    `<p class="overline">Meu dia · ${esc(date)}</p>
     <h2 class="sheet-title">Seu dia em <em>números</em>.</h2>
     <p class="lede">Tempo de trabalho = minutos em que algum agente fez algo. Tokens = entrada + saída (sem a leitura do cache).</p>
     <div class="kpis">
       ${kpi('Tempo de trabalho', duration(d.activeMinutes), plural(d.sessions, 'sessão', 'sessões'))}
       ${kpi('Pedidos seus', fmtN(d.prompts), 'mensagens que você mandou')}
       ${kpi('Ferramentas', fmtN(d.tools), 'leituras, edições, comandos…')}
       ${kpi('Tokens', fmtTokens(d.tokens), 'entrada + saída')}
       ${kpi('Projetos', fmtN(d.projects), 'com atividade hoje')}
     </div>
     <p class="overline">Atividade por hora</p>
     <div class="chart" id="day-chart"></div>
     <p class="overline">Por projeto</p>
     ${
       d.projectsDetail?.length
         ? `<div class="table-wrap"><table>
       <thead><tr><th>Projeto</th><th>Agentes</th><th class="n">Sessões</th><th class="n">Pedidos</th><th class="n">Ferramentas</th><th class="n">Tokens</th><th class="n">Tempo</th></tr></thead>
       <tbody>${d.projectsDetail
         .map(
           (p) => `<tr>
             <td><b>${esc(p.project)}</b><div class="muted mono">${esc(shortPath(p.cwd))}</div></td>
             <td>${p.providers.map((x) => `<span class="tag ${x === 'codex' ? 'solid' : ''}">${esc(PROVIDER[x])}</span>`).join(' ')}</td>
             <td class="n">${fmtN(p.sessions)}</td><td class="n">${fmtN(p.prompts)}</td><td class="n">${fmtN(p.tools)}</td>
             <td class="n">${fmtTokens(p.tokens)}</td><td class="n">${esc(duration(p.minutes))}</td></tr>`,
         )
         .join('')}</tbody></table></div>`
         : '<p class="muted">Nenhuma atividade registrada hoje.</p>'
     }`,
  );
  renderBars($('#day-chart'), d.hours ?? [], { height: 170 });
}

function openHelp() {
  openSheet(
    'help',
    `<p class="overline">Ajuda</p>
     <h2 class="sheet-title">Como ler o <em>painel</em>.</h2>
     <p class="lede">Cada projeto aberto vira um cartão. Cada sessão do Claude Code (CC) ou do Codex (CX) aparece dentro dele, com o que está fazendo agora.</p>
     <div class="help-grid">
       <div><h3>Estados</h3><dl>
         <dt>${statusTag('working')}</dt><dd>Fazendo algo: lendo, editando, rodando comandos.</dd>
         <dt>${statusTag('waiting')}</dt><dd>Parou e espera você: uma permissão ou uma pergunta no terminal.</dd>
         <dt>${statusTag('shell')}</dt><dd>Terminou o turno, mas deixou um comando rodando.</dd>
         <dt>${statusTag('idle')}</dt><dd>Terminou e espera o próximo pedido.</dd>
       </dl></div>
       <div><h3>Atalhos</h3><dl>
         <dt><kbd>/</kbd></dt><dd>Buscar agente ou projeto</dd>
         <dt><kbd>P</kbd></dt><dd>Abrir o próximo agente que precisa de você</dd>
         <dt><kbd>T</kbd></dt><dd>Ver a conversa do agente aberto</dd>
         <dt><kbd>M</kbd></dt><dd>Meu dia: tempo, pedidos e tokens por projeto</dd>
         <dt><kbd>D</kbd></dt><dd>Tema claro ou escuro</dd>
         <dt><kbd>Esc</kbd></dt><dd>Fechar</dd>
         <dt><kbd>?</kbd></dt><dd>Esta ajuda</dd>
       </dl></div>
     </div>
     <p class="lede">Quer só ver como fica? Abra <a href="/?mock=1">o modo demonstração</a>. O painel só lê arquivos do seu computador: nada sai daqui.</p>`,
  );
}

// ------------------------------------------------------------------ avisos

function toast(title, text, onClick, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b>${esc(text)}`;
  el.addEventListener('click', () => {
    el.remove();
    onClick?.();
  });
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 7000);
}

function notifyWaiting(snap) {
  const now = new Set();
  for (const a of snap.agents) {
    if (a.status !== 'waiting') continue;
    now.add(a.id);
    if (!state.first && !state.seenWaiting.has(a.id)) toast(`Precisa de você · ${a.project}`, a.waitingFor ?? 'responder no terminal', () => openAgent(a.id));
  }
  state.seenWaiting = now;
}

// ------------------------------------------------------------------ eventos

function setConn(s) {
  const el = $('#conn');
  el.dataset.state = s;
  el.querySelector('span').textContent = MOCK ? 'Demonstração' : s === 'on' ? `Conectado${state.snap ? ` · v${state.snap.meta.version}` : ''}` : s === 'off' ? 'Sem conexão' : 'Reconectando…';
}

function onSnapshot(snap) {
  notifyWaiting(snap);
  state.snap = snap;
  state.first = false;
  setConn('on');
  render();
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('kwik:theme', next);
  } catch {
    // sem armazenamento: vale só nesta aba
  }
}

function nextWaiting() {
  const list = (state.snap?.agents ?? []).filter((a) => a.status === 'waiting');
  if (!list.length) return toast('Ninguém esperando você', 'Quando um agente pedir algo, ele aparece aqui.', undefined, 'ok');
  const i = list.findIndex((a) => a.id === state.selected);
  openAgent(list[(i + 1) % list.length].id);
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act], [data-id], #overlay');
  if (!t) return;
  const act = t.dataset.act;
  if (act === 'close') return closeDrawer();
  if (act === 'sheet-close') return closeSheet();
  if (act === 'convo') return openConversation();
  if (act === 'copy') {
    const cwd = $('#drawer').dataset.cwd;
    navigator.clipboard?.writeText(cwd).then(
      () => toast('Pasta copiada', cwd, undefined, 'ok'),
      () => toast('Não deu para copiar', cwd, undefined, 'ok'),
    );
    return;
  }
  if (t.id === 'overlay' && e.target === t) return closeSheet();
  if (t.dataset.id && !t.closest('#sheet')) openAgent(t.dataset.id);
});

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea');
  if (e.key === 'Escape') {
    if (state.sheet) return closeSheet();
    if (state.selected) return closeDrawer();
    if (typing) e.target.blur();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('agent')) {
    e.preventDefault();
    return openAgent(e.target.dataset.id);
  }
  const k = e.key.toLowerCase();
  if (e.key === '/') {
    e.preventDefault();
    $('#search').focus();
  } else if (e.key === '?') openHelp();
  else if (k === 'p') nextWaiting();
  else if (k === 't') openConversation();
  else if (k === 'm') openDay();
  else if (k === 'd') toggleTheme();
});

$('#search').addEventListener('input', (e) => {
  state.query = e.target.value;
  renderProjects();
});

$('#filter').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  state.filter = b.dataset.f;
  $('#filter')
    .querySelectorAll('button')
    .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderProjects();
});

$('#btn-theme').addEventListener('click', toggleTheme);
$('#btn-help').addEventListener('click', openHelp);
$('#btn-day').addEventListener('click', openDay);

// Atualiza os "há X min" sem redesenhar tudo.
setInterval(() => {
  document.querySelectorAll('time[data-at]').forEach((t) => {
    t.textContent = ago(Number(t.dataset.at));
  });
}, 5000);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.snap && renderBars($('#chart'), state.snap.today?.hours ?? [], { height: 120 }), 120);
});

if (MOCK) $('#demo-banner').hidden = false;
source.connect(onSnapshot, setConn);

// ------------------------------------------------------------------ modo demonstração (?mock=1)

function createMock() {
  const rnd = (n) => Math.floor(Math.random() * n);
  const cap = (t) => t[0].toUpperCase() + t.slice(1);
  const pick = (arr) => arr[rnd(arr.length)];
  const base = '/Users/voce/kwik';
  const minutesAgo = (m) => Date.now() - m * 60_000;
  const agents = [
    { id: 'm1', provider: 'claude', accountLabel: 'Principal', cwd: `${base}/site-kwik`, branch: 'main', model: 'claude-opus-4-1-20250805', title: 'Landing page do split payment', status: 'working', subagents: 0, startedAt: minutesAgo(48), prompts: 6, tools: 87 },
    { id: 'm2', provider: 'codex', accountLabel: 'Principal', cwd: `${base}/site-kwik`, branch: 'main', model: 'gpt-5-codex', title: 'Revisar os textos da página de serviços', status: 'idle', subagents: 0, startedAt: minutesAgo(95), prompts: 3, tools: 22 },
    { id: 'm3', provider: 'claude', accountLabel: 'Principal', cwd: `${base}/robo-notas-fiscais`, branch: 'feat/nfse', model: 'claude-sonnet-4-5', title: 'Automatizar a emissão de notas do MEI', status: 'waiting', waitingFor: 'aprovar o comando npm run emitir -- --homologacao', subagents: 0, startedAt: minutesAgo(31), prompts: 4, tools: 41 },
    { id: 'm4', provider: 'claude', accountLabel: 'trabalho', cwd: `${base}/portal-clientes`, branch: 'main', model: 'claude-opus-4-1-20250805', title: 'Conciliação bancária de setembro', status: 'working', subagents: 2, startedAt: minutesAgo(122), prompts: 9, tools: 214, todos: { done: 3, total: 5 } },
    { id: 'm5', provider: 'codex', accountLabel: 'Principal', cwd: `${base}/relatorios-dre`, branch: 'ajuste-setembro', model: 'gpt-5-codex', title: 'Gerar o DRE mensal em PDF', status: 'working', subagents: 0, startedAt: minutesAgo(17), prompts: 2, tools: 35 },
    { id: 'm6', provider: 'claude', accountLabel: 'Principal', cwd: `${base}/relatorios-dre`, branch: 'ajuste-setembro', model: 'claude-sonnet-4-5', title: 'Comparar Simples Nacional e Lucro Presumido', status: 'shell', subagents: 0, startedAt: minutesAgo(66), prompts: 5, tools: 58 },
  ];
  const pool = {
    m1: [['edit', 'Editando Hero.tsx'], ['read', 'Lendo split-payment.md'], ['test', 'Rodando testes: vitest run'], ['edit', 'Editando simulador.ts'], ['web', 'Pesquisando "split payment IBS CBS 2027"']],
    m2: [['read', 'Lendo servicos.html'], ['edit', 'Editando servicos.html']],
    m3: [['terminal', 'Rodando: npm run emitir -- --homologacao'], ['read', 'Lendo nfse/schema.xsd']],
    m4: [['agent', 'Chamou um subagente: conferir os lançamentos do Itaú'], ['search', 'Procurando "tarifa bancária"'], ['edit', 'Editando conciliacao.py'], ['test', 'Rodando testes: pytest -q'], ['plan', 'Atualizando a lista de tarefas']],
    m5: [['terminal', 'Rodando: python gerar_dre.py --mes 09'], ['edit', 'Editando modelo-dre.html'], ['read', 'Lendo balancete-setembro.csv']],
    m6: [['terminal', 'Esperando: npm run comparar-regimes (3 min)'], ['read', 'Lendo tabela-anexo-iii.json']],
  };
  const prompts = ['Ajusta o texto do botão para "Fale com a KWIK"', 'Roda os testes de novo, por favor', 'Agora gera o PDF de agosto também', 'Confere se a alíquota do Anexo III está certa'];
  for (const a of agents) {
    const [kind, text] = pool[a.id][0];
    a.account = a.accountLabel;
    a.project = a.cwd.split('/').at(-1);
    a.activity = a.status === 'waiting' ? { kind: 'wait', text: cap(a.waitingFor), at: minutesAgo(1.5) } : { kind, text, at: Date.now() - rnd(40_000) };
    a.lastAt = a.activity.at;
    a.tokens = { input: 40_000 + rnd(900_000), output: 8_000 + rnd(120_000), cache: 2_000_000 + rnd(9_000_000) };
  }
  const hour = new Date().getHours();
  const hours = Array.from({ length: 24 }, (_, h) => {
    if (h > hour) return 0;
    const work = (h >= 8 && h <= 12) || (h >= 14 && h <= 19) ? 1 : h >= 7 && h <= 22 ? 0.35 : 0.05;
    return Math.round(work * (20 + rnd(40)));
  });
  const feed = [];
  const snap = () => {
    const prompts = agents.reduce((s, a) => s + a.prompts, 0) + 18;
    const tools = hours.reduce((s, v) => s + v, 0);
    return {
      meta: { name: 'KWIK Agentes', version: 'demo', now: Date.now(), docker: false, hooks: {} },
      accounts: [],
      agents: agents.map((a) => ({ ...a })),
      feed: feed.slice(-40),
      today: { date: '', sessions: 11, projects: 4, prompts, tools, tokens: 2_340_000 + tools * 900, hours: [...hours], activeMinutes: 247 + Math.floor(tools / 40) },
    };
  };
  const push = (a, kind, text) => feed.push({ at: Date.now(), agentId: a.id, provider: a.provider, project: a.project, title: a.title, kind, text });
  push(agents[2], 'wait', `Precisa de você: ${agents[2].waitingFor}`);
  push(agents[0], 'edit', 'Editando Hero.tsx');
  push(agents[3], 'agent', 'Chamou um subagente: conferir os lançamentos do Itaú');

  return {
    connect(onSnap, onConn) {
      onConn('on');
      onSnap(snap());
      setInterval(() => {
        const a = pick(agents.filter((x) => x.status === 'working'));
        if (a) {
          const [kind, text] = pick(pool[a.id]);
          a.activity = { kind, text, at: Date.now() };
          a.lastAt = Date.now();
          a.tools++;
          a.tokens.input += 1200 + rnd(9000);
          a.tokens.output += 200 + rnd(2000);
          hours[hour]++;
          push(a, kind, text);
        }
        const r = Math.random();
        if (r < 0.12) {
          const idle = agents.find((x) => x.status === 'idle');
          if (idle) {
            idle.status = 'working';
            idle.prompts++;
            const p = pick(prompts);
            idle.activity = { kind: 'prompt', text: `Você pediu: ${p}`, at: Date.now() };
            push(idle, 'prompt', `Você pediu: ${p}`);
          }
        } else if (r < 0.2) {
          const w = pick(agents.filter((x) => x.status === 'working' && x.id !== 'm4'));
          if (w) {
            w.status = 'idle';
            push(w, 'done', 'Terminou e está livre');
          }
        } else if (r < 0.24) {
          const w = agents.find((x) => x.status === 'waiting');
          if (w) {
            w.status = 'working';
            w.waitingFor = undefined;
            w.activity = { kind: 'terminal', text: 'Rodando: npm run emitir -- --homologacao', at: Date.now() };
            push(w, 'terminal', 'Você aprovou: rodando o comando');
          } else {
            const x = pick(agents.filter((y) => y.status === 'working'));
            if (x) {
              x.status = 'waiting';
              x.waitingFor = 'responder uma pergunta';
              x.activity = { kind: 'wait', text: 'Responder uma pergunta', at: Date.now() };
              push(x, 'wait', 'Precisa de você: responder uma pergunta');
            }
          }
        }
        onSnap(snap());
      }, 2200);
    },
    async detail(id) {
      const a = agents.find((x) => x.id === id);
      if (!a) return undefined;
      const acts = pool[id].concat(pool[id]).map(([kind, text], i) => ({ kind, text, at: Date.now() - (i + 1) * 95_000 }));
      acts.unshift({ kind: 'prompt', text: `Você pediu: ${a.title}`, at: a.startedAt });
      return {
        agent: { ...a },
        activities: acts.sort((x, y) => y.at - x.at),
        todos:
          id === 'm4'
            ? [
                { text: 'Importar o extrato do Itaú (OFX)', status: 'completed' },
                { text: 'Casar lançamentos com as notas', status: 'completed' },
                { text: 'Separar tarifas bancárias', status: 'completed' },
                { text: 'Conferir diferenças acima de R$ 50,00', status: 'in_progress' },
                { text: 'Gerar o relatório para o cliente', status: 'pending' },
              ]
            : [],
        tokens: a.tokens,
      };
    },
    async conversation(id) {
      const a = agents.find((x) => x.id === id);
      if (!a) return undefined;
      return {
        id,
        title: a.title,
        provider: a.provider,
        project: a.project,
        messages: [
          { role: 'user', at: a.startedAt, text: `${a.title}. Usa os arquivos da pasta dados/ e me mostra o resultado no fim.` },
          { role: 'assistant', at: a.startedAt + 20_000, text: 'Combinado. Primeiro vou ler os arquivos para entender o formato, depois faço as mudanças e rodo os testes.' },
          ...pool[id].map(([kind, text], i) => ({ role: 'tool', kind, text, at: a.startedAt + (i + 2) * 30_000 })),
          { role: 'assistant', at: Date.now() - 60_000, text: 'Pronto: a primeira parte está feita. Pagou R$ 100: R$ 75 na sua conta, R$ 25 direto ao Fisco. Quer que eu siga para a próxima?' },
        ],
      };
    },
    async day() {
      const s = snap();
      const mk = (project, providers, sessions, p, t, tok, min) => ({ project, cwd: `${base}/${project}`, providers, sessions, prompts: p, tools: t, tokens: tok, minutes: min });
      return {
        ...s.today,
        projectsDetail: [
          mk('portal-clientes', ['claude'], 3, 14, 402, 980_000, 118),
          mk('site-kwik', ['claude', 'codex'], 4, 12, 233, 610_000, 74),
          mk('relatorios-dre', ['claude', 'codex'], 3, 9, 128, 520_000, 41),
          mk('robo-notas-fiscais', ['claude'], 1, 4, 41, 230_000, 14),
        ],
      };
    },
  };
}
