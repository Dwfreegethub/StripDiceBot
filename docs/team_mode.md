# Team Mode — Implementation Plan

**Bot:** StripDiceBot (BD)
**Status:** Design finalized by DW — ready for implementation
**Depends on:** existing multiplayer game loop (`GameState`, `Player`, `turnOrder`, `choosePickerFor`, `checkGameEndCondition`)

---

## 1. Overview

A new game mode where the lobby splits into two teams instead of one free-for-all pool. Turns strictly alternate between teams. The standard roll/loss/strip/bondage mechanics are otherwise unchanged — team mode is a layer on top of the existing game loop, not a rewrite of it. The game ends when every player on one team is fully bound; the other team wins.

This document assumes familiarity with the existing multiplayer flow in `src/game.ts` (see `docs/player_bondage_selection.md` for the sibling player-pick-bondage design, which team mode also interacts with).

---

## 2. Data Model Changes

### `Player` interface additions

```
team: 1 | 2 | null;        // null outside team mode; assigned at !join time in team mode
isGhost: boolean;           // true once this player has disconnected or safeworded mid-game
                             // (team mode only — see Section 7)
```

### `GameState`-adjacent additions (private fields on the game class, alongside existing `turnOrder`, `minPlayers`, `maxPlayers`, `lobbyOpen`)

```
isTeamMode: boolean;             // true for the lifetime of a !teamgame lobby/match
teamSize: number;                // players required per team (2 or 3), set once at lobby open
team1: Set<number>;              // memberNumbers on team 1
team2: Set<number>;              // memberNumbers on team 2
```

No new `GameState` enum values are needed — team mode reuses `Registration`, `Countdown`, `Rolling`, `WaitingRemove`, `WaitingBondage`, `SafewordPause`, `GameOver` exactly as today. The team-mode-ness of a match is carried by `isTeamMode` + the `team` field on each `Player`, not by a separate state machine.

---

## 3. New / Changed Commands

| Command | Behavior |
|---|---|
| `!teamgame` | Only valid from `GameState.Idle`. Bot whispers the host: "2 or 3 players per team?" Host reply sets `teamSize` and opens the lobby (`isTeamMode = true`, `lobbyOpen = true`). |
| `!join team1` / `!join team2` | Only recognized while `isTeamMode` lobby is open. Extends the existing `!join`'s trailing-argument parsing (`handleJoin` already parses tokens after `!join`, e.g. `!join 3 5` for min/max — this is the same pattern, just matching the literal token `team1`/`team2` instead of a number). Assigns the player to that team's roster and proceeds through the normal clothing-declaration/ready flow exactly as `!join` does today. |
| `!join` (bare, no team) during an open team lobby | Rejected — bot whispers "This is a team game — whisper `!join team1` or `!join team2`." |
| `!join` during an in-progress team game | Same as today's mid-game-join rejection ("a game is already in progress... you can watch"), team mode does not change late-join behavior — late joiners still just watch, no `midGameJoin` team-mode path is being built in this pass. |
| `!start` | Blocked (existing "not enough players" rejection, reworded for teams) until **both** `team1.size === teamSize` and `team2.size === teamSize`. |
| `!teams` | New. Whispers the sender the current roster: `Team 1: A, B (2/2) — Team 2: C, D (1/2)`. Works both during the open lobby and mid-game (shows who's ghosted, who's fully bound, etc. — see Section 9 formatting notes). |

---

## 4. Turn Order Construction

Standard mode shuffles `turnOrder` randomly at game start (`this.turnOrder = [...this.players.keys()]; this.shuffleArray(this.turnOrder);`). **Team mode skips the shuffle entirely.** Order is built deterministically, alternating teams, preserving each team's join order:

```
buildTeamTurnOrder():
    order = []
    team1Array = [...team1]   // in join order
    team2Array = [...team2]   // in join order
    for i in 0..teamSize-1:
        order.push(team1Array[i])
        order.push(team2Array[i])
    turnOrder = order
```

Result for a 2v2 game: `[T1P1, T2P1, T1P2, T2P2]`. For 3v3: `[T1P1, T2P1, T1P2, T2P2, T1P3, T2P3]`.

Everything downstream of `turnOrder` — `advanceTurn()`, `currentTurnIndex`, `getCurrentPlayer()` — is untouched. Team mode only changes how the array is *built*, never how it's walked.

---

## 5. Rolling & Loss Mechanics

Unchanged. Sequential turns, one roll at a time, no simultaneous rolls. `currentDiceMax` shrinking behavior, the D100 free-pass/double-penalty rules, and `handleLoss` all apply exactly as they do in standard multiplayer. The first player (in turn order) to roll a 1 loses that turn, same as today — team affiliation has no effect on the roll itself, only on turn order, win condition, and bondage targeting (Sections 4, 6, 8).

---

## 6. Win Condition

Replaces the "last player standing" branch of `checkGameEndCondition()` — team mode checks per-team completion instead:

```
checkGameEndCondition() [team-mode branch]:
    team1Bound = all p in team1 where !isGhost have isFullyBound == true
                 (an all-ghost team also counts as "bound" — see note below)
    team2Bound = all p in team2 where !isGhost have isFullyBound == true

    if team1Bound and team2Bound:
        # shouldn't happen in practice (mirrors today's simultaneous-bind edge case) — treat as a tie/no-winner, same as the existing all-players-bound branch
    elif team1Bound:
        winningTeam = team2
    elif team2Bound:
        winningTeam = team1
    else:
        return false  # game continues

    announce "🏆 Team [X] wins! Team [Y] is fully bound!"
    recordGameCompletion(...) — extend to log winningTeam, not just a single winner memberNumber
    applyEndGameLocks for the winning team's players (mirrors today's single-winner unbinding/lock flow, just for multiple players)
    return true
```

**Ghost players count toward "team bound"** — a ghost still accumulates losses via auto-rolls (Section 7) and can reach `isFullyBound`, same as an active player. A team where every player is either fully bound or ghosted-and-fully-bound is a loss for that team. This means a team can lose purely to ghost rolls if enough of its players disconnect — that's intentional per the ghost-roll design (Section 7), not a bug to guard against.

---

## 7. Ghost Rolls (Disconnect / Safeword mid-game)

**This is a deliberate divergence from standard mode's existing disconnect handling**, not an extension of it. Today, `onMemberLeave` gives a disconnected mid-game player a 2-round grace period (`pendingReturn`, `leaveRoundsRemaining = 2`) with *no* rolling penalty during that window — they're simply skipped in turn order until they return or the window expires. **Team mode does not use that path.** A team-mode disconnect immediately makes the player a ghost — no grace period, no skip-and-wait. This is the whole point of the design: a short-handed team should be disadvantaged (their ghost keeps losing) rather than the game stalling on a 2-round wait-and-see. Flagging this explicitly since it means the team-mode branch of `onMemberLeave` needs to route around the existing `pendingReturn` logic, not call into it.

```
onMemberLeave(memberNumber) [team-mode branch, replaces the pendingReturn path]:
    if isTeamMode and state is active gameplay:
        player = players.get(memberNumber)
        player.isGhost = true
        # player STAYS in turnOrder and in players map — unlike standard mode,
        # which deletes them. A ghost is still "in the game," just auto-losing.
        announce "${name} has disconnected — they'll auto-roll from now on."
        checkTeamBalanceAfterGhosting()   # see the "teams now even" flow below
        return
    # else: fall through to today's standard-mode pendingReturn behavior unchanged
```

```
On a ghost's turn (inside the normal roll-resolution path):
    if currentPlayer.isGhost:
        roll = 1   # always, no randomness
        announce "👻 ${currentPlayer.name} (ghost) rolls... 1!"
        handleLoss(currentPlayer)   # exactly the same call standard rolling makes for a real roll of 1
        return
    # else: proceed with the normal random roll as today
```

Ghosts still go through the *entire* normal loss flow — clothing removal prompts, bondage application, picker selection, everything — the only difference is the roll itself is skipped and hardcoded to 1. This is deliberate: a ghost can't type `!removed` or respond to picker prompts, so **the existing "missed turn" / timeout-and-auto-advance machinery already in the codebase handles the rest** — a ghost simply always times out on any prompt it can't answer, same as an unresponsive player does today. No new timeout logic is needed here; ghosting only changes what the *roll* does, not how the game reacts when a silent player can't respond to what follows.

---

## 8. Bondage Picker Targeting (Team Mode)

Extends `choosePickerFor(target)`. Today it filters to `!isFullyBound && !pendingReturn` across the *whole* player pool (see current implementation, `game.ts:4464`). Team mode adds a team filter as the first pass, falling back to the existing pool-wide logic if that first pass comes up empty:

```
choosePickerFor(target) [team-mode branch]:
    opposingTeam = target.team === 1 ? team2 : team1
    pool = [p in opposingTeam where p != target and !p.isFullyBound and !p.pendingReturn]

    if pool.length == 0:
        # opposing team is entirely bound or unavailable — fall back to
        # today's existing whole-pool logic (any active non-target player,
        # including the target's own teammates)
        pool = [p in players where p != target and !p.isFullyBound and !p.pendingReturn]
        if pool.length == 0:
            pool = [p in players where p != target and !p.isFullyBound]  # existing away-player fallback

    oldestLoss = min(pool.map(lastLossSeq))
    tied = pool.filter(lastLossSeq == oldestLoss)
    return random(tied)
```

The existing "favor whoever's gone longest without rolling a 1" tie-break is preserved unchanged within whichever pool is selected — team mode only changes which pool gets built first, not how a winner is picked from it. Ghosts are eligible pickers by this logic (nothing here excludes `isGhost`) — a ghost can't actually respond to a picker prompt, so a ghosted picker will time out and the existing picker-timeout fallback (auto-pick) applies, same as an unresponsive live player would today. Worth confirming during implementation whether ghosts should be excluded from the picker pool outright to avoid that timeout round-trip — not addressed by DW's finalized decisions, flagging as a small open call the implementer can make either way without design risk.

---

## 9. Safeword Handling in Team Mode

**DW's finalized decision:** "Just that player → becomes ghost. Immediately after, check if active (non-ghost) player counts are now equal between teams..." (full flow below).

**Important — this needs explicit scoping, flagged here rather than assumed:** the codebase has *two* separate safeword paths today:

1. **`!safeword` chat command** (`handleSafeword`) — pauses the whole game, asks everyone `!continue` within 60s, and only removes the safeworded player from `turnOrder`/`players` if the group confirms. This is the path DW's decision most naturally extends — team mode replaces the pause-and-vote with an immediate ghost transition instead.
2. **BC's native safeword event** (`handleBCSafewordEvent`) — described in the code's own comment as *"the non-negotiable emergency stop"*: it immediately ends the game for **everyone**, strips all bondage from all players, no continuation option at all, regardless of mode.

DW's decision text doesn't distinguish between these two. **This document assumes path 1 (`!safeword` command) gets the new team-mode ghost behavior, and path 2 (BC's native safeword event) stays exactly as it is today — a hard, whole-game stop for every player, team mode or not.** That's the safer default for an actual safety mechanism, and weakening it for team mode would be a real regression, not a design nicety. Flagging this explicitly for DW to confirm before implementation — do not silently build path 2 into the ghost flow without an explicit go-ahead.

```
handleSafeword(memberNumber, name) [team-mode branch, replaces the pause/vote flow]:
    if isTeamMode and state is active gameplay:
        removeAllItemsSafeword(memberNumber, name, memberNumber)   # unchanged — always strip immediately
        player = players.get(memberNumber)
        player.isGhost = true
        # unlike standard mode's handleSafeword, do NOT enter SafewordPause,
        # do NOT ask for !continue, do NOT delete from players/turnOrder
        announce "🔴 ${name} has safeworded — restraints removed, they're now auto-rolling for the rest of the match."
        checkTeamBalanceAfterGhosting()
        return
    # else: fall through to today's standard-mode pause/vote handleSafeword unchanged
```

### "Teams now even" rebalance check

Runs after *either* a disconnect-ghost or a safeword-ghost transition (Sections 7 and 9 both call this same routine):

```
checkTeamBalanceAfterGhosting():
    active1 = count(p in team1 where !p.isGhost and !p.isFullyBound)
    active2 = count(p in team2 where !p.isGhost and !p.isFullyBound)
    if active1 == active2:
        whisper all active (non-ghost) players:
            "Teams are now even — keep ghost rolls or drop them? Reply 'keep' or 'drop'."
        awaitingGhostDecision = true   # blocks normal rolling until resolved (mirrors existing awaiting* patterns like awaitingToysConsent)
```

```
On 'keep':
    awaitingGhostDecision = false
    # no state change — ghosts remain in turnOrder, game continues exactly as it was

On 'drop':
    awaitingGhostDecision = false
    for each ghost player:
        remove from turnOrder, remove from players map (same deletion the
        existing standard-mode safeword/leave paths already do)
    rebuildTeamTurnOrder()   # Section 4's algorithm, re-run against the
                              # now-smaller team rosters, preserving alternation
                              # and each remaining player's relative order
    if resulting teamSize per side == 1:
        # 1v1 — DW's note: "reverts to standard game rules." Set isTeamMode
        # = false for the remainder of this match; checkGameEndCondition and
        # choosePickerFor fall back to their existing non-team logic for the
        # rest of the game. team fields on the two remaining players become
        # irrelevant (left populated but unread once isTeamMode is false).
    announce the new team sizes and continue rolling from the current turn
```

**Who decides `keep`/`drop`?** DW's decision says "whisper all active players" but doesn't specify majority vs. unanimous vs. first-response. Flagging as an open question for implementation — the simplest reading that avoids a stuck game is **first valid reply wins** (whoever answers first, from either team, decides for the group), since requiring unanimity risks the game hanging on a silent player. Confirm with DW before building; noted here so it's a conscious choice, not an accidental one.

---

## 10. Deferred — Not Building Now

**Replacement player recruitment.** When a player goes ghost, the design *could* eventually recruit a replacement from the room who joins mid-game in the departed player's exact clothing/bondage state (continuing their team's position rather than leaving a ghost). Not part of this pass — document only, per DW's instruction. If built later, it would likely hook into the same `midGameJoin` mid-game-join machinery the standard game already has, extended with a "inherit this ghost's exact state" path — worth a fresh design pass of its own when prioritized rather than sketched prematurely here.

---

## 11. Open Questions Requiring DW Confirmation Before Build

Collected from the flags above, so they're not missed:

1. **Safeword scope** (Section 9) — confirm the native BC safeword event (`handleBCSafewordEvent`) stays a hard whole-game stop in team mode too, and only the `!safeword` chat command gets the new ghost behavior.
2. **Ghost picker eligibility** (Section 8) — should a ghosted player be excluded from the bondage-picker pool outright, or is timing out into the existing auto-pick fallback acceptable?
3. **"Keep or drop" resolution rule** (Section 9) — first response wins, majority, or unanimous? First-response is assumed above to avoid a stall.

None of these block writing the code structure — they're narrow enough to default sensibly (as assumed above) and adjust later if DW wants different behavior, except #1, which touches an actual safety mechanism and should be confirmed explicitly before that branch is written.

---

## 12. Suggested Implementation Order

Mirrors the risk-minimizing ordering style used in `docs/player_bondage_selection.md`:

1. `Player.team`/`isGhost` and the team-mode private fields on the game class (Section 2) — no behavior change yet, just plumbing.
2. `!teamgame` + team-size question + lobby open (Section 3).
3. `!join team1`/`!join team2` parsing, roster assignment, `!start` gating on both rosters full (Section 3).
4. `buildTeamTurnOrder()` wired in at game start in place of the shuffle, for team-mode games only (Section 4).
5. `!teams` command (read-only, safe to build any time after step 3).
6. Team-mode branch of `checkGameEndCondition()` (Section 6) — build and test this *before* ghosts, using only normal losses, so the win condition itself is verified independently.
7. Ghost roll mechanic for disconnects (Section 7) — the `onMemberLeave` team-mode branch and the ghost-turn auto-roll-1 hook.
8. Ghost roll mechanic for `!safeword` (Section 9) — the `handleSafeword` team-mode branch. Confirm Open Question #1 before this step.
9. `checkTeamBalanceAfterGhosting()` + the keep/drop whisper flow and turn-order rebuild (Section 9).
10. Team-mode branch of `choosePickerFor()` (Section 8).

---

## 13. Files Affected

- `src/game.ts` — all of the above (lobby/start flow, turn order construction, win condition, ghost mechanics, safeword branch, picker targeting, `!teams` command)
- `src/types.ts` — if `Player`/game-state-adjacent types live there rather than inline in `game.ts` (confirm current file organization before implementing — team mode's own review found StripDiceBot keeps most interfaces inline in `game.ts` rather than a separate `types.ts`, unlike WinnersDice's structure, so these additions likely belong directly in `game.ts`'s existing `Player` interface)
