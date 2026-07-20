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
| `src/storage.ts` | `BotStorage` — ALL JSON/data file reads and writes, one method pair per file |
| `src/host.ts` | `GameHost` interface — the only surface managers may use to reach shared machinery |
| `src/constants.ts` | Every tuning knob (timers, brackets, slots, consent tiers, labels) |
| `src/types.ts` | Shared interfaces/enums. Import-free by design |
| `src/util.ts` | Pure stateless helpers (no I/O) |
| `src/outfits.ts` | Loads `outfits.json` + `bc_items.json` at startup → `BONDAGE_OUTFITS`, `BC_ITEM_CATALOG` |
| `src/logger.ts` | Central-time logging (`log`, `logError`, `logGameEvent`) |

Dependency direction (never violate — module-load cycles crash the bot at startup):
`types` ← `constants`/`util` ← `outfits`/`storage` ← `host` ← `soloGame`/`feedback` ← `game` ← `index`.
Managers must NEVER import `game.ts`.

## Where new code goes

- **New command**: add a `commandTable` entry in game.ts (longer prefixes before shorter,
  e.g. `"!feedback list"` before `"!feedback"`). Implement the handler in the subsystem
  it belongs to, or in game.ts for multiplayer-core commands.
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
  touching `build/`. No test suite — the compiler and a live game are the safety net.
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
- Branches: `dev` is the working branch; merge to `master` when field-tested stable.
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
