// Leitura incremental de arquivos JSONL que só crescem (transcripts do Claude Code e rollouts do Codex).
// Na primeira leitura, um arquivo grande é lido só do fim (as linhas antigas não mudam o estado atual);
// depois, só os bytes novos. Uma linha cortada no fim espera a próxima leitura.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** Na primeira leitura, até quanto do fim do arquivo entra. */
export const INITIAL_TAIL_BYTES = 12 * 1024 * 1024;
/** Quanto do começo entra antes do fim, num arquivo grande (título e metadados ficam lá). */
export const HEAD_BYTES = 256 * 1024;
/** Máximo lido de uma vez num ciclo (o resto vem no próximo). */
const MAX_CHUNK = 8 * 1024 * 1024;

export class JsonlReader {
  constructor(path) {
    this.path = path;
    this.offset = 0;
    this.rest = Buffer.alloc(0);
    this.size = 0;
    this.mtimeMs = 0;
    this.started = false;
  }

  /**
   * Lê o que chegou desde a última vez. Devolve {lines, reset, head}: `head` (só na primeira leitura de arquivo
   * grande) são linhas do começo; `reset` indica que o arquivo encolheu e foi relido.
   */
  read() {
    let fd;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return { lines: [], head: [], reset: false, missing: true };
    }
    try {
      const st = fstatSync(fd);
      this.mtimeMs = st.mtimeMs;
      let reset = false;
      if (st.size < this.offset) {
        this.offset = 0;
        this.rest = Buffer.alloc(0);
        this.started = false;
        reset = true;
      }
      const head = [];
      if (!this.started) {
        this.started = true;
        if (st.size > INITIAL_TAIL_BYTES) {
          head.push(...parseLines(readRange(fd, 0, HEAD_BYTES).toString('utf8'), true));
          this.offset = st.size - INITIAL_TAIL_BYTES;
          // descarta a primeira linha (provavelmente cortada no meio)
          const nl = readRange(fd, this.offset, 64 * 1024).indexOf(0x0a);
          this.offset += nl >= 0 ? nl + 1 : 0;
        }
      }
      this.size = st.size;
      if (st.size <= this.offset) return { lines: [], head, reset };
      const len = Math.min(st.size - this.offset, MAX_CHUNK);
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, this.offset);
      this.offset += n;
      const data = this.rest.length ? Buffer.concat([this.rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      const cut = data.lastIndexOf(0x0a);
      if (cut < 0) {
        this.rest = Buffer.from(data);
        return { lines: [], head, reset };
      }
      this.rest = Buffer.from(data.subarray(cut + 1));
      return { lines: parseLines(data.subarray(0, cut).toString('utf8')), head, reset };
    } finally {
      closeSync(fd);
    }
  }
}

function readRange(fd, start, len) {
  const buf = Buffer.alloc(len);
  const n = readSync(fd, buf, 0, len, start);
  return buf.subarray(0, n);
}

/** Converte texto em objetos JSON (linhas inválidas são ignoradas). `dropLast` ignora a última linha (cortada). */
export function parseLines(text, dropLast = false) {
  const parts = text.split('\n');
  if (dropLast) parts.pop();
  const out = [];
  for (const raw of parts) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // linha inválida: ignora
    }
  }
  return out;
}
