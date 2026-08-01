# StripDiceBot — Solo Tournament Mode

**Status:** Playable end-to-end on the `tournament` branch, **never run live**. Everything below marked ✅ is built and covered by the simulator; ⬜ is not started. Branch is not merged to `dev`.

---

## Build Status (as of 2026-07-31)

### ✅ Done

**Plumbing**
- `BCConnection.beep()` / `onAccountBeep()`, ported from SlaveParking/WinnersDice. `!testbeep <memberNumber|name> [message]` (admin) verifies delivery and warns if the target isn't mutually friended. Incoming beeps log their full payload.
- `parseDuration()` / `parseWhen()` / `formatDuration()` in `util.ts` — plain-language times (`1 hour`, `48 hours`, `3 days`, `1 week`, `90m`, `2d`, `1 day 12 hours`, bare number = minutes).
- Tournament types in `types.ts`; `tournament.json` load/save/archive plus an append-only `tournament_game_log.txt` in `storage.ts`. All tournament files gitignored.

**Bracket logic** — `tournamentLogic.ts`, pure (no I/O, no `Date.now()`, no BC calls)
- Swiss pairing with float-down between record groups, rematch avoidance, and **at most one bye per round** (see *Byes* — this deviates from the original per-record-group wording, which produced several free wins per round).
- Match resolution: points → total rolls → **hidden elapsed-time tiebreaker** → `null` for admin review on a total dead heat.
- Standings/ranking, field evaluation (continue / grand final / decided / empty), punishment scaling with configurable grace rounds.

**Simulator** — `tournamentSim.ts`, run with `npm run sim` (~1 second)
- 107 assertions plus 660 synthetic tournaments across field sizes 2–32, asserting every round that at most one bye exists, every active player is paired exactly once, nobody faces themselves, and nobody stays active past two losses.
- Uses a stub `GameHost`, so setup, registration, round flow and serving are all exercised with no bot and no file writes.
- Has already earned its keep: caught a double-forfeit bug that credited no losses, and surfaced the empty-field case.

**Tournament manager** — `tournament.ts`
- `!tournament setup` — 8-question admin interview, per-answer validation with re-ask, summary + yes/no confirm before anything is written, 5-min timeout, `cancel` aborts. Whisper-only (its answers are free text).
- `!tournament register` — **friend-gated**: holds the signup, waits up to 10 min for the mutual friend link, completes automatically via `onFriendAdded()`. Already-friended players register in one step.
- `!tournament withdraw`, `!tournament` / `status` (standings + a personal "what do I do next" block), `!tournament rules` (rendered from live config, so a test tournament states its own real times).
- Admin `pause` / `resume` / `cancel` (archives to `tournament_<stamp>.json`), and `freeze(reason)` for rulings.
- Round machinery, activity-driven (no scheduler): registration close → Round 1, deadline → force-resolve, punish, advance or finish. Byes auto-resolve on creation. Champion and runner-up have their punishment cleared.
- `!tournament play` — full gating (registered, not eliminated/withdrawn, has a match, games left, owes no punishment), builds the game context.
- Score recording with room commentary on who leads on total rolls; match resolution the moment both sides finish.
- `!tournament serve` / `!tournament stop` with disconnect tolerance (see *Serving Punishment Time*). `canClaim()` limits claiming to other tournament players.
- **`!claim` for prisoners** — reuses the end-game prize machinery. Starting a sentence mints a per-prisoner password; `!claim` lists who's available (serving, unheld, in the room, not yourself), `!claim 1` takes one: the claimer gets the password, the prisoner gets a collar-and-leash on the same lock, and the room is told. Releasing their locks does **not** clear the sentence — the time is still owed. A claim ends when the sentence does, when they stop serving, or when the claimer leaves the room. End-game prizes take precedence over tournament prisoners on the shared `!claim` command, so the two never collide.

**Solo integration** — the two managers never import each other; they meet on `GameHost`
- `startTournamentGame` / `reportTournamentGame` / `tournamentPunishMs` / `applyTournamentPunishment` / `releaseTournamentPunishment`.
- Tournament games: clothing count enforced exactly, **no solo records, no attempts ladder, no end-of-game bondage**, tournament-flavoured announcements.
- A game whose player leaves is **parked** for 10 minutes: return and it resumes exactly where it was; miss it and the game is voided with no score and must be replayed.

### ⬜ Not started

| Item | Notes |
|---|---|
| Dispute system | `!tournament replay` / `deny` / `reverse`, the post-round "do you agree?" prompts, `tournament_disputes.log`. Recommend **skipping for tournament #1** — `!tournament pause` plus reading `tournament_game_log.txt` covers a rehearsal you're present for. |
| Early round start vote | "Everyone finished — start the next round now?" Purely a convenience; rounds already close on their deadline. |
| `!tournament advance` | Admin manual round advance, listed under Admin Commands. Useful for testing. |
| Round status on entry | Design says a player entering mid-round is whispered their opponent and match status. Currently only punishment is handled on entry; they must run `!tournament` themselves. |
| Punishment bondage look | Undecided. Currently picks a random one of the nine themed solo sets, isolated behind `applyTournamentPunishment()` — swapping it touches one method. |

### Deliberately not doing

- **Clothing auto-detection.** The design says the bot checks the worn item count; it actually asks, as the solo flow always has. Self-declaration is the accepted v1 behaviour (see the `Emily: autodetect worn clothing` item in `todo.md`).
- **Minimum-player enforcement.** 6 is advisory and stated as such in the setup summary; a smaller field still runs, so a 2-player rehearsal needs no special-casing. Below 2 the tournament auto-cancels.

### Known gaps / risks

- **Never field-tested.** Everything is simulator-verified only. The first live run should be a throwaway with short durations.
- **Beeps are unproven on this bot.** `!testbeep` exists precisely to check delivery, and whether the message text rides along (WinnersDice's notes flag that as unverified). Nothing depends on a beep landing — every notification is recoverable via `!tournament` — but confirm before relying on them.
- **In-memory state lost on restart:** a half-finished `!tournament setup` interview and any pending friend-gated registration. Both are cheap to redo. Everything else lives in `tournament.json`.
- **Round advancement needs activity.** With no external scheduler, a dead-quiet room means rounds sit until someone shows up. Acceptable, but it means deadlines are "at or after", never exact.
- **10-minute grace windows** (`TOURNAMENT_RESUME_GRACE_MS`) may be long relative to a 1-hour test round. Single constant, easy to change.

### Suggested order from here

1. Round status on entry — small, and the most-missed piece of polish for an async format.
2. A throwaway live tournament: 2–3 players, `now` / `5 minutes` / `now` / `1 hour` rounds, `0` grace rounds, tiny punishments. Exercises every path in an afternoon.
3. Disputes and the early-start vote only if the format survives contact.

(`!claim` shipped 2026-08-01 — see Done.)

---

## Decisions (2026-07-31)

1. **Tournament games are completely separate from solo records.** They never write daily/all-time records and never touch `attemptsToday`. A tournament game therefore never inherits the +2 min/loss/day solo penalty ramp — tournament lock times come only from the punishment table below.
2. **Lock times are the ones in this document** (15 min first loss, 1 hour on elimination), not the solo penalty values.
3. **Serving is player-controlled and interruptible.** A player serving punishment time can ask to stop, be released, leave, and come back later to serve the remainder. See *Serving Punishment Time*.
4. **Tie-of-ties breaker: total elapsed time across the 3 games — fastest wins.** Applied only when match points *and* total rolls are both tied. **Not announced up front**; only revealed if it actually decides a match. Requires per-game duration tracking.
5. **All durations are configured at setup**, in plain language, accepting minutes/hours/days (e.g. `1 hour` rounds for a test run). Nothing time-related is hardcoded.
6. **Tournament #1's shape is undecided** — DW will choose once it is built. Expect a small test tournament before a real one, so short round lengths must work.

---

## Serving Punishment Time

Punishment is **bound in the room + claimable** (prize mode), for the duration in the punishment table. Because an hour is a long time to be stuck, serving is interruptible:

- The clock runs while the player is **actively serving** — bound and claimable.
- **Entering the room never binds anyone.** If time is owed the bot asks whether they're ready and waits for a yes. A player who was *already* bound and merely dropped out is not asked again — they never stopped serving.
- A player may ask to stop early. The bot releases them and banks the remaining time; they keep whatever balance is left.
- Returning later, they ask to serve again and the bot re-applies the bondage for the remaining balance.
- **A short disconnect does not pause the clock.** BC drops people routinely and a dropped connection must not lengthen a sentence, so the time keeps running for the grace window (`TOURNAMENT_RESUME_GRACE_MS`, 10 min). Return inside it and nothing was interrupted. Fail to return and the sentence is paused **retroactively, as of the moment they vanished** — so the grace period is never credited to someone who simply logged off.
- Pause-on-no-return is evaluated on activity ticks rather than a timer, so it still holds correctly across a bot restart.
- The balance persists across bot restarts — it is stored in `tournament.json`, not in memory.
- BD stays locked for that player until the balance reaches zero.

Commands: `!tournament serve` begins or resumes, `!tournament stop` releases and banks the remainder, and `!tournament` shows the time left.

---

## Overview

A periodic solo tournament run entirely within the existing BD room. Players register during a sign-up window, get paired each round using Swiss pairing, and are eliminated after 2 losses. Each match is a best-of-3 async solo games with a fixed clothing count.

No new room needed. Runs alongside normal BD activity — tournament games use the existing solo game flow.

---

## Format

### Swiss + Double Elimination

- Same record plays same record each round (Swiss pairing).
- A player is eliminated after accumulating **2 losses**.
- Final 2 remaining players play the grand final.
- This format is used in Pokemon, Magic: The Gathering, and chess tournaments. It rewards consistency and gives everyone a second chance before elimination.

### Match Structure (per round)

Each match consists of **3 solo games** between two assigned opponents played **asynchronously** (one player plays their 3 games, then the other plays theirs — they do not need to be online at the same time).

- **Mode:** Survive (play until fully bound)
- **Clothing:** Fixed at **6 items**. Bot checks at the start of each game session and reminds the player to adjust if their count is wrong.
- **Score:** Number of rolls survived (higher = better)
- **Per-game result:** Win (1 pt), Draw (½ pt each), Loss (0 pt)
- **Match winner:** Player with more points after 3 games
- **Tiebreaker (match only):** If points are tied after 3 games, total rolls across all 3 games decides the winner. This tiebreaker applies only to that match — it does not carry into tournament standings.
- **Second tiebreaker (hidden):** if points *and* total rolls are both tied, the player whose 3 games took less total elapsed time wins. This is deliberately **not advertised** — players are only told about it if it actually decides their match, so nobody plays to the clock. Per-game durations are recorded for every tournament game.

The 3 games do not have to be played in one session. The bot tracks per-game scores in `tournament.json` so a player can play game 1, leave, and return later for games 2 and 3 within the round window.

### Punishment

- **Round 1 is a grace round — no punishment applies.** All players play their match normally; losers just take a loss on their record.
- **Rounds 2+ onward:** punishment applies to match losers (design TBD — see Rewards and Consequences section).
- This gives new players a chance to experience the format before stakes kick in.

---

## Registration

- Command: `!tournament register`
- Sign-up window: **1 week** (configurable at tournament creation)
- Minimum players to start: **6**
- No maximum (open field — byes handle odd numbers)
- Players are shown their registration confirmation via whisper
- `!tournament` shows current registrations and time remaining in the sign-up window
- **Players must be mutually friended with the bot** to receive tournament beeps (round assignments, results, early-start votes, display time reminders). BC's friend list is mutual-gated: the player adds the bot *and* the bot adds them back (BD already does this via `!friend` / `handleFriendRequest`). Bot prompts at registration if not already friended.
- **Beeps are best-effort and online-only.** BC delivers a beep only if the target is logged in — an offline player simply never gets it. Nothing in the tournament may depend on a beep arriving: every notification must also be recoverable by the player on demand (`!tournament`) and re-delivered by whisper when they next enter the room. Beeps are a convenience, never the source of truth.
- When a registered player enters the room during an active tournament, the bot whispers them their current round status (opponent, games completed, time remaining).

---

## Rounds

- Each round is **48 hours** long
- Rounds advance automatically at **midnight UTC** on the configured start day
- At round start: all active players are paired, assignments written to `tournament.json`
- When a player joins the room during an active round, the bot whispers them their opponent and current match status
- If both players complete their games before the 48-hour window closes, the result is finalized immediately — no need to wait

### What "midnight UTC" means in practice

The bot checks whether a round should advance on any activity event (player join, game end, etc.) — similar to how `pending_update.txt` is polled. If the current UTC time is past the round deadline and the round hasn't been advanced yet, it advances then. This avoids needing an external cron job.

### Early round start

After each player completes their 3 games for the round, the bot immediately whispers them:

```
You've finished your round [N] games. All players finishing early can start the next round now.
Are you okay with starting early if everyone else agrees? (YES / NO)
```

- If every active player (no byes, no forfeits pending) responds YES, the next round begins immediately — no waiting for the scheduled deadline.
- The new round's deadline is set to **now + round length**, so players get the full configured window from whenever the early start fires.
- A player who does not respond is treated as **no** — the round advances on schedule.
- Players who received a bye this round are automatically counted as YES (they have no games to finish).

---

## Forfeits and No-Shows

| Situation | Result |
|-----------|--------|
| Player A plays, Player B does not | Player A wins by default |
| Neither player plays | Both take a loss |
| Player A plays 1-2 games, round expires | Completed games count; unplayed games scored as losses |

The double-loss case (both no-show) can eliminate two players at once, which may create an odd number for the next round. Byes handle this.

---

## Byes

When an odd number of players share the same record, one receives a bye:

- **Who gets it:** Highest-ranked player who has not yet received a bye in this tournament (fewest byes wins the tie — deterministic rather than random, so pairing is reproducible in the simulator).
- **One bye per round, maximum.** Original wording gave a bye to any odd *record group*, which hands out several free wins per round (6 players splitting 3/3 after round 1 would produce two). Instead the ranked field floats players down between record groups, and a bye only exists when the **total** active count is odd — standard Swiss behaviour. Enforced by a simulator invariant.
- **Result:** Automatic win (1 match win), no games played, no roll score recorded
- **Tiebreaker impact:** Bye rounds contribute 0 to total rolls — they do not inflate or penalize the tiebreaker

---

## Standings and Status

- `!tournament` — current standings: W-L record, opponent this round, round time remaining
- Standings displayed in W-L order, similar to the existing `!leaderboard` format
- Eliminated players shown at the bottom with their final record
- Available to anyone in the room at any time during the tournament

---

## Rewards and Consequences

### Champion (1st place)
- Public room announcement declaring the winner.
- **Fully exempt** from all display punishment.

### Runner-up (2nd place)
- **Fully exempt** from all display punishment.
- The grand final always produces a definitive 1st and 2nd — no ambiguity.

### Punishment — loss-based scaling

| Loss | Punishment | Notes |
|------|-----------|-------|
| Any loss in Round 1 | None | Grace round — no punishment for anyone |
| 1st loss (Round 2+) | 15 min on display | Must be fully served before playing next round match |
| 2nd loss (elimination) | 1 hour on display | Served after elimination; BD locked until complete |

- **"On display" means bound in the room and in prize mode** — the loser stays in the bondage the game already put them in, and is listed as claimable so anyone in the room can `!claim` them, take the leash, and move them around. It is not a separate display mechanic; it reuses the existing bondage + prize/claim machinery. Longer punishments are exactly when being grabbable matters most.
- Display time does **not** need to be served consecutively — a player can leave and return, and the bot tracks remaining time.
- **BD is locked** for the player until their display time is fully served. They cannot start or join a BD game while time is outstanding.
- The 15-minute serve requirement before the next match creates real time pressure — a player who loses early in a round must finish their display time within the round window to stay competitive.

**Reuse note:** a Survive game already ends with the player naked and, unless they beat the daily record, already applies themed/preset bondage on a timed lock (`SOLO_BASE_PENALTY_MINUTES`, currently 10 min +2 per repeat loss). Tournament punishment is therefore mostly a *duration change plus a claimable flag* on machinery that already exists — not a new subsystem. What is genuinely new: the claim registry must accept "claimable by anyone in the room" entries (today's `prizePasswords` is scoped to that game's winners via `claimableBy`), and remaining time must survive a bot restart.

### Implementation notes
- Bot tracks `displayTimeRemainingMs` per player in `tournament.json`.
- When a player enters the room with outstanding time, bot whispers a reminder and puts them on display / lists them as a prize.
- Before a player can use `!tournament play`, bot checks for outstanding display time and blocks if any remains.
- BD lockout check: before starting any solo or multiplayer game, bot checks outstanding tournament display time.

---

## Clothing Enforcement

The bot checks the player's current clothing item count at the start of each tournament game session. If the count is not exactly 6:

```
⚠️ Tournament games require exactly 6 clothing items.
You currently have [X]. Please adjust and type !tournament play to try again.
```

The player adjusts their outfit manually and retries. The bot does not auto-apply an outfit — players wear whatever 6 items they choose. This is consistent with how the existing solo flow works.

---

## Withdrawal

- **`allows_withdrawal`** is configured at tournament creation (yes/no question during `!tournament setup`).
- If enabled: players may withdraw **between rounds only** — not mid-round while their match is in progress.
- Withdrawing mid-tournament still counts as a loss for that round (punishment applies if it's round 2+). The intent is to prevent players from dropping to dodge a penalty.
- If a player withdraws, their current-round opponent gets a bye win.
- Withdrawn players do not appear in active standings but are shown in a "withdrew" section.

---

## Field Collapse

When the active field drops to a problematic size mid-tournament:

- **Field reaches 2 players:** force the grand final immediately, regardless of records.
- **Mathematically decided winner** (e.g., one player has 0 losses and the other has 2 after round results): bot auto-awards the tournament to the undisputed leader and announces the result. No need for an additional final.
- **Empty field — both finalists no-show.** Surfaced by the simulator: if the last two active players *both* fail to play, the double-forfeit rule eliminates both and nobody is left to crown. This happened in roughly 1.5% of simulated tournaments (with a deliberately pessimistic no-show rate). `evaluateField()` reports `empty` for this case. **Unresolved:** award to the best record among the eliminated, replay the final, or freeze for admin decision? Needs a ruling before punishment-enabled tournaments run.
- **Admin pause as safety net:** `!tournament pause` freezes advancement if an edge case arises that needs manual review. Use `!tournament resume` to continue. This is the fallback — the auto-rules above should handle most situations.

---

## Dispute System

After each round's results are delivered, every player is immediately asked via whisper:

```
✅ Round [N] result: you [won/lost] against [Opponent].
Do you agree with this result? Reply YES or NO.
```

- **YES:** logged, no further action.
- **NO:** bot asks for a reason via follow-up whisper. Reason is logged to `tournament_disputes.log`. Bot beeps the admin with the dispute summary.

Admin receives a beep containing: round number, players involved, recorded scores, and the disputing player's stated reason.

Admin dispute commands:
| Command | Effect |
|---------|--------|
| `!tournament replay <matchId>` | Nulls the match result; both players must replay their 3 games within a new window |
| `!tournament deny <matchId>` | Dispute denied; original result stands; player notified via whisper |
| `!tournament reverse <matchId>` | Flips the result (loser becomes winner); use if scores were recorded wrong |

- Admin must be present in the room to use dispute commands.
- The bot keeps per-game score logs for every tournament game (see Logging section) so admin can review raw rolls before deciding.

---

## Tournament Logging

Every tournament game is logged with enough detail to reconstruct disputes:

- Timestamp, round number, match ID, player member number and name
- Per-game: each individual roll result, final score (rolls survived)
- Match outcome and how it was determined (score, tiebreaker, forfeit, etc.)
- Any dispute events and admin resolutions

Log format: append-only to `tournament_game_log.txt` (gitignored), similar to `sss_telemetry.md`. Structured so each match's games are grouped and easy to visually scan.

---

## Admin Commands

| Command | Who | Description |
|---------|-----|-------------|
| `!tournament setup` | Admin | Interactive tournament creation (see Setup section) |
| `!tournament cancel` | Admin | Cancel an active or upcoming tournament (with confirmation) |
| `!tournament advance` | Admin | Manually advance to the next round (testing only) |
| `!tournament pause` | Admin | Freeze round advancement for manual review |
| `!tournament resume` | Admin | Resume a paused tournament |
| `!tournament replay <matchId>` | Admin | Null a match result and require a replay |
| `!tournament deny <matchId>` | Admin | Deny a dispute; original result stands |
| `!tournament reverse <matchId>` | Admin | Reverse a match result |

---

## Tournament Setup (`!tournament setup`)

Admin runs `!tournament setup` and the bot asks questions via sequential whispers:

1. **Registration start** — "When does registration open? (e.g. `now`, `3 days`, or `2026-08-10`)"
2. **Registration length** — "How long is the sign-up window? (e.g. `1 week`, `2 hours`)"
3. **First round start** — "When does Round 1 begin? (same formats)"
4. **Round length** — "How long is each round? (e.g. `48 hours`, `3 days`, `1 hour`)"
5. **First-loss punishment** — "How long on display for a first loss? (e.g. `15 minutes`)"
6. **Elimination punishment** — "How long on display when eliminated? (e.g. `1 hour`)"
7. **Allow withdrawals?** — "Can players withdraw between rounds? (YES / NO)"
8. **Confirmation** — Bot summarizes all settings and asks "Confirm? (YES / NO)"

**Duration input** accepts minutes, hours, days and weeks in plain language — `90 minutes`, `1 hour`, `48 hours`, `3 days`, `1 week`, compact forms (`90m`, `36h`, `2d`), and combinations (`1 day 12 hours`). A trailing `from now` is ignored. Absolute `YYYY-MM-DD` dates are also accepted for the two start times. Everything is stored internally as UTC ISO timestamps / millisecond durations.

Short durations are explicitly supported so a full tournament can be rehearsed in an afternoon (e.g. 1-hour rounds, 5-minute punishments).

After confirmation, bot announces registration open to the room and writes `tournament.json`.

`!tournament cancel` can be used at any point before the grand final concludes. Bot asks for a single YES confirmation, then clears `tournament.json` and announces cancellation to the room.

---

## Player Commands

| Command | Who | Description |
|---------|-----|-------------|
| `!tournament register` | Any player | Register for the next tournament during sign-up |
| `!tournament` | Any player | Show standings / registration status / round info |
| `!tournament play` | Registered player | Start your next tournament game for this round |
| `!tournament status` | Any player | Alias for `!tournament` |
| `!tournament withdraw` | Registered player | Withdraw from the tournament (if allowed and between rounds) |
| `!tournament serve` | Player owing time | Begin or resume serving punishment (bound + claimable) |
| `!tournament stop` | Player serving | Stop early; the remaining balance is kept for later |
| `!tournament rules` | Any player | Full format explanation, rendered from the live config |

All player commands work from room chat as well as whisper; replies are always whispered. `!tournament setup` is whisper-only, since its answers are free text.

---

## State File: `tournament.json`

Persists all tournament state across bot restarts. Structure (approximate):

```json
{
  "status": "registration" | "active" | "paused" | "complete",
  "allowsWithdrawal": true,
  "signUpDeadline": "<ISO timestamp>",
  "firstRoundStart": "<ISO timestamp>",
  "roundLengthMs": 172800000,
  "currentRound": 1,
  "roundDeadline": "<ISO timestamp>",
  "players": [
    {
      "memberNumber": 12345,
      "name": "Alice",
      "wins": 1,
      "losses": 0,
      "byesUsed": 0,
      "eliminated": false,
      "withdrew": false
    }
  ],
  "matches": [
    {
      "id": "r1-m1",
      "round": 1,
      "playerA": 12345,
      "playerB": 67890,
      "gamesA": [30, 22, 41],
      "gamesB": [],
      "result": null,
      "disputed": false,
      "disputeReason": null,
      "adminResolution": null
    }
  ]
}
```

`tournament.json` and `tournament_game_log.txt` and `tournament_disputes.log` should all be gitignored (like `players.json`, `pair_balances.json`).

---

## Implementation Notes

- Build after WD feature work is settled
- **Tournament games reuse the existing Survive flow.** A tournament game *is* a solo Survive game — same rolls, same removal detection, same end-of-game bondage. The tournament layer adds a flag on the solo game that: locks the bracket at 6, reports the final score back to the tournament manager, and swaps the normal end-of-game messaging for tournament wording. Everything else (dice chain, wardrobe watching, lock+verify) is shared code, untouched.
- **Decisions the shared flow forces** (see Open Questions): whether tournament games feed the daily/all-time records and the `attemptsToday` ladder — that ladder escalates the penalty by +2 min per loss per day, and a 3-game match means it ramps fast.
- **Beep plumbing exists as of the tournament branch**: `BCConnection.beep()` + `onAccountBeep()`, ported from SlaveParking/WinnersDice, with `!testbeep <memberNumber|name> [message]` for admins to verify delivery (and to confirm the offline case fails silently).
- Swiss pairing logic: sort active players by W-L record, pair top of each group against next, handle odd groups with byes
- Round advancement: timestamp check on activity events (no external scheduler needed)
- Dispute commands require admin to be in-room (same pattern as existing admin commands)
- Grace round (round 1): pass a `graceRound: true` flag through to punishment logic so it's a clean conditional, not hardcoded

---

## Player-Facing Text

### Short Announcement (room chat / social post)

🎲 **StripDice Solo Tournament — Coming Soon!**

Think you can survive the dice? Our first solo tournament is coming. Sign up with `!tournament register` when registration opens.

Each round you face one opponent. You each play 3 solo games on your own time — no need to be online together. Most rolls survived wins. Lose twice and you're out. Last player standing wins.

Round 1 is a free round — no punishment. After that, losses cost you display time. Lose once and you serve 15 minutes on display before your next match. Lose a second time and you're out — with an hour on display as your send-off. Champion and runner-up walk away free.

Type `!tournament rules` for full details.
Registration opens: **[DATE]** — First round: **[DATE]**

---

### Detailed Rules (`!tournament rules`)

🎲 **StripDice Solo Tournament — Rules**

**Format**
Swiss + double elimination. Each round you are paired against one other player with a similar record. Lose twice and you are eliminated. The last two players meet in the grand final. There is always a clear 1st place and 2nd place.

**Joining**
Type `!tournament register` during the sign-up window. You must be friends with the bot to receive messages — it will send you a request when you register. Accept it or you will miss round assignments and results.

**How a match works**
Each match is 3 solo games. You do not need to be online at the same time as your opponent. You each play your 3 games when you can, within the round window.

- Mode: Survive
- Clothing: exactly 6 items. The bot checks at the start of each game. If your count is wrong, adjust and try again.
- Score: number of rolls survived. More = better.
- Win = 1 point, Draw = ½ point each, Loss = 0 points
- Most points after 3 games wins the match. If tied, total rolls across all 3 games decides it.

**Rounds**
Each round lasts 48 hours. When you finish your games, the bot will ask if you are okay starting the next round early. If every active player agrees, the next round starts immediately and runs for the full 48 hours from that point.

**Punishment**

Round 1 is a grace round. No punishment for anyone in round 1.

From round 2 onward, losses cost you display time. You will be placed on display in the room and listed as a prize for the duration.

| Loss | Punishment |
|------|-----------|
| Any loss in round 1 | None |
| 1st loss (round 2+) | 15 minutes on display |
| 2nd loss — eliminated | 1 hour on display |
| Runner-up (2nd place) | No punishment |
| Champion (1st place) | No punishment |

After your first loss, you must serve your 15 minutes on display before you can play your next round match. You cannot skip it.

Display time does not need to be served all at once. You can leave and come back — the bot remembers your remaining time. You cannot play BD at all while you have outstanding display time.

**If you do not finish your games in time**

| Situation | Result |
|-----------|--------|
| You played, your opponent did not | You win |
| Neither of you played | Both take a loss |
| You played some games, time ran out | Finished games count; unplayed games score as losses |

**Results and disputes**
After each round the bot will ask if you agree with your result. If you do not agree, reply NO and give a reason. The admin will be notified and can review the game logs, then replay the match, deny the dispute, or reverse the result.

**Withdrawing**
If the tournament allows withdrawal, you may only withdraw between rounds — not while your match is in progress. Withdrawing still counts as a loss for that round and punishment still applies. You cannot drop out to avoid your display time.

**Commands**

| Command | What it does |
|---------|-------------|
| `!tournament register` | Sign up for the upcoming tournament |
| `!tournament` | See standings, your opponent, time remaining |
| `!tournament play` | Start your next tournament game |
| `!tournament withdraw` | Leave the tournament (between rounds only, if allowed) |
