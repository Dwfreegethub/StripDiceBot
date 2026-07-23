# StripDiceBot — TODO

## High Priority

- [ ] Jem feedback: all outfits should have the same number of items for multiplayer games
- [ ] Alice feedback: same restraints set for every player; add player limit (game runs too long with late joiners)
- [ ] Steel Restraints outfit — add a gag item directly to its appearance code so the outfit can reach 7 items (currently stuck at 6 because its LZ appearance code has no mouth slot to reference)

## Queued Features / Changes

- [ ] **Standardize BD and WD menu/prompt structure** — Where both bots ask similar questions (yes/no choices, numbered lists, outfit declarations, consent gates), align the wording pattern and reply format so players moving between bots don't have to relearn the interface. Audit both bots' whisper prompts and pick consistent conventions (e.g. numbered options always use "1." format, yes/no gates always show the options in bold).

- [ ] **Player preferences persistence** — Save two per-player preferences to `player_prefs.json` so they survive bot restarts: (1) clothing list (male/female, currently only in-memory), (2) bondage mode preference (outfit vs pick, currently re-asked every time they lose all clothing). Single file keyed by memberNumber. Low priority — cost of missing it is just one `!clothes male` whisper per restart.

- [ ] **Juggernaut mode** — Add a Juggernaut game variant. One player is the Juggernaut and faces all other players simultaneously. Design TBD — no coding yet.

- [x] ~~**Lock-time vote v2**~~ — Done 2026-07-16. New formula: `max(setting, players+5) + (finishers×2) + per-player 69 bonuses ± 5 from majority vote`. 69 on D100 = +10 min double bonus; any other 69 = +5 min. Winner can distribute their 69 bonus to losers. !lock10/15/20 are now admin-only. All components logged with `[LOCK TIME]` prefix. Original "weight by streaks/losses" idea still pending.

- [ ] **Lock-time v3** — Weight suggested time by game length, total losses, and losing streaks (original v2 ideas, still not implemented).

- [ ] **Team game lock time** — Team mode is in testing. Lock duration design still TBD — leaning toward a pre-game fixed setting. No code changes yet.

- [ ] **Detect a player's blocked lock item and warn in advance** — idea from DW, spotted live 2026-07-16 while testing WD's multi-room work: a player's synced character data includes `BlockItems` (e.g. a player showed `BlockItems.ItemMisc.TimerPasswordPadlock: [""]` after manually blocking it to test). If a player has blocked the specific item BD uses for its end-game/prize locks, the bot could detect this ahead of time and warn during setup instead of the lock silently failing at lock time. Distinct from (but related to, and worth building alongside) the existing `docs/lock-permission-preflight.md` design — that one covers `ItemPermission`/`Whitelist` (bot not permitted to act on the player at all); this is about a specific item being blocked even when the bot otherwise has permission. Not implemented — no code written yet.

- [x] ~~Port BD's wardrobe/clothing-removal detection pattern into WD~~ — Done 2026-07-15. WD's `game.ts` now verifies a real per-item appearance-count drop (with a manual `!removed` fallback), matching BD's baseline-diff pattern instead of trusting any resync.

- [ ] **Extract a shared "wardrobe watch" helper** — BD and WD each have their own copy of the same clothing-removal detection logic: take a baseline item count before asking a player to strip, then compare after their wardrobe closes to confirm something actually came off (`!removed` is the manual fallback). The code is identical in both bots. Worth pulling into a shared module (same pattern as `bondagePicker.ts` in `D:\Games\BC-Bot\shared\`), so future fixes only need to happen once. Not started — no urgency, both copies work fine.

## Pending Tests

- [ ] **R130 items with unverified codenames** — new R130 restraints left OUT of `bc_items.json` (shared with WD) because their exact BC asset codenames couldn't be found in the R130 `Female3DCG.js` — guessing risks a silent apply-failure. To verify: apply the item in-game, read the wrapper log's `ChatRoomSyncItem` for the real `Name` field, then add to `bc_items.json` and to `NEW_ITEMS` in `constants.ts` to spotlight it.
  - [x] ~~**Chastity Tunnel Piercings** (KyraObscura)~~ — RESOLVED 2026-07-19: DW applied it in-game; codename is `ModularVulvaPiercings` in `ItemVulvaPiercings` ("Tunnel" is a modular type-option within it). Added to `bc_items.json` + `NEW_ITEMS`.
  - [x] ~~**Leashable Front Hand Tie** (Sarah)~~ — CLOSED 2026-07-19 (DW): it's a modular option of the existing `HempRope` item (already in the list), not a standalone asset. Nothing to add.
  - Reference: R130's `CageMuzzle` was already in the list; `FullBodyStraps` lives in BC group `ItemAddon`, which the picker doesn't use — intentionally skipped.
  - All R130 restraints now accounted for — this whole item can be cleared from the list whenever the todo's next tidied.

## Future / Nice to Have

- [ ] **Solo prize system** — ⏸️ ON HOLD pending WD stabilization + dedicated solo outfits. Resume after WD is ready to run. Next step: source/commission solo bondage outfits, then implement.

  _Player vision summary (15 submissions, 2026-07-17–21):_ Overwhelming consensus is full bondage + helpless/on-display + claimable by anyone in the room. "Doll," "pet," "bound and helpless" language repeats across 7+ independent submissions. Core design: lose solo → fully restrained in a dedicated outfit → claimable by room members for a timed lock. Notable additions worth considering: Indigo suggested bot-counted punishment tasks as a release condition (instead of just a timer); mia suggested a pre-game "hardcore mode" stake where beating a record auto-triggers prize status.

- [ ] **Solo tournament** — Design TBD. Likely a structured bracket or ladder where solo players compete for records across a session, with the tournament winner (or loser) becoming a prize. No design or code yet — revisit after solo prize system ships.

- [x] ~~**69 on first roll — special event**~~ — Removed; handled another way.

- [x] ~~**Test player bondage selection system**~~ — Bondage picker live and working. Slot selection updated to numbered list (2026-07-16).

- [x] ~~**Review safeword behavior**~~ — Done 2026-07-16. BC native safeword now uses the same behavior as `!safeword` (removes only that player's bondage, asks others to !continue, ghost in team mode). Admin whisper + log entry still fire on BC native safeword so it's distinguishable.

- [x] ~~Electron GUI front-end~~ — Superseded by the web panel at `D:\Games\BC-Bot\panel` (plain Node, no build step) — per-bot start/stop/restart, branch switching, live log streaming. See `panel/README.md`.
