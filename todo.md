# StripDiceBot — TODO

## High Priority

- [ ] Jem feedback: all outfits should have the same number of items for multiplayer games
- [ ] Alice feedback: same restraints set for every player; add player limit (game runs too long with late joiners)
- [ ] Steel Restraints outfit — add a gag item directly to its appearance code so the outfit can reach 7 items (currently stuck at 6 because its LZ appearance code has no mouth slot to reference)

## Queued Features / Changes

- [ ] **Juggernaut mode** — Add a Juggernaut game variant. One player is the Juggernaut and faces all other players simultaneously. Design TBD — no coding yet.

- [x] ~~**Lock-time vote v2**~~ — Done 2026-07-16. New formula: `max(setting, players+5) + (finishers×2) + per-player 69 bonuses ± 5 from majority vote`. 69 on D100 = +10 min double bonus; any other 69 = +5 min. Winner can distribute their 69 bonus to losers. !lock10/15/20 are now admin-only. All components logged with `[LOCK TIME]` prefix. Original "weight by streaks/losses" idea still pending.

- [ ] **Lock-time v3** — Weight suggested time by game length, total losses, and losing streaks (original v2 ideas, still not implemented).

- [ ] **Team game lock time** — Team mode is in testing. Lock duration design still TBD — leaning toward a pre-game fixed setting. No code changes yet.

- [x] ~~Port BD's wardrobe/clothing-removal detection pattern into WD~~ — Done 2026-07-15. WD's `game.ts` now verifies a real per-item appearance-count drop (with a manual `!removed` fallback), matching BD's baseline-diff pattern instead of trusting any resync.

- [ ] **Extract a shared "wardrobe watch" helper** — BD and WD each have their own copy of the same clothing-removal detection logic: take a baseline item count before asking a player to strip, then compare after their wardrobe closes to confirm something actually came off (`!removed` is the manual fallback). The code is identical in both bots. Worth pulling into a shared module (same pattern as `bondagePicker.ts` in `D:\Games\BC-Bot\shared\`), so future fixes only need to happen once. Not started — no urgency, both copies work fine.

## Future / Nice to Have

- [ ] **Solo prize system design** — When a solo player finishes their game, they're asked if they'd want to be a "prize" (available for anyone in the room to claim). If yes, they're currently told it's not implemented yet and prompted to describe their vision (stored as feedback). Design TBD: likely a timed bondage lock + prevented room exit, with any room member able to claim. See feedback log for collected player visions. No code changes needed until design is finalized.

- [x] ~~**69 on first roll — special event**~~ — Removed; handled another way.

- [x] ~~**Test player bondage selection system**~~ — Bondage picker live and working. Slot selection updated to numbered list (2026-07-16).

- [x] ~~**Review safeword behavior**~~ — Done 2026-07-16. BC native safeword now uses the same behavior as `!safeword` (removes only that player's bondage, asks others to !continue, ghost in team mode). Admin whisper + log entry still fire on BC native safeword so it's distinguishable.

- [x] ~~Electron GUI front-end~~ — Superseded by the web panel at `D:\Games\BC-Bot\panel` (plain Node, no build step) — per-bot start/stop/restart, branch switching, live log streaming. See `panel/README.md`.
