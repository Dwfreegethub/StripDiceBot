# StripDiceBot

A Bondage Club chat-room bot running a strip-dice game (multiplayer, team 2v2/3v3, and
whispered solo modes) over a socket.io connection. Runs live, supervised by the control
panel in `D:\Games\BC-Bot\panel`.

## Module layout

| File | What lives there |
|---|---|
| `src/index.ts` | Process entry: wires BC events to the game, OOC stripping, restart announcement |
| `src/connection.ts` | `BCConnection` — socket.io connection, room/emit primitives |
| `src/game.ts` | `StripDiceGame` — multiplayer/team game engine, command table, turn flow, bondage, end-game locks |
| `src/soloGame.ts` | `SoloGameManager` — solo race/survive games, records, `!scores` |
| `src/feedback.ts` | `FeedbackManager` — `!feedback`, admin proxy flow, status tracking/notifications |
| `src/matchmaking.ts` | `MatchmakingManager` — `!bd register` pool, `!looking` beeps, strike system, reply relay |
| `src/tournament.ts` | `TournamentManager` — setup interview, registration, rounds, punishment/serving, `!claim` |
| `src/tournamentLogic.ts` | Pure bracket maths — pairing, match resolution, elimination. No I/O, no clock, no BC |
| `src/tournamentSim.ts` | Dev-only harness (`npm run sim`): asserts tournamentLogic against synthetic fields |
| `src/matchmakingSim.ts` | Dev-only harness (`npm run sim:mm`): drives the pool against a stub host |
| `src/storage.ts` | `BotStorage` — ALL JSON/data file reads and writes, one method pair per file |
| `src/host.ts` | `GameHost` interface — the only surface managers may use to reach shared machinery |
| `src/constants.ts` | Every tuning knob (timers, brackets, slots, consent tiers, labels) |
| `src/types.ts` | Shared interfaces/enums. Import-free by design |
| `src/util.ts` | Pure stateless helpers (no I/O) — duration parsing, Central-time formatting, passwords |
| `src/outfits.ts` | Loads `outfits.json` + `bc_items.json` at startup → `BONDAGE_OUTFITS`, `BC_ITEM_CATALOG` |
| `src/logger.ts` | Central-time logging (`log`, `logError`, `logGameEvent`) |
| `src/help.ts` | Every player-facing command description; `!help`, `!bd`, tournament rules and `wiki/Commands.md` render from it. Imports only `constants` |
| `src/helpTools.ts` | Dev-only: `npm run check:help` (help vs. commandTable vs. wiki) and `npm run wiki` (writes `wiki/Commands.md`) |
| `src/version.ts` | `BOT_VERSION`, read from `package.json` |

Dependency direction (never violate — module-load cycles crash the bot at startup):
`types` ← `constants`/`util` ← `outfits`/`storage` ← `host` ← `soloGame`/`feedback`/`matchmaking`/`tournament`
← `game` ← `index`. Managers must NEVER import `game.ts`, or each other — two managers that need to talk
(the tournament starting a solo game, say) meet on `GameHost` and the game passes the message along.

## Where new code goes

- **New command**: add a `commandTable` entry in game.ts (longer prefixes before shorter,
  e.g. `"!feedback list"` before `"!feedback"`). Implement the handler in the subsystem
  it belongs to, or in game.ts for multiplayer-core commands.
  Then describe it in `src/help.ts` (or list it in `HIDDEN_COMMANDS` with the reason),
  run `npm run wiki`, and check with `npm run check:help`, which fails on any mismatch.
  `!help`, `!bd`, the tournament rules' command list and `wiki/Commands.md` are all built
  from `help.ts`: never hand-write a command list anywhere else.
- **Commands in player-facing text** are written in the `/bot` form (`/bot roll`). BC sends
  `/bot <text>` to the bot as a Hidden `ChatRoomBot <text>` message the room never sees;
  `handleBotCommand` treats it as a whisper, adding the `!` when the text is a command.
  Every `!` command keeps working and must keep working.
- **New tuning value**: `constants.ts`, exported, with a comment saying what it tunes.
- **New persisted file**: path + load/save (or append) pair in `storage.ts`. Never call
  `fs` from game logic. In-memory caches live with the code that owns them.
- **New subsystem**: own manager class in its own file, own state, constructor takes
  `GameHost`. If it needs something new from the game, add it to the `GameHost`
  interface first (keeps cross-module dependencies visible), implement it as a `public`
  member on `StripDiceGame`.
- **Multiplayer-core changes** (turn flow, team mode, player-pick bondage, end-game
  locks): these stay in game.ts — they share too much mutable state to split cleanly.

## Build / deploy

- `npm run build` (plain `tsc` → `build/`), `npx tsc --noEmit` for a check without
  touching `build/`. No unit-test suite — the compiler and a live game are the safety net.
- Two dev harnesses stand in where a live game can't check the logic, because the
  behaviour only plays out over hours or days. Both exit non-zero on failure, so run the
  relevant one before committing a change in its area:
  - `npm run sim` — tournament bracket logic, over hundreds of synthetic tournaments.
  - `npm run sim:mm` — the matchmaking pool's cooldown, strike and relay rules.
  They drive the real manager classes against a stub `GameHost`, so extending a manager
  usually means extending the stub too. Neither touches a data file or the network.
  - `npm run check:help` — every command is described in `help.ts` (or hidden on purpose),
    every usage line reaches its command, and `wiki/Commands.md` is current.
  Note that `sim`, `sim:mm`, `check:help` and `wiki` all run `tsc`, which rewrites `build/`:
  the next restart of the live bot (even a crash restart) runs whatever was built.
- **Version**: `package.json` `version` is the single source; `src/version.ts` reads it and
  it shows on the online/reconnect lines, `!about`, the startup log and new `!changelog`
  entries. Bump it with every code change: patch for a fix, minor for a new feature or a
  change players have to learn. Never reuse a number.
- **Wiki**: `wiki/` is mirrored to the GitHub wiki by `.github/workflows/sync-wiki.yml` on
  every push to `dev` that touches it (website edits are overwritten). Update it in the same
  commit as any player-visible change.
- **Test scripts**: every build DW is to test live comes with `script_test.md` (local, not
  committed): numbered checkbox steps, each with Do / Expect / Fail if, expected text copied
  from the source.
- The bot process runs from `build/` and is supervised by the panel; rebuilding on disk
  does not affect the running process until restart.
- **pending_update.txt convention**: when deploying a player-visible change, overwrite
  `pending_update.txt` (committed). The file is never deleted — a per-role
  `pending_update_seen_*.txt` marker records which version each process has already
  restarted onto. Format:

  ```
  <timestamp>[ | minor]     version stamp; " | minor" suppresses the room announcement
  <headline>                the ONLY line posted to room chat
  <detail...>               optional; whispered by !changelog, never posted in room
  ```

  Keep the headline genuinely short — room chat shows nothing else. Put the reasoning
  in the detail lines. On restart the bot appends the entry to `changelog.json`, and
  players who were away get a one-line nudge to whisper `!changelog`.
- Branches: `dev` is the working branch. `master` is deliberately the **tournament-free
  build** — the one the panel switches to if a live tournament misbehaves and the room
  still needs to work. That only helps if master is otherwise current, so **any change
  that is not specifically about tournaments must land on both branches**, and the shared
  code is kept byte-identical (lift blocks verbatim rather than retyping) so merging in
  either direction stays clean. Tournament-only files: `tournament.ts`, `tournamentLogic.ts`,
  `tournamentSim.ts`, plus their hooks in `game.ts`/`soloGame.ts`/`host.ts`/`types.ts`/
  `constants.ts`/`storage.ts`. Once a tournament has run for real, master can simply take
  the lot and this split goes away.
- Runtime data files (`players.json`, `game_counts.json`, `game_log.json`, ...) are
  tracked and churn constantly — commit them along with code changes, don't fret them.

## Conventions & gotchas

- BC-facing behavior lives in exact whisper/chat strings — refactors must not reword
  bot messages (players and the wiki-style help text depend on them).
- `tsconfig` has `strict: false`; don't rely on the compiler for null-safety.
- BC server silently drops over-long chat messages — use `sendLongWhisper` for
  anything that can exceed ~900 chars.
- Emit pacing matters: bursts of item applies/locks are staggered (see
  `END_GAME_EMIT_STAGGER_MS` etc.) to stay under BC's rate limit.
- Lock-apply verification model: BC never echoes your own successful item update back;
  silence during the verify window = success, a `ChatRoomSyncSingle` showing the lock
  missing = rejection (see `pendingLockApplyChecks`).
- `outfits.json` groups arrays must use BC group names (e.g. `ItemArms`), not item names.
- Design docs for bigger features live in `docs/`.
