#!/usr/bin/env node
// Blunder King — server analysis run.
// Downloads today's finished games by titled players (GM, IM, WGM, WIM) from Lichess broadcasts, analyses them with native Stockfish and writes
//   data/latest.json        what the website shows
//   data/days/<date>.json   archive copy for that day
//   data/state/<date>.json  progress, so the next run only analyses newly finished games
//
// Lichess API rules (https://lichess.org/api): one request at a time; after an HTTP 429 wait a full minute.
//
// Settings (environment variables):
//   STOCKFISH_PATH   path to the Stockfish binary            (default "stockfish")
//   THREADS          engine threads                          (default: all CPU cores)
//   HASH_MB          engine hash size                        (default 256)
//   QUICK_DEPTH / QUICK_MS   first pass over every position  (default depth 18, max 400 ms)
//   DEEP_DEPTH  / DEEP_MS    re-check of suspected blunders  (default depth 26, max 8000 ms)
//   MAX_MINUTES      stop analysing after this long; the next run continues (default 45)
//   TZ               which day counts as "today"             (set in the workflow: Europe/Stockholm)
//   DATA_DIR         output folder                           (default ./data)
//   LICHESS_CONTACT  optional contact (URL or e-mail) added to the User-Agent so Lichess can reach you

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chessjs from "chess.js";
import { UciEngine } from "./uci.mjs";
import * as core from "./core.mjs";

const Chess = chessjs.Chess;
const API = "https://lichess.org";
const env = process.env;
const CFG = {
  stockfish: env.STOCKFISH_PATH || "stockfish",
  threads: +env.THREADS || os.cpus().length || 1,
  hashMb: +env.HASH_MB || 256,
  quick: { depth: +env.QUICK_DEPTH || 18, movetime: +env.QUICK_MS || 400 },
  deep: { depth: +env.DEEP_DEPTH || 26, movetime: +env.DEEP_MS || 8000 },
  maxMs: (+env.MAX_MINUTES || 45) * 60000,
  dataDir: path.resolve(env.DATA_DIR || "data"),
  userAgent: `BlunderKing/1.0${env.LICHESS_CONTACT ? ` (${env.LICHESS_CONTACT})` : ""}`
};
const started = Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- Lichess (one request at a time; 429 → wait a full minute) ---------------- */
let lastRequest = 0;
async function lichess(pathname){
  for (let attempt = 0; attempt < 4; attempt++){
    const gap = lastRequest + 1000 - Date.now(); if (gap > 0) await sleep(gap);   // at most one request per second
    let r;
    try { r = await fetch(API + pathname, { headers: { "User-Agent": CFG.userAgent } }); }
    finally { lastRequest = Date.now(); }
    if (r.status === 429){ log("Lichess returned 429 — waiting a full minute as its API rules require"); await sleep(61000); continue; }
    if (!r.ok) throw new Error(`Lichess ${r.status} for ${pathname}`);
    return await r.text();      // body fully read before the next request can start (requests are awaited in sequence)
  }
  throw new Error(`Lichess kept rate-limiting ${pathname}`);
}
const ndjson = t => t.split("\n").filter(l => l.trim()).map(l => JSON.parse(l));

/* ---------------- files ---------------- */
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
function writeJson(f, obj){ fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", JSON.stringify(obj, null, 1)); fs.renameSync(f + ".tmp", f); }
function localDate(ms){ const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

/* ---------------- engine with a per-run cache ---------------- */
let engine, positions = 0;
const evalCache = new Map();
async function ev(fen, deep){
  const key = (deep ? "d|" : "q|") + core.fenKey(fen);
  if (evalCache.has(key)) return evalCache.get(key);
  if (!deep && evalCache.has("d|" + core.fenKey(fen))) return evalCache.get("d|" + core.fenKey(fen));
  const c = new Chess(fen), turn = c.turn();
  let out;
  if (c.in_checkmate()) out = { w: turn === "w" ? -core.MATE : core.MATE, best: null, d: 99 };
  else if (c.in_stalemate() || c.insufficient_material()) out = { w: 0, best: null, d: 99 };
  else {
    const r = await engine.analyse(fen, deep ? CFG.deep : CFG.quick);
    out = { w: core.stmToWhite(r, turn), best: r.best && r.best !== "(none)" ? r.best : null, d: r.d || 0 };
  }
  evalCache.set(key, out);
  return out;
}

/* ---------------- main ---------------- */
async function main(){
  const now = Date.now();
  const today = localDate(now);
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const dayStart = d0.getTime(), dayEnd = dayStart + 86400000;
  const statePath = path.join(CFG.dataDir, "state", `${today}.json`);
  const state = readJson(statePath, { date: today, games: {}, doneRounds: {} });
  log(`Blunder King run for ${today} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`);

  // 1. Which rounds?
  const official = ndjson(await lichess("/api/broadcast?nb=60"));
  let top = null; try { top = JSON.parse(await lichess("/api/broadcast/top?page=1")); } catch (e) { log("top broadcasts:", e.message); }
  const { rounds, timeControl } = core.selectRounds(official, top, dayStart, dayEnd, now);
  log(`${rounds.length} ${timeControl} rounds today`);

  // 2. Engine
  engine = await new UciEngine(CFG.stockfish).init({ threads: CFG.threads, hashMb: CFG.hashMb });
  log(`Engine: ${engine.name} · ${CFG.threads} threads · ${CFG.hashMb} MB hash`);

  // 3. Rounds → finished games → analysis (top-tier events first)
  const tours = new Map();
  let stoppedEarly = false;
  for (const { tour, round } of rounds){
    const T = tours.get(tour.id) || { name: tour.name, url: tour.url || round.url, tier: tour.tier || null,
      timeControl: (tour.info && (tour.info.fideTC || tour.info.tc)) || null, rounds: [] };
    tours.set(tour.id, T);
    const R = { name: round.name, url: round.url, status: round.ongoing ? "live" : round.finished ? "finished" : "started",
                finishedGames: 0, liveGames: 0 };
    T.rounds.push(R);
    const done = state.doneRounds[round.id];
    if (done){ Object.assign(R, done); continue; }        // finished round, everything already analysed in an earlier run
    if (Date.now() - started > CFG.maxMs){ stoppedEarly = true; R.pending = true; continue; }

    let pgn;
    try { pgn = await lichess(`/api/broadcast/round/${round.id}.pgn`); }
    catch (e){ log(`  ${tour.name} — ${round.name}: ${e.message}`); R.error = true; continue; }
    const parts = core.splitPgn(pgn);
    let allDone = true;
    for (let n = 0; n < parts.length; n++){
      let pg; try { pg = core.parseGame(Chess, parts[n]); } catch { continue; }
      const { game, skip } = core.toGame(pg, round, tour, n);
      if (skip === "live"){ R.liveGames++; allDone = false; continue; }
      if (!game) continue;
      R.finishedGames++;
      const sig = game.key + "#" + game.plies.length;
      if (state.games[game.key] && state.games[game.key].sig === sig) continue;   // analysed in an earlier run
      if (Date.now() - started > CFG.maxMs){ stoppedEarly = true; allDone = false; break; }
      const t0 = Date.now();
      const { blunder, positions: np } = await core.analyseGame(Chess, game, ev, { onPosition: () => positions++ });
      state.games[game.key] = { sig, tourId: tour.id, roundId: round.id, blunder: blunder ? core.publicRecord(game, blunder) : null };
      log(`  ${game.white} – ${game.black} (${np} positions, ${((Date.now() - t0) / 1000).toFixed(0)} s)${blunder ? `  blunder ${blunder.label}${blunder.suspect.length ? " [suspect]" : ""}` : ""}`);
      writeJson(statePath, state);                       // save progress after every game
    }
    if (allDone && round.finished) state.doneRounds[round.id] = { finishedGames: R.finishedGames, liveGames: 0, status: "finished" };
    log(`${tour.name} — ${round.name}: ${R.finishedGames} finished titled games, ${R.liveGames} still playing`);
  }
  await engine.quit();
  writeJson(statePath, state);

  // 4. Output: one blunder per game, worst first.
  const roundIds = new Set(rounds.map(r => r.round.id));
  const blunders = Object.values(state.games)
    .filter(x => x.blunder && roundIds.has(x.roundId))
    .map(x => x.blunder)
    .sort((a, b) => b.wcDrop - a.wcDrop || b.drop - a.drop);
  const out = {
    date: today,
    generatedAt: new Date().toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timeControl,
    complete: !stoppedEarly,
    engine: { name: engine.name, quickDepth: CFG.quick.depth, deepDepth: CFG.deep.depth },
    gamesAnalysed: Object.values(state.games).filter(x => roundIds.has(x.roundId)).length,
    rules: { blunderWinningChances: core.BLUNDER_WC, maxWorseBefore: core.MAX_WORSE_BEFORE, stillWinning: core.STILL_WINNING, titles: [...core.TITLES] },
    tournaments: [...tours.values()],
    blunders
  };
  writeJson(path.join(CFG.dataDir, "days", `${today}.json`), out);
  writeJson(path.join(CFG.dataDir, "latest.json"), out);
  const days = fs.readdirSync(path.join(CFG.dataDir, "days")).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort().reverse();
  writeJson(path.join(CFG.dataDir, "days", "index.json"), { days });
  log(`Done: ${blunders.length} blunders from ${out.gamesAnalysed} games, ${positions} positions analysed this run, ${((Date.now() - started) / 60000).toFixed(1)} min${stoppedEarly ? " (time limit reached; next run continues)" : ""}`);
}

main().catch(async e => { console.error(e); try { await engine?.quit(); } catch {} process.exit(1); });
