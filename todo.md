# StripDiceBot — TODO

## High Priority

- [ ] **All outfits same item count** — Consolidates: Jem (equal items per outfit for fair multiplayer), Alice (same restraints set for every player), Steel Restraints (stuck at 6 groups, needs a mouth/gag slot to reach 7). All outfits should share the same group count so no player is at a disadvantage based on outfit draw. Also enforce a player limit so late joiners don't drag out game length.

## Queued Features / Changes

- [ ] **Standardize BD and WD menu/prompt structure** — Align wording/reply format across both bots so players moving between them don't have to relearn the interface (numbered options always "1." format, yes/no gates always show options in bold, etc.).

- [ ] **Player preferences persistence** — Save two per-player preferences to `player_prefs.json` so they survive bot restarts: (1) clothing list (male/female), (2) bondage mode preference (outfit vs pick). Low priority — cost of missing it is just one `!clothes male` whisper per restart.

- [ ] **Lock-time v3** — Weight suggested time by game length, total losses, and losing streaks (original v2 ideas, still not implemented).

- [ ] **Detect a player's blocked lock item and warn in advance** — Player's synced character data includes `BlockItems`. If a player has blocked the specific item BD uses for end-game/prize locks, detect this during setup and warn instead of silently failing at lock time. See `docs/lock-permission-preflight.md` for related design.

- [ ] **Extract a shared "wardrobe watch" helper** — BD and WD each have their own copy of the same clothing-removal detection logic. Worth pulling into a shared module (like `bondagePicker.ts` in `D:\Games\BC-Bot\shared\`) so future fixes only happen once. No urgency — both copies work fine.

- [ ] **Zoop: out-of-turn roll penalty** — "It's not your turn" message exists but no penalty. Add a debuff (e.g. -10 to next roll, or forced low roll) for rolling out of turn. Design TBD.

- [ ] **Emily: auto-strip and autodetect worn clothing** — Bot auto-detects what a player is wearing and strips for them rather than requiring manual declaration. Design TBD.

## Future / Nice to Have

- [ ] **Solo prize system** — ⏸️ ON HOLD pending dedicated solo outfits. Next step: source/commission solo bondage outfits, then implement.

  _Player vision summary (15 submissions, 2026-07-17–21):_ Overwhelming consensus is full bondage + helpless/on-display + claimable by anyone in the room. "Doll," "pet," "bound and helpless" repeats across 7+ submissions. Core design: lose solo → fully restrained in a dedicated outfit → claimable by room members for a timed lock. Notable additions: Indigo suggested bot-counted punishment tasks as release condition; mia suggested a pre-game "hardcore mode" stake where beating a record auto-triggers prize status.

- [ ] **Solo tournament** — Design TBD. Structured bracket or ladder where solo players compete for records, with winner/loser becoming a prize. Revisit after solo prize system ships.

---

## Completed

### Completed 2026-07-31
- **Team game lock time** — uses the same formula as standard mode: `max(lockSetting, playerCount + 5) + (finisherCount × 2 min)` with ±5 vote. 69-bonus-assignment phase skipped for team mode (multiple winners). Losing team locked, bound winners freed. No further design changes needed.
- **Player limit** — `maxPlayers` fully implemented via `!start N-M` syntax.
- **R130 items** — all accounted for (Chastity Tunnel Piercings → `ModularVulvaPiercings`, Leashable Front Hand Tie → modular HempRope option, CageMuzzle already listed, FullBodyStraps intentionally skipped).

### Completed earlier
- **Lock-time vote v2** — `max(setting, players+5) + (finishers×2) + per-player 69 bonuses ± 5 from majority vote`. 69 on D100 = +10 min double bonus; any other 69 = +5 min. Winner distributes their 69 bonus to losers. `!lock10/15/20` admin-only. All components logged with `[LOCK TIME]` prefix.
- **Port BD wardrobe detection into WD** — Done 2026-07-15.
- **Bondage picker** — Live and working. Slot selection updated to numbered list (2026-07-16).
- **Safeword behavior** — BC native safeword uses same behavior as `!safeword`. Admin whisper + log entry still fire.
- **Electron GUI** — Superseded by web panel at `D:\Games\BC-Bot\panel`.
- **69 on first roll special event** — Removed; handled another way.
