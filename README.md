# Blunder King

Today's worst blunders by GMs and IMs in finished classical games broadcast on Lichess.

A script on a server analyses the day's games with Stockfish every couple of hours and saves the results to `data/latest.json`. The website (`index.html`) only displays that file, so it loads instantly and does no chess analysis in the visitor's browser.

```
index.html                    the website: shows data/latest.json
live.html                     the older version that analyses in your own browser (handy locally)
server/analyze.mjs            the analysis run (Node.js + native Stockfish)
server/core.mjs               all the chess rules: reading games, what counts as a blunder, transmission-error flags
server/uci.mjs                talks to the Stockfish program
.github/workflows/update.yml  runs the analysis every 2 hours on GitHub and saves the results
data/latest.json              today's results (written by the script)
data/days/<date>.json         one archive file per day
data/state/<date>.json        progress, so each run only analyses newly finished games
```

## Hosting it free on GitHub

0. Move the workflow file into place (it ships in `deploy/`):
   `mkdir -p .github/workflows && git mv deploy/update.yml .github/workflows/update.yml` (or a plain `mv` if it isn't committed yet)
1. Push this folder to a GitHub repository.
2. **Settings → Pages:** "Deploy from a branch", branch `main`, folder `/ (root)`. The site appears at `https://<you>.github.io/<repo>/`.
3. **Settings → Actions → General → Workflow permissions:** choose "Read and write permissions", so the workflow can save results.
4. **Actions → Update blunders → Run workflow** to run it once now. After that it runs by itself every 2 hours.

Each run:
- installs Node.js, `chess.js` and the latest official Stockfish
- analyses newly finished games
- commits `data/` back to the repository, which updates the site

GitHub's free runners have 4 CPU cores, which is plenty for this.

## Running it on your own server (VPS) instead

```bash
# once
sudo apt install nodejs npm stockfish   # or download the newest Stockfish from stockfishchess.org
cd ~/blundersite && npm install

# every 2 hours (crontab -e)
17 */2 * * *  cd ~/blundersite && TZ=Europe/Stockholm node server/analyze.mjs >> analyze.log 2>&1
```

Then serve the folder with any web server (nginx, Caddy, or `python3 -m http.server` for testing).

## Running it on your own computer

```bash
npm install
STOCKFISH_PATH=/path/to/stockfish node server/analyze.mjs
python3 -m http.server 8000      # then open http://localhost:8000
```

## Which games and moves count

1. **Broadcasts.** The official Lichess broadcasts that started today, or are live now.
   - "Today" uses the `TZ` time zone, which the workflow sets to Europe/Stockholm.
   - Rounds that haven't started yet are skipped.
2. **Serious games only.** Classical games only. If there are none today, rapid games are used instead. Blitz and armageddon are never included.
3. **Finished games only.** Only games with a result (`1-0`, `0-1` or `1/2-1/2`) are analysed. In live games, the electronic board sometimes sends wrong moves that Lichess corrects later.
   - Only the main line of each game is read: side lines in brackets `( … )`, comments `{ … }` and annotations are skipped.
   - At least one of the players must be a GM or an IM.
4. **The blunder rule.** A move by a GM or IM counts as a blunder when all of these hold:
   - It loses at least 0.30 of the player's *winning chances* (`BLUNDER_WC`). This is the scale Lichess uses for its `??` marks: `wc = 2 / (1 + exp(-0.00368208 * cp)) - 1`, with cp capped at ±1000 and mate counted as ±1.
   - Before the move, the player was at most 1 pawn worse (`MAX_WORSE_BEFORE`, −1.00).
   - After the move, the player is no longer winning: below +1.00 (`STILL_WINNING`). So +6 → +3 doesn't count, but +3 → +0.5 and +3 → −3 do.
   - It isn't the move Stockfish itself would have played.

   Every position gets a first pass (depth 18). Suspected blunders are re-checked deeper (depth 26), and only the deeper result decides.
5. **One per game.** If a game has several blunders, only the worst one is shown.
6. **Possible transmission errors** are flagged (with the reasons) but not hidden. A blunder is flagged when:
   - the opponent didn't take advantage, so the evaluation went straight back after their reply
   - the player who blundered still won, despite being at −3 or worse
   - the game was drawn within 6 plies of the blunder, despite a −5 position
   - the clock times don't add up, in a game that has clock times on most moves:
     - there's no clock time on the move or the reply
     - a clock went up by more than the increment
     - a clock didn't change at all, not even by the increment. This often means moves were sent after the game was over.

## Lichess API rules

The script follows the [Lichess API](https://lichess.org/api) rules:
- It makes only one request at a time, at most one per second.
- After an HTTP 429 it waits a full minute before making any other request.
- It identifies itself with a `User-Agent` header. To add a way for Lichess to contact you, set `LICHESS_CONTACT`, for example to your repository URL.

A run makes about 3 requests plus one per round that is still in progress. Finished rounds whose games have all been analysed aren't downloaded again.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `STOCKFISH_PATH` | `stockfish` | Stockfish binary |
| `THREADS` | all cores | Engine threads |
| `HASH_MB` | `256` | Engine hash |
| `QUICK_DEPTH` / `QUICK_MS` | `18` / `400` | First pass over every position (stops at whichever limit comes first) |
| `DEEP_DEPTH` / `DEEP_MS` | `26` / `8000` | Re-check of suspected blunders |
| `MAX_MINUTES` | `45` | Stop analysing after this long; the next run continues where it stopped |
| `TZ` | system | Time zone that decides what "today" is |
| `LICHESS_CONTACT` | – | Optional contact (URL or e-mail) included in the User-Agent |

The blunder rules are constants at the top of `server/core.mjs`.

## Credits

All game and tournament data comes from [Lichess.org](https://lichess.org), the free, open-source chess server, through its [public API](https://lichess.org/api). The live [broadcasts](https://lichess.org/broadcast) are made possible by Lichess, its volunteers and the tournament organisers. The site credits Lichess in its header and footer. Blunder King is an independent fan project and is not affiliated with or endorsed by Lichess.

Analysis by [Stockfish](https://stockfishchess.org) (GPLv3). Move handling by [chess.js](https://github.com/jhlywa/chess.js).
