// Minimal UCI client for a native Stockfish binary.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class UciEngine {
  constructor(path){
    this.path = path;
    this.proc = spawn(path, [], { stdio: ["pipe", "pipe", "inherit"] });
    this.waiter = null;
    this.name = null;
    this.exited = new Promise(res => this.proc.on("exit", code => { res(code); if (this.waiter) this.waiter.fail(new Error(`Stockfish exited (${code})`)); }));
    this.proc.on("error", err => { if (this.waiter) this.waiter.fail(err); });
    createInterface({ input: this.proc.stdout }).on("line", line => {
      line = line.trim();
      if (line.startsWith("id name ")) this.name = line.slice(8);
      if (this.waiter) this.waiter.line(line);
    });
  }
  send(cmd){ this.proc.stdin.write(cmd + "\n"); }
  _wait(matcher, timeoutMs){
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiter = null; rej(new Error("Stockfish did not answer in time")); }, timeoutMs);
      this.waiter = {
        line: l => { const r = matcher(l); if (r !== undefined){ clearTimeout(t); this.waiter = null; res(r); } },
        fail: e => { clearTimeout(t); this.waiter = null; rej(e); }
      };
    });
  }
  async init({ threads = 1, hashMb = 256 } = {}){
    const ok = this._wait(l => (l === "uciok" ? true : undefined), 15000);
    this.send("uci"); await ok;
    this.send(`setoption name Threads value ${threads}`);
    this.send(`setoption name Hash value ${hashMb}`);
    const ready = this._wait(l => (l === "readyok" ? true : undefined), 15000);
    this.send("isready"); await ready;
    return this;
  }
  /** Analyse a FEN. limits: { depth, movetime } (either or both; search stops at whichever comes first).
   *  Calls are queued: one Stockfish process searches one position at a time (using all its threads). */
  analyse(fen, limits = {}){
    const run = () => this._analyse(fen, limits);
    const p = (this.queue || Promise.resolve()).then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
  _analyse(fen, { depth, movetime } = {}){
    let last = null;
    const done = this._wait(l => {
      if (l.startsWith("info ") && l.includes(" score ")){
        const s = l.match(/ score (cp|mate) (-?\d+)( lowerbound| upperbound)?/);
        if (s && !s[3]){ const d = l.match(/ depth (\d+)/), pv = l.match(/ pv (\S+)/);
          last = { type: s[1], v: +s[2], d: d ? +d[1] : 0, pv: pv ? pv[1] : null }; }
        return undefined;
      }
      if (l.startsWith("bestmove")) return { ...(last || {}), best: l.split(/\s+/)[1] };
      return undefined;
    }, Math.max(60000, (movetime || 0) * 3));
    this.send("position fen " + fen);
    this.send("go" + (depth ? ` depth ${depth}` : "") + (movetime ? ` movetime ${movetime}` : ""));
    return done;
  }
  async quit(){ try { this.send("quit"); } catch {} await Promise.race([this.exited, new Promise(r => setTimeout(r, 2000))]); try { this.proc.kill(); } catch {} }
}
