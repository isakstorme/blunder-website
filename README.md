# Blunder King

Today's worst blunders by GMs and IMs in classical games broadcast on Lichess.

It's a single static page (`index.html`) with no build step and no server.

## Run it

Open `index.html` in a browser. It starts scanning right away and checks again every 5 minutes.

To host it, put the folder on any static host. For example, with GitHub Pages: push the repo, then go to Settings → Pages → Deploy from branch → `main` / root.

## How it works

1. **Broadcasts.** It fetches official Lichess broadcasts (`/api/broadcast` and `/api/broadcast/top`). It keeps the rounds that start today or are live now.
2. **Serious games.** It keeps classical rounds only. If there are none today, it uses rapid instead. Blitz and armageddon are never included. The time control is read from `tour.info.fideTc` or `tour.info.tc`, or from the event name.
3. **Games.** Only the main line of each game is read: side lines in brackets `( … )`, comments `{ … }` and annotations are skipped. This was tested on nested side lines and on comments containing brackets, and on two full rounds the parser's final position matched Lichess's own page for every game.
   **Downloading.** It downloads each round's PGN (`/api/broadcast/round/{id}.pgn`). It keeps games where a GM or IM is playing.
   - Only **finished** games are analysed (result `1-0`, `0-1` or `1/2-1/2`). In live games, the electronic board sometimes sends wrong moves that Lichess corrects later, so games in progress are skipped until they end.
   - A finished game is analysed once and then kept, so each refresh only analyses newly finished games.
4. **Engine.** Stockfish 16 NNUE (WebAssembly, loaded from a CDN) scores every position in the browser, in up to 4 Web Workers. If that build won't load, it falls back to Stockfish 10 (asm.js).
   - Rounds are processed one at a time, top-tier events first. Each round is downloaded and then analysed straight away, so results appear early and Lichess requests are spaced out.
   - Rounds that haven't started are skipped, and finished rounds aren't downloaded again on refresh.
   - Quick pass: 250 ms per position.
   - Suspected blunders are re-checked at 4 s (about depth 22–25).
   - If the PGN already contains `[%eval]` comments, the quick pass uses those instead.
5. **Blunder rule.** A move by a GM or IM is a blunder when it loses at least 0.30 of the player's *winning chances*. Winning chances run on a −1 to 1 scale, using the same formula Lichess uses for its `??` marks:
   `wc = 2 / (1 + exp(-0.00368208 * cp)) - 1`, with cp capped at ±1000 and mate counted as ±1.
   - +3 → −3 counts, and so does 0.0 → −2.0.
   - +8 → +5 doesn't count, because the player is still winning easily.
   - The player must be no more than 1 pawn worse before the move (`MAX_WORSE_BEFORE`, default −1.00). Level and winning positions both count, so +3 → −3 is a blunder, but −1.4 → −5.4 is not.
   - A move the engine itself prefers is never counted.
6. **Possible transmission errors.** A blunder is flagged with "⚠ Possible transmission error" (not hidden) when any of these is true:
   - The opponent didn't take advantage: after their reply, the evaluation is back to within a quarter of where it was before the blunder.
   - The player who blundered still won the game, despite being at −3 or worse.
   - The game was drawn within 6 plies of the blunder, despite a −5 position.
   - The clock data doesn't add up, in a game that has clock times on most moves:
     - the move or the reply has no clock time
     - the player's clock went up by more than the increment, ignoring time-control bonuses of 10 minutes or more.
     - the player's clock, or the opponent's on the reply, didn't change at all, not even by the increment. That usually means moves were sent after the game was over.
7. **Ranking.** Only the worst blunder in each game is shown. Blunders are sorted by how much winning chance they lost. Each card shows the board, the move played (red arrow) and the engine's move (green arrow), with a link to the game.

Evaluations are cached in `localStorage`, so refreshes only analyse new moves.

## Lichess API rules

The page follows the [Lichess API](https://lichess.org/api) rules:

- **One request at a time.** Every Lichess request goes through one function, `getText()`, and runs only after the previous request's response has been fully read.
  - Requests from all open tabs of the site are queued together (using the browser's Web Locks API), so having several tabs open doesn't create parallel requests.
  - There's a short gap between requests, and finished rounds are never downloaded again.
- **After an HTTP 429, wait a full minute.** A 429 pauses *all* Lichess requests, in every tab, for 62 seconds before anything resumes.

Web Locks only work when the page is served over http(s), for example `python3 -m http.server`. When the file is opened straight from disk (`file://`), each tab still sends one request at a time, but separate tabs aren't coordinated with each other.

## Tuning

The constants are at the top of the `<script>` in `index.html`:

| Constant | Meaning |
|---|---|
| `BLUNDER_WC` | Winning-chance drop that makes a blunder (default `0.30`) |
| `MAX_WORSE_BEFORE` | How much worse (in centipawns) the player may be before the blunder (default `-100`) |
| `REFRESH_MS` | How often to re-check (default 5 min) |
| `SPEEDS` | Engine time per position for the quick pass and the re-check |
| `S.titles` | Titles whose moves are checked (default `GM`, `IM`) |

## Credits

All game and tournament data comes from [Lichess.org](https://lichess.org), the free, open-source chess server, through its [public API](https://lichess.org/api). The live [broadcasts](https://lichess.org/broadcast) are made possible by Lichess, its volunteers and the tournament organisers. The page credits Lichess in its header and footer. Blunder King is an independent fan project and is not affiliated with or endorsed by Lichess.

Analysis by [Stockfish](https://stockfishchess.org) (GPLv3), via [stockfish.js](https://github.com/nmrugg/stockfish.js).

## Dependencies (all loaded from CDNs)

- [chess.js 0.10.3](https://cdnjs.com/libraries/chess.js) for parsing PGN and checking moves
- [stockfish 16.0.0](https://www.npmjs.com/package/stockfish) (NNUE, WebAssembly) for the engine, with [stockfish.js 10.0.2](https://cdnjs.com/libraries/stockfish.js) as a fallback
- Google Fonts: Fraunces, Inter, JetBrains Mono
