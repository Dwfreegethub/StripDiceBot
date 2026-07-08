# StripDiceBot — TODO

## HIGH PRIORITY

- [ ] **Next update — add 247062 to the room admin list.** Current list: 246108, 208543. New list: 246108, 208543, 247062. Find where the admin member numbers are defined in the config or source and update that value.

## Queued Features / Changes

- [ ] **2v2 / Team mode** — Add a team-based game variant where players are paired up. Losses are applied to the team member, not just the individual roller. Design TBD — no coding yet.

- [ ] **Juggernaut mode** — Add a Juggernaut game variant. One player is the Juggernaut and faces all other players simultaneously. Design TBD — no coding yet.

- [ ] **End-of-game lock timer vote** — Instead of a fixed lock duration (current: !lock10/!lock15/!lock20), run a vote at end of game to determine how long the winners' locks stay on. Design notes:
  - Lock time should be at least somewhat related to the length of the game
  - Lock time should reflect number of times the loser lost (more losses = longer lock time)
  - Consecutive losses ("losing streak") should carry extra weight — losing in a row suggests a heavier penalty
  - This replaces or supplements the current pre-game !lock command
  - Design TBD before coding

## Future / Nice to Have

- [ ] **69 on first roll — special event** — free request of any player, no dice. Bot announces: "The dice spoke before the game even started — [name] gets a freebie." Design still TBD.

- [ ] **Bondage style priority: player pick primary, outfit fallback** — When bondage is awarded, the bot should first offer the player's own selection via the bondagePicker flow; predefined outfit bondage should only be used as a fallback if the player doesn't choose (or declines). Currently predefined outfit bondage and the player-pick flow are not ordered this way — update the award flow in `src/game.ts` so bondagePicker is tried first and outfit-based bondage is secondary.

- [ ] **Electron GUI front-end** — Simple desktop app to start/stop BD and WD bots, watch logs in real time. Use `electron` + `electron-builder`. UI: two bot cards with status indicator, Start/Stop button, scrolling log pane. Wrapper scripts stay unchanged.

- [ ] **Test player bondage selection system before promoting** — The bondagePicker (player-choice bondage item selection flow) has been built/updated. Needs testing in its current state before moving it to the next stage. Note: this is NOT a bondage purchase/payment mechanic — BD is not getting WD's purchase system — it's the flow where the player picks their own bondage item.

- [ ] **Review safeword behavior — stop vs. pause game** — Currently, when a player uses the BC safeword, the bot stops the game entirely. This may not be ideal since some players use safeword frequently (e.g. as a habit or for non-game reasons). Review options: pause the game instead of stopping it, prompt to confirm they actually want to end the game, or make the behavior configurable.
