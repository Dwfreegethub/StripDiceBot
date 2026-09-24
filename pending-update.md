# BD Pending Update

**Date:** 2026-08-31

## Changes in this update

### Duplicate welcome whisper removed (cleanup)
`src/index.ts` → `bot.onMemberJoin` handler

Removed the old whisper that was firing from `index.ts` immediately before `game.onMemberJoin` triggered its own (better, state-aware) welcome via `sendWelcomeWhisper`. The old one still had "EARLY BETA" language and duplicate info. The public chat message (`Welcome to Strip Dice, {name}! 🎲`) is kept.

### Welcome message — Missy note added
`src/game.ts` → `sendWelcomeWhisper()`

Added a fixed final line to every welcome whisper:

> 💤 Missy has been hypnotized by a new side project — updates have slowed while she's under, but she hasn't forgotten about Strip Dice and will be back with more soon!

## Deploy steps
1. `npm run build` in `StripDiceBot/`
2. Restart the BD bot (only if SSS is not running)
