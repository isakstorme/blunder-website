# Blunder Watch

Today's worst blunders by GMs and IMs in classical games broadcast on Lichess.

It's a single static page (`index.html`) with no build step and no server.

## Run it

Open `index.html` in a browser. It starts scanning right away and checks again every 5 minutes.

To host it, put the folder on any static host. For example, with GitHub Pages: push the repo, then go to Settings → Pages → Deploy from branch → `main` / root.

## How it works

1. **Broadcasts.** It fetches official Lichess broadcasts (`/api/broadcast` and `/api/broadcast/top`). It keeps the rounds that start today or are live now.
2. **Serious games.** It keeps classical rounds only. If there are none today, it uses rapid instead. Blitz and armageddon are never included. The time control is read from `tour.info.fideTc` or `tour.info.tc`, or from the event name.
3. **Games.** It downloads each round's PGN (`/api/broadcast/round/{id}.pgn`). It keeps games where a GM or IM is playing.
4. **Engine.** Stockfish 10 (asm.js, loaded from a CDN) scores every position in the browser, in up to 4 Web Workers.
   - Quick pass: 150 ms per position.
   - Suspected blunders are re-checked at 1.5 s.
   - If the PGN already contains `[%eval]` comments, the quick pass uses those instead.
5. **Blunder rule.** A move by a GM or IM is a blunder when it loses at least 0.30 of the player's *winning chances*. Winning chances run on a −1 to 1 scale, using the same formula Lichess uses for its `??` marks:
   `wc = 2 / (1 + exp(-0.00368208 * cp)) - 1`, with cp capped at ±1000 and mate counted as ±1.
   - +3 → −3 counts, and so does 0.0 → −2.0.
   - +8 → +5 doesn't count, because the player is still winning easily.
   - A move the engine itself prefers is never counted.
6. **Ranking.** Blunders are sorted by how much winning chance they lost. Each card shows the board, the move played (red arrow) and the engine's move (green arrow), with a link to the game.

Evaluations are cached in `localStorage`, so refreshes only analyse new moves.

## Tuning

The constants are at the top of the `<script>` in `index.html`:

| Constant | Meaning |
|---|---|
| `BLUNDER_WC` | Winning-chance drop that makes a blunder (default `0.30`) |
| `REFRESH_MS` | How often to re-check (default 5 min) |
| `SPEEDS` | Engine time per position for the quick pass and the re-check |
| `S.titles` | Titles whose moves are checked (default `GM`, `IM`) |

## Dependencies (all loaded from CDNs)

- [chess.js 0.10.3](https://cdnjs.com/libraries/chess.js) for parsing PGN and checking moves
- [stockfish.js 10.0.2](https://cdnjs.com/libraries/stockfish.js) for the engine
- Google Fonts: Fraunces, Inter, JetBrains Mono
