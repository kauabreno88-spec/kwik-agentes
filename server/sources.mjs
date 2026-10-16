// Fontes de dados (somente leitura):
//
// Claude Code, por conta:
//   <conta>/sessions/<pid>.json             sessões ABERTAS e o status (ocupado, ocioso, esperando você)
//   <conta>/projects/<pasta>/<sessão>.jsonl  o que cada sessão fez (transcript)
//   <conta>/projects/<pasta>/<sessão>/subagents/*.jsonl  subagentes
// Codex, por pasta:
//   <pasta>/sessions/AAAA/MM/DD/rollout-*.jsonl  o que cada sessão fez (rollout)
//
// Nada aqui escreve em disco nem lê credenciais.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { JsonlReader } from './jsonl.mjs';
import { SessionState } from './session.mjs';
import { encodeCwd, num, rec, startOfDay, str } from './util.mjs';

const DAY_SCAN_MS = 30_000;
/** Sem registro (Claude Code antigo) ou sem hook: sessão com escrita nos últimos 15 min conta como aberta. */
export const RECENT_OPEN_MS = 15 * 60_000;
/** Subagente com escrita no último 1,5 min conta como ativo. */
const SUBAGENT_ACTIVE_MS = 90_000;

function statSafe(p) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

function listDir(p) {
  try {
    return readdirSync(p);
  } catch {
    return undefined;
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Valida um registro de sessão aberta do Claude Code (<conta>/sessions/<pid>.json). */
export function parseRegistry(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!rec(j)) return undefined;
  const pid = num(j.pid);
  const sessionId = str(j.sessionId);
  const cwd = str(j.cwd);
  if (pid === undefined || !sessionId || !cwd) return undefined;
  return {
    pid,
    sessionId,
    cwd,
    status: str(j.status),
    waitingFor: str(j.waitingFor),
    // Nome dado por você (/rename); o derivado automaticamente ("user-e6") não diz nada.
    name: j.nameSource === 'derived' ? undefined : str(j.name),
    version: str(j.version),
    startedAt: num(j.startedAt),
    updatedAt: num(j.updatedAt) ?? num(j.statusUpdatedAt),
  };
}

/** Status do registro -> status do painel. */
export function registryStatus(e) {
  switch (e?.status) {
    case 'busy':
      return 'working';
    case 'idle':
      return 'idle';
    case 'shell':
      return 'shell';
    case 'waiting':
      return 'waiting';
    default:
      return undefined;
  }
}

class Tracked {
  constructor(session, path) {
    this.session = session;
    this.reader = new JsonlReader(path);
    this.size = -1;
    this.mtimeMs = 0;
  }

  /** Lê o que mudou. `live` = depois da carga inicial (gera eventos para o feed). */
  refresh(st, apply) {
    if (st && st.size === this.size && st.mtimeMs === this.mtimeMs) return false;
    const first = this.size < 0;
    const { lines, head, reset } = this.reader.read();
    if (reset) this.session.days.clear();
    for (const j of head) apply(j, false);
    for (const j of lines) apply(j, !first);
    this.size = st?.size ?? this.reader.size;
    this.mtimeMs = st?.mtimeMs ?? this.reader.mtimeMs;
    return lines.length > 0 || head.length > 0;
  }
}

// ==================================================================== Claude Code

export class ClaudeSource {
  constructor(account, { inDocker = false } = {}) {
    this.account = account;
    this.inDocker = inDocker;
    this.tracked = new Map(); // caminho do transcript -> Tracked
    this.registryCache = new Map(); // arquivo -> {mtimeMs, size, entry}
    this.pathById = new Map(); // sessionId -> caminho do transcript
    this.lastDayScan = 0;
    this.status = { ok: true };
    this.hasRegistry = false;
  }

  get projectsDir() {
    return join(this.account.dir, 'projects');
  }

  readRegistry(now) {
    const dir = join(this.account.dir, 'sessions');
    const names = listDir(dir);
    this.hasRegistry = !!names;
    if (!names) return [];
    const out = [];
    const seen = new Set();
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = join(dir, name);
      seen.add(file);
      const st = statSafe(file);
      if (!st) continue;
      let c = this.registryCache.get(file);
      if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
        let entry;
        try {
          entry = parseRegistry(readFileSync(file, 'utf8'));
        } catch {
          entry = undefined;
        }
        c = { mtimeMs: st.mtimeMs, size: st.size, entry };
        this.registryCache.set(file, c);
      }
      const e = c.entry;
      if (!e) continue;
      if (this.inDocker) {
        // No container os PIDs são do computador: um registro velho demais é de um processo que já morreu.
        if (now - Math.max(st.mtimeMs, e.updatedAt ?? 0) > 24 * 3600_000) continue;
      } else if (!pidAlive(e.pid)) continue;
      out.push({ ...e, fileMtimeMs: st.mtimeMs });
    }
    for (const f of this.registryCache.keys()) if (!seen.has(f)) this.registryCache.delete(f);
    return out;
  }

  findTranscript(sessionId, cwd) {
    const cached = this.pathById.get(sessionId);
    if (cached && statSafe(cached)) return cached;
    if (cwd) {
      const p = join(this.projectsDir, encodeCwd(cwd), `${sessionId}.jsonl`);
      if (statSafe(p)) {
        this.pathById.set(sessionId, p);
        return p;
      }
    }
    for (const d of listDir(this.projectsDir) ?? []) {
      const p = join(this.projectsDir, d, `${sessionId}.jsonl`);
      if (statSafe(p)) {
        this.pathById.set(sessionId, p);
        return p;
      }
    }
    return undefined;
  }

  track(path) {
    let t = this.tracked.get(path);
    if (!t) {
      const sessionId = basename(path, '.jsonl');
      t = new Tracked(new SessionState({ provider: 'claude', account: this.account, sessionId, path }), path);
      this.tracked.set(path, t);
      this.pathById.set(sessionId, path);
    }
    return t;
  }

  /** Transcripts com escrita hoje (para o "Meu dia" e para achar sessões abertas sem registro). */
  scanDay(now) {
    const since = startOfDay(now);
    const keep = new Set();
    for (const d of listDir(this.projectsDir) ?? []) {
      const pdir = join(this.projectsDir, d);
      for (const f of listDir(pdir) ?? []) {
        if (!f.endsWith('.jsonl')) continue;
        const p = join(pdir, f);
        const st = statSafe(p);
        if (!st || !st.isFile() || st.mtimeMs < since) continue;
        keep.add(p);
        this.track(p);
      }
    }
    return keep;
  }

  subagentsActive(path, now) {
    const dir = join(path.slice(0, -'.jsonl'.length), 'subagents');
    let n = 0;
    const walk = (d, depth) => {
      for (const f of listDir(d) ?? []) {
        const p = join(d, f);
        const st = statSafe(p);
        if (!st) continue;
        if (st.isDirectory() && depth < 2) walk(p, depth + 1);
        else if (f.endsWith('.jsonl') && now - st.mtimeMs < SUBAGENT_ACTIVE_MS) n++;
      }
    };
    walk(dir, 0);
    return n;
  }

  /** Um ciclo: devolve as sessões abertas (com o registro) e todas as acompanhadas hoje. */
  poll(now = Date.now(), liveHint) {
    if (!statSafe(this.account.dir)) {
      this.status = { ok: false, error: 'pasta não encontrada' };
      return { open: [], all: [] };
    }
    const registry = this.readRegistry(now);
    let dayFiles;
    if (now - this.lastDayScan > DAY_SCAN_MS) {
      this.lastDayScan = now;
      dayFiles = this.scanDay(now);
    }
    const open = [];
    const openPaths = new Set();
    for (const e of registry) {
      const path = this.findTranscript(e.sessionId, e.cwd);
      const t = path ? this.track(path) : undefined;
      if (t) openPaths.add(path);
      open.push({ entry: e, tracked: t });
    }
    // Atualiza os abertos sempre; os outros, só quando o arquivo mudou (o stat é barato).
    const apply = (t) => (j, live) => t.session.applyClaude(j, live);
    for (const [path, t] of this.tracked) {
      const st = statSafe(path);
      if (!st) {
        if (!openPaths.has(path)) this.tracked.delete(path);
        continue;
      }
      t.refresh(st, apply(t));
      t.session.cwd ??= open.find((o) => o.tracked === t)?.entry.cwd;
    }
    // Sem registro (Claude Code antigo): escrita recente ou hook de sessão aberta = aberta.
    if (!this.hasRegistry) {
      for (const [path, t] of this.tracked) {
        const recent = now - t.mtimeMs < RECENT_OPEN_MS;
        if (recent || liveHint?.(t.session.sessionId)) {
          openPaths.add(path);
          open.push({ entry: undefined, tracked: t });
        }
      }
    }
    // Esquece o que não é de hoje nem está aberto.
    if (dayFiles) {
      for (const path of this.tracked.keys()) if (!dayFiles.has(path) && !openPaths.has(path)) this.tracked.delete(path);
    }
    for (const o of open) o.subagents = o.tracked ? this.subagentsActive(o.tracked.session.path, now) : 0;
    this.status = { ok: true, registry: this.hasRegistry };
    return { open, all: [...this.tracked.values()] };
  }

  /** Força reler na próxima volta (um hook avisou que algo mudou). */
  nudge() {
    this.lastDayScan = Math.min(this.lastDayScan, Date.now() - DAY_SCAN_MS + 1500);
  }
}

// ==================================================================== Codex

/** Pastas de data (AAAA/MM/DD) dos últimos `days` dias, no fuso local e em UTC. */
function dateDirs(now, days) {
  const set = new Set();
  for (let i = 0; i < days; i++) {
    const t = new Date(now - i * 86_400_000);
    const p = (n) => String(n).padStart(2, '0');
    set.add(`${t.getFullYear()}/${p(t.getMonth() + 1)}/${p(t.getDate())}`);
    set.add(`${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())}`);
  }
  return [...set];
}

const THREAD_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export class CodexSource {
  constructor(account) {
    this.account = account;
    this.tracked = new Map();
    this.lastScan = 0;
    this.status = { ok: true };
    this.wanted = new Set(); // ids de sessão vistos em hooks que ainda não achamos
  }

  get sessionsDir() {
    return join(this.account.dir, 'sessions');
  }

  track(path) {
    let t = this.tracked.get(path);
    if (!t) {
      const id = THREAD_IN_NAME.exec(path)?.[1] ?? basename(path, '.jsonl');
      t = new Tracked(new SessionState({ provider: 'codex', account: this.account, sessionId: id, path }), path);
      this.tracked.set(path, t);
    }
    return t;
  }

  scan(now) {
    const since = Math.min(startOfDay(now), now - 3 * 3600_000);
    const days = this.wanted.size ? 7 : 3;
    const keep = new Set();
    for (const d of dateDirs(now, days)) {
      const dir = join(this.sessionsDir, d);
      for (const f of listDir(dir) ?? []) {
        if (!f.endsWith('.jsonl')) continue;
        const p = join(dir, f);
        const id = THREAD_IN_NAME.exec(f)?.[1];
        const st = statSafe(p);
        if (!st) continue;
        if (st.mtimeMs >= since || (id && this.wanted.has(id))) {
          keep.add(p);
          this.track(p);
          if (id) this.wanted.delete(id);
        }
      }
    }
    for (const p of this.tracked.keys()) if (!keep.has(p)) this.tracked.delete(p);
  }

  poll(now = Date.now(), liveHint) {
    if (!statSafe(this.account.dir)) {
      this.status = { ok: false, error: 'pasta não encontrada' };
      return { open: [], all: [] };
    }
    if (now - this.lastScan > 5_000) {
      this.lastScan = now;
      this.scan(now);
    }
    const open = [];
    for (const [path, t] of this.tracked) {
      const st = statSafe(path);
      if (!st) continue;
      t.refresh(st, (j, live) => t.session.applyCodex(j, live));
      const s = t.session;
      if (s.hidden || s.isSubagent) continue;
      const hint = liveHint?.(s.sessionId);
      if (hint === 'ended') continue;
      if (now - t.mtimeMs < RECENT_OPEN_MS || hint === 'open') open.push({ entry: undefined, tracked: t, subagents: 0 });
    }
    // Subagentes do Codex: conta os ativos de cada sessão principal.
    for (const t of this.tracked.values()) {
      const s = t.session;
      if (!s.isSubagent || now - t.mtimeMs > SUBAGENT_ACTIVE_MS) continue;
      const parent = open.find((o) => o.tracked.session.cwd === s.cwd);
      if (parent) parent.subagents++;
    }
    this.status = { ok: true };
    return { open, all: [...this.tracked.values()].filter((t) => !t.session.hidden && !t.session.isSubagent) };
  }

  /** Um hook falou de uma sessão que ainda não conhecemos: procura na próxima volta. */
  want(sessionId) {
    if (![...this.tracked.values()].some((t) => t.session.sessionId === sessionId)) {
      this.wanted.add(sessionId);
      this.lastScan = 0;
    }
  }
}
