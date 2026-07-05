# Player Bondage Selection — Design Doc

**Bot:** StripDiceBot (BD)
**Status:** Approved for development
**Branch:** dev
**Depends on:** `bc_items.json` (exists at `D:\Games\BC-Bot\bc_items.json`), `bondage_usage.json` (existing per-slot popularity tracker)

---

## Overview

A new game mode that replaces or supplements the existing preset outfit system. Instead of the bot automatically applying a predefined bondage outfit, a designated picker selects items slot-by-slot from the BC item catalog. Items are tracked for popularity and the top choices surface automatically over time.

---

## Game Mode Selection

At game start (during the existing lobby/setup flow), each player independently declares one of two modes for themselves:

- **Outfit mode** — the bot applies a preset outfit as it does today
- **Player-pick mode** — a designated picker selects bondage items for this player slot-by-slot

The bot whispers each player asking which mode they want. Their choice is stored on the `Player` object. The two modes can coexist in the same game — e.g. Player A chooses outfit mode, Player B chooses player-pick mode.

---

## Picker Selection

**Round 1:** No prior loser exists, so the picker is chosen at random from all active players.

**Subsequent rounds:** The loser of the prior round is the picker.

**Eliminated player exception:** If the designated picker (prior round's loser) has been fully bound (all bondage slots filled / eliminated from the game), they cannot pick. Fall back to a random active non-loser player. The loser flag is NOT reassigned when a player is eliminated — the pointer stays on them, and the fallback triggers automatically when they can't act.

---

## Item Selection Flow

When bondage is to be applied to a player-pick-mode player:

1. **Picker receives a whisper:** "It's your turn to pick a bondage item for [PlayerName]. Choose a slot: Arms, Legs, Feet, Torso, Hands, Head, Hood, Neck, Mouth — or type a slot name."

2. **Picker selects a slot.** Bot validates the slot is:
   - A valid BC item group
   - On the target player's consented slot list (see Consent section)
   - Not already filled on the target player

3. **Bot whispers the picker a numbered list:**
   ```
   Slot: Arms — pick one:
   1. LeatherCuffs
   2. SteelCuffs
   3. StraitJacket
   4. FuturisticCuffs
   5. NylonRope
   6. [Random: BoxTieArmbinder] ← not in top 5, randomly pre-selected
   Or type any item name from this slot.
   ```
   Options 1–5 are the most popular items for that slot from `bondage_usage.json`. Option 6 is a randomly pre-selected item from the same slot that is NOT in the top 5 — provides variety and prevents the list from going completely static.

4. **Picker replies** with a number (1–6) or a free-text item name.
   - Free-text: bot does case-insensitive fuzzy match (strip spaces, check `startsWith` then `includes`) against all items in that slot from `bc_items.json`. If ambiguous (multiple matches), bot asks the picker to clarify.

5. **Target player receives a veto whisper:** "You are about to have [ItemName] applied to your [SlotName]. Type !veto to decline, or !accept to confirm (or wait 30s to auto-accept)."
   - If vetoed: picker gets to pick again from the same slot (different item).
   - Veto is controlled by a `allowVeto: boolean` flag on the game session. Default `true`. Set to `false` for higher-stakes game modes (code hook only — do not build the higher-stakes mode yet).

6. **Bot applies the item** via `ChatRoomCharacterItemUpdate` (same mechanism already used for bondage application).

7. **Popularity updated:** The applied item's count in `bondage_usage.json` is incremented for that slot.

---

## Consent — Off-Limits Slots

During `!join` (alongside existing toy consent question), the bot whispers each player asking which body slots they consent to having items applied to:

```
Which bondage slots do you consent to? Reply with a comma-separated list, or "all" for everything.
Slots: Arms, Legs, Feet, Torso, Hands, Head, Hood, Neck, Mouth, Nipples, Breast, Pelvis, Boots
Sensitive slots (Pelvis, Nipples, Breast, Vulva, Butt) are OFF by default — include them explicitly if you want them available.
```

Slot consent is stored on the `Player` object as `allowedSlots: string[]` (BC group names). The picker only sees slots the target player has consented to.

**Slot tiers (for future game level integration — code hooks only, not built yet):**
- Tier 1 (vanilla default): Arms, Legs, Feet, Torso, Hands, Head, Hood, Neck, Mouth, Boots
- Tier 2 (extended, explicit consent required): Nipples, Breast, Pelvis
- Tier 3 (explicit consent + higher-stakes flag): Vulva, Butt

---

## End Condition

The game ends when a player has had **7 bondage items** applied. This matches the item count of the majority of existing BD outfits (verify exact count from `outfits.json` before coding — adjust if the modal count differs).

End item count is stored as `bondageItemLimit: number` on the game session. Default 7. Make it configurable for future use but do not expose the config to players yet.

---

## Popularity Tracking

`bondage_usage.json` already exists and tracks per-slot item popularity. Structure:
```json
{
  "ItemArms": { "LeatherCuffs": 12, "SteelCuffs": 9, ... },
  "ItemLegs": { ... }
}
```

When an item is applied in player-pick mode, increment its count. When building the top-5 list, sort by count descending and take the top 5. Option 6 is drawn randomly from the remaining items in that slot (not in top 5).

**Bootstrap:** When a slot has fewer than 5 entries in `bondage_usage.json`, fill remaining slots from items used in the current `outfits.json` for that group, in the order they appear. This ensures the list is never empty on first use.

---

## Outfit Candidate Logging

At the end of every player-pick mode game (or mixed game with at least one player-pick player), append an entry to `outfit_candidates.json` (gitignored):

```json
{
  "date": "2026-07-02T22:30:00Z",
  "players": ["Missy", "MissyMissy"],
  "selections": [
    { "slot": "ItemArms", "item": "LeatherCuffs", "appliedTo": "Missy" },
    { "slot": "ItemLegs", "item": "SteelAnkleCuffs", "appliedTo": "Missy" },
    ...
  ]
}
```

DW reviews this file periodically and can manually promote a combination to `outfits.json`. No auto-promotion. No player-facing command for this yet.

---

## Human-Friendly Slot Names

The bot uses these display names; internally they map to BC group names:

| Display | BC Group |
|---|---|
| Arms | ItemArms |
| Legs | ItemLegs |
| Feet | ItemFeet |
| Torso | ItemTorso |
| Torso (upper) | ItemTorso2 |
| Hands | ItemHands |
| Head | ItemHead |
| Hood | ItemHood |
| Neck | ItemNeck |
| Mouth | ItemMouth |
| Boots | ItemBoots |
| Nipples | ItemNipples |
| Breast | ItemBreast |
| Pelvis | ItemPelvis |
| Vulva | ItemVulva |
| Butt | ItemButt |

ItemMouth2 and ItemMouth3 are treated as overflow layers of Mouth — bot uses them automatically if ItemMouth is already filled, without exposing them as separate picker options.

---

## Data Model Changes

**Player object additions:**
```typescript
bondageMode: 'outfit' | 'player-pick';
allowedSlots: string[]; // BC group names the player consented to
appliedBondageItems: { slot: string; item: string }[]; // running list this game
```

**GameState additions:**
```typescript
lastRoundLoser: string | null; // memberNumber of prior round loser
pickerHistory: string[]; // memberNumbers who have picked, for fallback logic
allowVeto: boolean; // default true
bondageItemLimit: number; // default 7
bondageMode: 'outfit' | 'player-pick' | 'mixed'; // game-level summary
```

---

## Implementation Order

Build in this order to minimize risk:

1. Add `bondageMode` and `allowedSlots` to Player; add consent question at `!join`
2. Add `bondageItemLimit` and picker state to GameState
3. Build slot selection flow (whisper → validate → present list)
4. Build item selection flow (numbered + free-text fuzzy match)
5. Build veto flow
6. Wire into existing bondage application path (branch on `bondageMode`)
7. Add popularity increment on apply
8. Add outfit candidate logging at game end
9. Bootstrap logic for thin popularity data

Do NOT build higher-stakes mode, Tier 2/3 slot unlocks, or auto-promotion of outfit candidates in this pass — leave the code hooks in place but don't implement them.

---

## Files Affected

- `src/game.ts` — main changes (picker flow, veto, application branch)
- `src/types.ts` — Player and GameState additions
- `bondage_usage.json` — written on each apply (already exists)
- `outfit_candidates.json` — new, gitignored
- `bc_items.json` — read-only reference (exists at `D:\Games\BC-Bot\bc_items.json`)
- `.gitignore` — add `outfit_candidates.json`
