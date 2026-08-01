# Lock Permission Pre-flight Check

## Goal

Detect at join time whether a player's BC settings will block end-game timer-password locks, so we can warn them before the game rather than discovering the failure after lock apply.

---

## What BC Exposes in Room Sync Character Data

BC sends a character snapshot to all room members via `ChatRoomSync` and `ChatRoomSyncSingle`. The bot caches this in `characterDataCache`. The relevant fields:

### `OnlineSharedSettings.AllowItem` (boolean)
Already checked in `checkPlayerPermissions`. If `false`, all item interactions are blocked globally. Bot warns player at join and blocks them from playing until fixed.

### `OnlineSharedSettings.ItemPermission` (number, 0–4)
Controls which players can interact with their items:
- `0` — Anyone
- `1` — Whitelist and above
- `2` — Owner and above
- `3` — Lover and above
- `4` — Nobody

If this is `>= 1` and the bot is not on their whitelist/owner/lover list, item interactions (including locks) will be silently rejected by the BC server.

### `Whitelist` (number[])
Array of member numbers that the player has whitelisted. Present at the character root level in the sync data (not inside `OnlineSharedSettings`). If `ItemPermission >= 1`, the bot's member number must be in this array for locks to work.

---

## Existing Detection (Post-Apply)

`verifyEndGameLockApplied` already catches lock failures after the fact:
- After applying a `TimerPasswordPadlock`, the bot registers a pending check for that `memberNumber:group` key
- If BC's server rejects the lock, it broadcasts a `ChatRoomSyncSingle` correcting the item without the lock — caught by `onSyncSingle` → `onResult(true)` → retry logic → eventual "couldn't apply your lock" whisper

This works but fires during end-game chaos. A pre-flight check at join would give the player time to fix the issue before the game starts.

---

## What We Can't Detect

Per-lock-type blocking at fine granularity (e.g. "timer-password locks specifically blocked"). BC may have this setting somewhere in per-item preferences, but it doesn't appear to be exposed in the shared character data. The post-apply rejection path remains the only reliable detection method for that case.

---

## Proposed Implementation

### Step 1 — Verify fields are actually present in cached data

Add a temporary log line in `checkPlayerPermissions` (or a debug-mode guard) to confirm `ItemPermission` and `Whitelist` appear in the real character cache before building the full check:

```typescript
const oss = char.OnlineSharedSettings;
log(`[PERM DEBUG] ${name} (#${memberNumber}): AllowItem=${oss?.AllowItem}, ItemPermission=${oss?.ItemPermission}, Whitelist=${JSON.stringify(char?.Whitelist?.slice(0, 5))}...`);
```

Run one game, check the log, confirm the fields are populated.

### Step 2 — Add the check to `checkPlayerPermissions`

Location: `src/game.ts`, `checkPlayerPermissions()`, after the existing `AllowItem` check.

```typescript
// ItemPermission >= 1 means only whitelisted/owner/lover members can interact.
// If the bot isn't in their whitelist, locks will be silently rejected by BC.
const itemPermission: number = oss?.ItemPermission ?? 0;
if (itemPermission >= 1) {
    const whitelist: number[] = char?.Whitelist ?? [];
    const botNumber = this.bot.getMemberNumber();
    if (!whitelist.includes(botNumber)) {
        this.bot.whisper(memberNumber,
            `⚠️ Your item permission is set to whitelist-only (or higher), and the bot isn't on your whitelist. ` +
            `End-game locks won't apply. Please add GameBot to your whitelist, or set Online Settings → Items → ` +
            `"Who can interact with your items" to "Anyone", then !join again.`
        );
        log(`Permission pre-flight: ${name} (#${memberNumber}) has ItemPermission=${itemPermission} and bot is not whitelisted.`);
        passed = false;
    }
}
```

### Step 3 — Soft-warn at game start (re-check)

`checkPlayerPermissions` runs at join, but players could change settings mid-lobby. The existing game-start re-check loop (around line 2877) also only checks `AllowItem`. Add the same `ItemPermission` + whitelist check there as a soft warn (player stays in game but gets warned):

```typescript
if (itemPermission >= 1 && !whitelist.includes(botNumber)) {
    this.bot.whisper(player.memberNumber,
        `⚠️ Heads up: your item permission is blocking the bot — end-game locks won't apply. ` +
        `Add GameBot to your whitelist or set item interactions to "Anyone" before the game ends.`
    );
    log(`[PERM WARN] ${player.name} (#${player.memberNumber}): ItemPermission=${itemPermission}, bot not whitelisted at game start.`);
}
```

---

## Void Attack / Sequencing Case (Alexstrasza)

Separate from permissions. If void attack removes a player's items mid-game, the lock is never applied — there's nothing to lock. The post-apply verification will detect a missing item and log it, but the root fix is preventing void from stripping bot-locked items in the first place, which may not be controllable from the bot side. 

Follow-up for Alexstrasza: ask if her timer password lock is blocked in BC settings. If not, the void attack is the likely cause — log it and monitor.

---

## Notes

- `Whitelist` at root vs inside `OnlineSharedSettings` — needs confirmation from live log (Step 1 above)
- If `Whitelist` is not present in shared data, the check degrades gracefully (empty array = not whitelisted = warn)
- Bot's member number comes from `this.bot.getMemberNumber()`
- `ItemPermission = 2` (owner) and above will almost certainly block locks — bots can't be set as owner
