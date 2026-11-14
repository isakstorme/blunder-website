// Blunder King — shared chess logic (no I/O). Used by the server script (Node) and testable in a browser.
// Everything that decides what counts as a blunder lives here.

export const MATE = 100000;          // encoded mate score (centipawns)
export const CAP = 1000;             // evals capped at ±10 pawns when measuring a drop
export const BLUNDER_WC = 0.30;      // drop in winning chances (scale −1..1) that makes a blunder (Lichess's own threshold)
export const MAX_WORSE_BEFORE = -100; // before the blunder the player may be at most 1.00 pawn worse
export const STILL_WINNING = 100;     // if the player is still +1.00 or better after the move, it is not a blunder (+6 → +3)
export const TITLES = new Set(["GM", "IM", "WGM", "WIM"]);

export const clampCap = v => Math.max(-CAP, Math.min(CAP, v));

/** Winning chances on a −1..1 scale (same formula Lichess uses for its blunder marks). */
export function wc(w){
  if (Math.abs(w) > MATE - 1000) return Math.sign(w);
  return 2 / (1 + Math.exp(-0.00368208 * clampCap(w))) - 1;
}

export function fmtEval(w){
  if (Math.abs(w) > MATE - 1000){ const n = MATE - Math.abs(w); return n === 0 ? (w > 0 ? "1-0" : "0-1") : (w > 0 ? "#" : "#-") + n; }
  const p = w / 100; return (p > 0 ? "+" : p < 0 ? "−" : "") + Math.abs(p).toFixed(1);
}

/** Convert a UCI score {type:'cp'|'mate', v} for the side to move into a White-relative number. */
export function stmToWhite(r, turn){
  let s = 0;
  if (r.type === "mate") s = r.v > 0 ? MATE - r.v : -MATE - r.v;
  else if (r.type === "cp") s = r.v;
  return turn === "w" ? s : -s;
}

export const fenKey = f => f.split(" ").slice(0, 4).join(" ");
export const isFinishedResult = r => /^(1-0|0-1|1\/2-1\/2|½-½)$/.test(String(r || "").trim());

/* ---------------- rounds ---------------- */

export function tcAllowed(tour, mode){
  const info = tour.info || {};
  const tc = String(info.fideTC || info.fideTc || info.tc || "").toLowerCase();
  const name = String(tour.name || "").toLowerCase();
  const isBlitz = /blitz|bullet|armageddon/.test(tc) || /blitz|bullet|armageddon/.test(name);
  const isRapid = /rapid/.test(tc) || /rapid/.test(name);
  if (mode === "all") return true;
  if (mode === "rapid") return !isBlitz;
  return !isBlitz && !isRapid;
}

/**
 * Pick today's rounds from the Lichess broadcast lists.
 * official: parsed lines of /api/broadcast (each {tour, rounds}); top: parsed /api/broadcast/top.
 * Classical only; if there is no classical round today, rapid. Never blitz. Rounds that haven't started are skipped.
 */
export function selectRounds(official, top, dayStart, dayEnd, now){
  const byId = new Map();
  const add = (tour, round) => { if (tour && round && round.id && !byId.has(round.id)) byId.set(round.id, { tour, round }); };
  for (const t of official || []) for (const r of (t.rounds || [])) add(t.tour, r);
  for (const x of ((top && top.active) || [])) add(x.tour, x.round);
  for (const x of ((top && top.past && top.past.currentPageResults) || [])) add(x.tour, x.round);
  const today = [...byId.values()].filter(({ round }) => {
    const t = round.startsAt;
    if (round.ongoing) return now >= dayStart && now < dayEnd;
    return !!t && t >= dayStart && t < dayEnd && t <= now;
  });
  let rounds = today.filter(r => tcAllowed(r.tour, "classical"));
  let timeControl = "classical";
  if (!rounds.length){ rounds = today.filter(r => tcAllowed(r.tour, "rapid")); timeControl = "rapid"; }
  rounds.sort((a, b) => (b.tour.tier || 0) - (a.tour.tier || 0) || (!!b.round.ongoing - !!a.round.ongoing));
  return { rounds, timeControl };
}

/* ---------------- PGN ---------------- */

export function splitPgn(text){
  return String(text || "").replace(/\r/g, "").split(/\n\s*\n(?=\s*\[)/).map(s => s.trim()).filter(Boolean);
}

function parseEvalComment(c, turnAfter){
  const m = c.match(/\[%eval\s+(#?)(-?[\d.]+)/);
  if (!m) return null;
  if (m[1]){ const n = parseInt(m[2], 10); return n > 0 ? MATE - n : n < 0 ? -MATE - n : (turnAfter === "w" ? -MATE : MATE); }
  return Math.round(parseFloat(m[2]) * 100);
}

/**
 * Parse one PGN game, following ONLY the main line: side lines "( … )", comments "{ … }", ";" comments and NAGs
 * are skipped. Returns { headers, plies } where each ply has san/uci/from/to/color/fenBefore/fenAfter/clk.
 */
export function parseGame(Chess, text){
  const headers = {};
  text.replace(/^\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm, (_, k, v) => { headers[k] = v.replace(/\\"/g, '"'); return ""; });
  const body = text.replace(/^\[.*\]\s*$/gm, "").trim();
  const chess = new Chess(headers.FEN || undefined);
  const plies = [];
  let i = 0, depth = 0;
  while (i < body.length){
    const ch = body[i];
    if (ch === "{"){
      const j = body.indexOf("}", i); const c = j < 0 ? body.slice(i) : body.slice(i + 1, j);
      if (depth === 0 && plies.length){
        const last = plies[plies.length - 1];
        const ev = parseEvalComment(c, chess.turn()); if (ev != null) last.pgnEval = ev;
        const ck = c.match(/\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/);
        if (ck) last.clk = (+ck[1]) * 3600 + (+ck[2]) * 60 + parseFloat(ck[3]);
      }
      i = j < 0 ? body.length : j + 1; continue;
    }
    if (ch === ";"){ const j = body.indexOf("\n", i); i = j < 0 ? body.length : j + 1; continue; }
    if (ch === "("){ depth++; i++; continue; }
    if (ch === ")"){ depth--; i++; continue; }
    if (/\s/.test(ch)){ i++; continue; }
    let j = i; while (j < body.length && !/[\s{}();]/.test(body[j])) j++;
    let tok = body.slice(i, j); i = j;
    if (depth > 0) continue;
    if (/^\$\d+$/.test(tok) || /^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) continue;
    tok = tok.replace(/^\d+\.+/, "").replace(/[!?]+$/, "");
    if (!tok) continue;
    const fenBefore = chess.fen();
    const m = chess.move(tok, { sloppy: true });
    if (!m) break;
    plies.push({ san: m.san, uci: m.from + m.to + (m.promotion || ""), from: m.from, to: m.to, color: m.color,
                 fenBefore, fenAfter: chess.fen(), pgnEval: null, clk: null });
  }
  return { headers, plies };
}

/** Turn a parsed game into the record we analyse, or null if it doesn't qualify (titles, finished, length). */
export function toGame(pg, round, tour, n, titles = TITLES){
  const h = pg.headers;
  const wT = (h.WhiteTitle || "").toUpperCase(), bT = (h.BlackTitle || "").toUpperCase();
  if (!(titles.has(wT) || titles.has(bT)) || pg.plies.length < 2) return { skip: "titles" };
  if (!isFinishedResult(h.Result)) return { skip: "live" };
  const fenParts = (h.FEN || "").split(" ");
  const url = h.GameURL || h.ChapterURL || round.url || "https://lichess.org/broadcast";
  return { game: {
    key: round.id + "/" + (url.split("/").pop() || n),
    white: h.White || "?", black: h.Black || "?", wTitle: wT, bTitle: bT,
    wElo: h.WhiteElo || null, bElo: h.BlackElo || null, result: h.Result, timeControl: h.TimeControl || "",
    url, tour: tour.name, round: round.name, roundId: round.id,
    startBlack: fenParts[1] === "b", startMove: h.FEN ? +fenParts[5] || 1 : 1,
    plies: pg.plies
  } };
}

export function moveLabel(g, i){
  const p = g.plies[i];
  return Math.floor((i + (g.startBlack ? 1 : 0)) / 2 + (g.startMove || 1)) + (p.color === "w" ? ". " : "… ") + p.san;
}

export function uciToSan(Chess, fen, uci){
  if (!uci) return null;
  const c = new Chess(fen);
  const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" });
  return m ? m.san : uci;
}

/* ---------------- analysis ---------------- */

/**
 * Signs that a "blunder" is a broadcast/board transmission error rather than a move that was played.
 * ev(fen, deep) → Promise<{w}>. Returns plain-language reasons (empty = looks genuine). Flags only; never hides.
 */
export async function transmissionSuspicion(g, i, db, da, ev){
  const P = g.plies, p = P[i], reasons = [];
  const sign = p.color === "w" ? 1 : -1;
  const mover = p.color === "w" ? g.white : g.black, opp = p.color === "w" ? g.black : g.white;
  const wcAfter = sign * wc(da.w), lost = sign * wc(db.w) - wcAfter;
  const moverCp = sign * da.w;

  // 1. The gift wasn't taken: after the opponent's reply the evaluation snaps straight back.
  if (i + 1 < P.length){
    const dr = await ev(P[i + 1].fenAfter, true);
    if (sign * wc(dr.w) - wcAfter >= 0.75 * lost)
      reasons.push(`${opp} didn't take advantage: after ${moveLabel(g, i + 1)} the evaluation was back to ${fmtEval(dr.w)}`);
  }
  // 2. The result doesn't fit the position the "blunder" left behind.
  const res = String(g.result || "").trim();
  const moverWon = (p.color === "w" && res === "1-0") || (p.color === "b" && res === "0-1");
  const drawn = res === "1/2-1/2" || res === "½-½";
  if (moverWon && moverCp <= -300) reasons.push(`${mover} went on to win the game anyway`);
  else if (drawn && moverCp <= -500 && P.length - 1 - i <= 6) reasons.push(`The game was drawn right after, in a position that was lost for ${mover}`);
  // 3. Clock times that don't add up (only when the game has clock data at all).
  const withClock = P.filter(x => x.clk != null).length;
  if (withClock >= P.length * 0.8){
    const inc = +((String(g.timeControl).match(/\+(\d+)/) || [])[1] || 0);
    const prevOwn = i >= 2 ? P[i - 2].clk : null;
    if (p.clk == null) reasons.push("No clock time was recorded for this move");
    else if (prevOwn != null && p.clk > prevOwn + inc + 5 && p.clk - prevOwn < 600)
      reasons.push("The player's clock went up after this move, which shouldn't happen");
    else if (prevOwn != null && inc > 0 && p.clk === prevOwn)
      reasons.push("The player's clock didn't change at all for this move (not even the increment). This often means a move was sent after the game was over");
    if (i + 1 < P.length && P[i + 1].clk == null) reasons.push("No clock time was recorded for the reply");
    else if (i + 1 < P.length && i >= 1 && inc > 0 && P[i + 1].clk === P[i - 1].clk)
      reasons.push("The opponent's clock didn't change at all for the reply, which looks like moves sent after the game was over");
  }
  return reasons;
}

/**
 * Analyse one finished game. ev(fen, deep) → Promise<{w, best, d}> (w = White-relative score).
 * Returns { blunder (the game's worst, or null), positions }.
 * Rule: a move by a titled player that loses ≥ BLUNDER_WC winning chances, from a position where the player was
 * at most 1 pawn worse, after which the player is no longer winning (below +1), and that isn't the engine's own choice.
 */
export async function analyseGame(Chess, g, ev, { titles = TITLES, onPosition } = {}){
  const P = g.plies;
  const fens = P.map(p => p.fenBefore).concat([P[P.length - 1].fenAfter]);
  const quick = await Promise.all(fens.map(async (f, j) => {
    const r = (j > 0 && P[j - 1].pgnEval != null) ? { w: P[j - 1].pgnEval } : await ev(f, false);
    if (onPosition) onPosition();
    return r;
  }));
  const found = [];
  for (let i = 0; i < P.length; i++){
    const p = P[i];
    if (!titles.has(p.color === "w" ? g.wTitle : g.bTitle)) continue;
    const sign = p.color === "w" ? 1 : -1, b = quick[i].w, a = quick[i + 1].w;
    if (sign * b < MAX_WORSE_BEFORE - 60) continue;               // already clearly worse
    if (sign * a >= STILL_WINNING + 60) continue;                 // still clearly winning afterwards
    if (sign * (wc(b) - wc(a)) < BLUNDER_WC * 0.6) continue;      // not even close to a blunder
    const db = await ev(p.fenBefore, true), da = await ev(p.fenAfter, true);
    const wcDrop = sign * (wc(db.w) - wc(da.w));
    if (wcDrop < BLUNDER_WC || sign * db.w < MAX_WORSE_BEFORE || sign * da.w >= STILL_WINNING || db.best === p.uci) continue;
    found.push({
      ply: i, label: moveLabel(g, i), san: p.san, uci: p.uci, from: p.from, to: p.to, color: p.color,
      fenBefore: p.fenBefore, before: db.w, after: da.w, wcDrop: Math.round(wcDrop * 1000) / 1000,
      drop: sign * (clampCap(db.w) - clampCap(da.w)),
      bestUci: db.best || null, bestSan: uciToSan(Chess, p.fenBefore, db.best),
      depth: Math.min(db.d || 0, da.d || 0),
      suspect: await transmissionSuspicion(g, i, db, da, ev)
    });
  }
  // At most one blunder per game: keep its worst.
  found.sort((x, y) => y.wcDrop - x.wcDrop || y.drop - x.drop);
  return { blunder: found[0] || null, positions: fens.length };
}

/** The public record for one blunder (what the website shows). */
export function publicRecord(g, b){
  return {
    white: g.white, black: g.black, wTitle: g.wTitle, bTitle: g.bTitle, wElo: g.wElo, bElo: g.bElo,
    result: g.result, tour: g.tour, round: g.round, url: g.url,
    ...b
  };
}
