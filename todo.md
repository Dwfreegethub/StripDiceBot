# StripDiceBot — TODO

## High Priority

- [ ] Jem feedback: all outfits should have the same number of items for multiplayer games
- [ ] Alice feedback: same restraints set for every player; add player limit (game runs too long with late joiners)
- [ ] Steel Restraints outfit — add a gag item directly to its appearance code so the outfit can reach 7 items (currently stuck at 6 because its LZ appearance code has no mouth slot to reference)

## Queued Features / Changes

- [ ] **Juggernaut mode** — Add a Juggernaut game variant. One player is the Juggernaut and faces all other players simultaneously. Design TBD — no coding yet.

- [ ] **Lock-time vote v2** — v1 (±5 minute vote by bound players) shipped. Original design ideas not yet implemented: weight the suggested time by game length, total losses, and losing streaks.

- [ ] **Standardize clothing/wardrobe-change detection between BD and WD** — BD's penalty-removal detection (`markAwaitingRemoval`/`pendingRemovalBaselineCount`, item-count baseline vs fresh ChatRoomSyncSingle, `!removed` fallback, turn-gating fix) shipped 2026-07-11 and is meaningfully more robust than WD's trade-handoff detection (`startWardrobeCheck`/`waitingForWardrobe`), which still just treats *any* sync event as proof of a change (no count check) and has no manual override or escalation beyond a single 2-minute nudge. Plan: port BD's baseline-diff pattern into WD, add a manual confirm command there, and consider extracting a shared "wardrobe watch" helper both bots import — same precedent as `bondagePicker.ts`. On hold — DW wants to field-test today's BD changes first before touching WD or extracting shared code.

## Future / Nice to Have

- [ ] **69 on first roll — special event** — free request of any player, no dice. Bot announces: "The dice spoke before the game even started — [name] gets a freebie." Design still TBD. (Distinct from the shipped 69/streak roll commentary.)

- [ ] **Test player bondage selection system** — The bondagePicker (player-choice bondage item selection flow) is now option 1 in the bondage menu. Needs live testing. Note: this is NOT a bondage purchase/payment mechanic — BD is not getting WD's purchase system — it's the flow where the player picks their own bondage item.

- [ ] **Review safeword behavior — stop vs. pause game** — Currently, when a player uses the BC safeword outside team mode, the bot stops the game entirely. This may not be ideal since some players use safeword frequently (e.g. as a habit or for non-game reasons). Review options: pause the game instead of stopping it, prompt to confirm they actually want to end the game, or make the behavior configurable. (Team mode now handles safeword via ghost turns.)

- [x] ~~Electron GUI front-end~~ — Superseded by the web panel at `D:\Games\BC-Bot\panel` (plain Node, no build step) — per-bot start/stop/restart, branch switching, live log streaming. See `panel/README.md`.
