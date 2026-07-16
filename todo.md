# StripDiceBot — TODO

## High Priority

- [ ] Jem feedback: all outfits should have the same number of items for multiplayer games
- [ ] Alice feedback: same restraints set for every player; add player limit (game runs too long with late joiners)
- [ ] Steel Restraints outfit — add a gag item directly to its appearance code so the outfit can reach 7 items (currently stuck at 6 because its LZ appearance code has no mouth slot to reference)

## Queued Features / Changes

- [ ] **Juggernaut mode** — Add a Juggernaut game variant. One player is the Juggernaut and faces all other players simultaneously. Design TBD — no coding yet.

- [ ] **Lock-time vote v2** — v1 (±5 minute vote by bound players) shipped. Original design ideas not yet implemented: weight the suggested time by game length, total losses, and losing streaks.

- [x] ~~Port BD's wardrobe/clothing-removal detection pattern into WD~~ — Done 2026-07-15. WD's `game.ts` now verifies a real per-item appearance-count drop (with a manual `!removed` fallback), matching BD's baseline-diff pattern instead of trusting any resync.

- [ ] **Extract a shared "wardrobe watch" helper** — Both bots now independently implement the same baseline-diff detection pattern (item-count baseline vs. fresh appearance sync, `!removed` manual fallback) — BD original since 2026-07-11, ported into WD 2026-07-15 (see above). Worth extracting into one shared module both import, same precedent as `bondagePicker.ts`. Not started.

## Future / Nice to Have

- [ ] **69 on first roll — special event** — free request of any player, no dice. Bot announces: "The dice spoke before the game even started — [name] gets a freebie." Design still TBD. (Distinct from the shipped 69/streak roll commentary.)

- [ ] **Test player bondage selection system** — The bondagePicker (player-choice bondage item selection flow) is now option 1 in the bondage menu. Needs live testing. Note: this is NOT a bondage purchase/payment mechanic — BD is not getting WD's purchase system — it's the flow where the player picks their own bondage item.

- [ ] **Review safeword behavior — stop vs. pause game** — Currently, when a player uses the BC safeword outside team mode, the bot stops the game entirely. This may not be ideal since some players use safeword frequently (e.g. as a habit or for non-game reasons). Review options: pause the game instead of stopping it, prompt to confirm they actually want to end the game, or make the behavior configurable. (Team mode now handles safeword via ghost turns.)

- [x] ~~Electron GUI front-end~~ — Superseded by the web panel at `D:\Games\BC-Bot\panel` (plain Node, no build step) — per-bot start/stop/restart, branch switching, live log streaming. See `panel/README.md`.
