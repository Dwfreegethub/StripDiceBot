# Solo Prize System — Design Spec

## Overview

After a solo game, players who opted in at the start and met the win/loss condition for their mode are bound and put on display as a claimable prize for 30 minutes. Anyone in the room (present or who joins later) can claim them using `!claim`.

---

## 1. Consent — Asked at Game Start

When a player starts a solo game, the bot asks before anything else:

**Solo Race:**
> "One thing before we start — if you strip faster than average for your outfit, you'll be bound and put on display as a prize for 30 minutes, available for anyone in the room to claim. Are you in? (yes/no)"

**Solo Survive:**
> "One thing before we start — if you lose, you'll stay bound in whatever you ended up in and be put on display as a prize for 30 minutes, available for anyone in the room to claim. Are you in? (yes/no)"

- `yes` → flag stored, proceed to clothing questions
- `no` (or no response) → no prize, proceed normally
- This replaces the post-game prize question entirely

---

## 2. Prize Trigger Conditions

| Mode | Prize condition |
|---|---|
| Solo Race | Player agreed AND finished in fewer rolls than the average for their item count |
| Solo Survive | Player agreed AND lost (went fully naked) |

**Solo Race — win/loss definition:**
The threshold for "winning" (becoming a prize) is beating the average roll count for the player's clothing item bracket. This gives every race player a fair, context-aware benchmark rather than requiring a daily record (which rarely fires in busy rooms).

- Track a rolling average per item-count bracket (e.g. 6-item average = 18 rolls)
- If player finishes in fewer rolls than the bracket average → prize triggers (they "won")
- If at or above average → game ends normally, no prize
- Average updates after each completed race game to stay current
- **TBD:** Decide minimum sample size before average is considered reliable (suggested: 10 games per bracket); below that threshold, fall back to any completion triggering the prize, or use a hardcoded baseline

**Solo Survive — loss definition:**
- Any full loss (player goes completely naked) triggers the prize condition
- No averaging needed — lose = prize if opted in

---

## 3. Prize Bondage Application

### Race Winners (no existing bondage)
Apply a fresh themed bondage set. Present a numbered theme picker menu via whisper:

```
🏆 You're the prize — pick your display:
1. Strict bondage
2. Pet play
3. Display & exposure
4. Sensory deprivation
5. Shibari
6. High-tech
7. Leather
8. Latex
9. Leather & Latex
0. Random (bot picks)
```

- 30s to reply; no response → random
- One random item per stage from the chosen theme (same logic as solo penalty themed bondage)
- Locked with TimerPasswordPadlock, 30-minute timer

### Survive Losers (existing penalty bondage already applied)
- Whatever bondage was applied during the loss is their prize outfit — no changes, no swap
- Add sign + leash only
- The penalty bondage lock timer is extended to 30 minutes from prize activation if the original penalty was shorter; otherwise the existing timer stands

---

## 4. Room Announcement

When prize state activates, bot posts to room chat:

**Race:**
> "🏆 [Name] stripped down faster than anyone today and is now on display as the prize! Whisper !claim to claim them for the next 30 minutes."

**Survive:**
> "🔒 [Name] couldn't hold out and is now bound and on display as the prize. Whisper !claim to claim them for the next 30 minutes."

---

## 5. Sign

Applied to the prize player's sign slot with static text (no live countdown — reliability TBD):

```
Line 1: "PRIZE"
Line 2: "Claim me — !claim"
Line 3: "Free at [HH:MM]"  ← wall-clock release time
```

- Applied immediately after bondage
- **TBD:** Test whether re-applying the sign periodically to update line 3 (countdown) is reliable enough in practice — start with static release time and revisit

---

## 6. Claim Flow

### `!claim` (whisper only)
- Available to anyone in the room except the prize player themselves
- First-come; once claimed, no second claim (prize is taken)
- If unclaimed → remains available until 30-min timer expires

**On claim:**
1. Bot whispers the claimer:
   > "🏆 You've claimed [Name]! Their lock password is: **XXXX**
   > You can use it to release them whenever you like, or let the locks run out in 30 minutes.
   > A leash has been attached — enjoy. 😈"
2. Bot applies a leash from claimer → prize player
3. Bot posts to room chat:
   > "💘 [ClaimerName] has claimed [PrizeName]."
4. Bot whispers the prize player:
   > "[ClaimerName] has claimed you. 💕 You're theirs for the next 30 minutes — or until they let you go."
5. Sign updated (if reliable) to show "CLAIMED by [ClaimerName]"

---

## 7. Timer & Expiry

- 30-minute prize window starts when bondage is applied (not when claimed)
- On expiry:
  - Locks auto-release via TimerPasswordPadlock
  - If unclaimed: bot whispers prize player "Your prize window has ended — you're free."
  - If claimed: bot whispers both prize player and claimer "The prize window has ended — [Name] is free."
  - Leash removed on expiry if still attached
  - Sign removed on expiry

---

## 8. Early Release

- Prize player can whisper `!release` after a cooldown (suggested: 15 min) if they haven't been claimed and want out early
- If claimed, only the claimer or an admin can release early (via the password or `!free`)
- Bot announces early release in room chat

---

## 9. Edge Cases

| Scenario | Handling |
|---|---|
| Prize player leaves room | Auto-release immediately; announce in chat |
| Claimer leaves room | Leash removed; prize returns to unclaimed state for remaining time |
| Prize player uses BC safeword | Immediate release, all bondage cleared |
| Room resets / bot restarts | Prize state not persisted (same as current solo penalty) — TBD for v2 |
| No one claims in 30 min | Locks expire naturally; bot whispers prize player they're free |

---

## 10. SSS Overlap Note

The claim mechanic (leash + password + 30-min hold) maps closely to SSS's buyer/slave session model. Worth revisiting once BD's version is stable — the prize state could potentially hand off to SSS if the prize player walks into that room while still locked.

---

## 11. Open Questions / TBD

- **Race average bootstrap** — minimum sample size before bracket average is trusted; hardcoded baseline to use before then
- **Sign live countdown** — test reliability of periodic re-apply; fall back to static release time if not reliable
- **`!claim` in public chat** — whisper-only for now; revisit if players miss the command
- **Multi-player solo** — if solo expands to head-to-head, does the loser become the winner's prize automatically?
