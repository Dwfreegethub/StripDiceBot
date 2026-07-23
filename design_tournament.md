# StripDiceBot — Solo Tournament Mode

**Status:** Design complete, not yet implemented. Build after WinnersDice feature work settles down.

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

The 3 games do not have to be played in one session. The bot tracks per-game scores in `tournament.json` so a player can play game 1, leave, and return later for games 2 and 3 within the round window.

---

## Registration

- Command: `!tournament register`
- Sign-up window: **1 week** (configurable)
- Minimum players to start: **6**
- No maximum (open field — byes handle odd numbers)
- Players are shown their registration confirmation via whisper
- `!tournament` shows current registrations and time remaining in the sign-up window

---

## Rounds

- Each round is **48 hours** long
- Rounds advance automatically at **midnight UTC**
- At round start: all active players are paired, assignments written to `tournament.json`
- When a player joins the room during an active round, the bot whispers them their opponent and current match status
- If both players complete their games before the 48-hour window closes, the result is finalized immediately — no need to wait

### What "midnight UTC" means in practice

The bot checks whether a round should advance on any activity event (player join, game end, etc.) — similar to how `pending_update.txt` is polled. If the current UTC time is past the round deadline and the round hasn't been advanced yet, it advances then. This avoids needing an external cron job.

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

- **Who gets it:** Highest-ranked player in that record group who has not yet received a bye in this tournament. If all have received a bye, randomize.
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

**Not yet designed.** This section needs DW input before implementation. Questions to answer:

- Does the winner receive a public announcement? Bondage applied to runner-up?
- Are there per-round consequences (e.g., loser of each match gets a brief bondage penalty)?
- Is there an in-room prize display or title?
- Do consequences scale with how far into the tournament you lost?

---

## Clothing Enforcement

The bot checks the player's current clothing item count at the start of each tournament game session. If the count is not exactly 6:

```
⚠️ Tournament games require exactly 6 clothing items.
You currently have [X]. Please adjust and type !tournament play to try again.
```

The player adjusts their outfit manually and retries. The bot does not auto-apply an outfit — players wear whatever 6 items they choose. This is consistent with how the existing solo flow works.

---

## State File: `tournament.json`

Persists all tournament state across bot restarts. Structure (approximate):

```json
{
  "status": "registration" | "active" | "complete",
  "signUpDeadline": "<ISO timestamp>",
  "currentRound": 1,
  "roundDeadline": "<ISO timestamp>",
  "players": [
    {
      "memberNumber": 12345,
      "name": "Alice",
      "wins": 1,
      "losses": 0,
      "byesUsed": 0,
      "eliminated": false
    }
  ],
  "matches": [
    {
      "round": 1,
      "playerA": 12345,
      "playerB": 67890,
      "gamesA": [30, 22, 41],
      "gamesB": [],
      "result": null
    }
  ]
}
```

---

## Commands

| Command | Who | Description |
|---------|-----|-------------|
| `!tournament register` | Any player | Register for the next tournament during sign-up |
| `!tournament` | Any player | Show standings / registration status / round info |
| `!tournament play` | Registered player | Start your next tournament game for this round |
| `!tournament status` | Any player | Alias for `!tournament` |

Admin commands (design when needed):
- Cancel tournament
- Manually advance round
- Override a match result

---

## Open Questions (pre-implementation)

1. **Rewards and consequences** — see section above
2. **Auto-start vs admin trigger** — does the tournament start automatically at midnight when sign-up closes, or does an admin need to confirm?
3. **Can a player withdraw after registering?** (before the tournament starts vs mid-tournament)
4. **What if the field drops below a viable size mid-tournament** (e.g., multiple double-eliminations leave 2 players with very different records)?

---

## Implementation Notes

- Build after WD feature work is settled
- Solo game flow changes needed: tournament mode flag to lock bracket at 6, record per-game scores, suppress normal solo end announcements in favor of tournament-specific ones
- Swiss pairing logic: sort active players by W-L record, pair top of each group against next, handle odd groups with byes
- Round advancement: timestamp check on activity events (no external scheduler needed)
- `tournament.json` should be gitignored (like `players.json`, `pair_balances.json`)
