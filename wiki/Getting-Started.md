# Getting Started

## Talking to the bot

Type **`/bot`** and a command straight into the chat box:

```
/bot help
/bot join
/bot roll
```

`/bot` is built into Bondage Club. The message goes only to the bot, so nobody else in the room sees it, and the bot answers you by whisper. The room's chat stays readable even with a full table.

**The old way still works.** Every command can also be whispered to the bot with a `!` in front (`!roll`), or typed in room chat, where everyone sees it. Use whichever you like.

When the bot asks you something (*"Do you have shoes on? (yes/no)"*), answer by whisper or with `/bot yes`.

## Your first game

1. **Join.** Type `/bot join`. If no game is running, this starts one, and others have a short while to join too.
2. **Declare your clothes.** Type `/bot wearing` and answer yes or no for each item, or list them in one go: `/bot wearing shoes socks top bottom bra panties`. Nothing on? `/bot naked`. Played before? `/bot same` reuses your last outfit. What you're wearing stays between you and the bot: when the game starts, the room only sees how many items you have on, and each one is revealed as it comes off.
3. **Answer the setup questions.** Before the start the bot whispers a few questions: whether the winner may add toys, whether you want to be a prize if you lose, and how your restraints are chosen. See [Bondage, Locks and Prizes](Bondage-Locks-and-Prizes).
4. **Ready up.** `/bot ready`. The game starts when the countdown ends, or when someone types `/bot start`.
5. **Roll on your turn.** `/bot roll`. The bot announces each roll in the room.

When you roll a 1, take the item off in your Wardrobe. Closing the Wardrobe tells the bot you're done, or type `/bot removed`.

## Your next games: saved answers

After your first finished game the bot asks once whether it may remember your answers (toys, prize, how your restraints are chosen, the areas allowed, and your outfit). Say **SAVE** or **NO SAVE**.

With them saved, `/bot join` asks just two things: your saved settings (**SAME**, **CHANGE** to answer the questions again, or **CANCEL**), then your outfit (**SAME** or **NEW**). Same and same, and you're ready. Your answers update after every game you finish.

`/bot settings` shows what's saved, `/bot settings forget` wipes it, and `/bot settings save` turns saving back on.

## Clothing lists

There are two clothing lists. The bot picks one from your character's pronouns, and you can switch with `/bot clothes male` or `/bot clothes female`.

| List | Items, in the order they come off |
|---|---|
| Female | shoes, socks, jacket, top, bottom, bra, panties |
| Male | shoes, socks, jacket, shirt, pants, underwear |

Everyday words work too: *heels* counts as shoes, *dress* as top, *jeans* as bottom, and so on.

## Seeing when the room is open

Type `/bot friend` and the bot adds you back as a friend, so the room shows on your friend list. To get a beep when someone wants a game, see [Matchmaking](Matchmaking).
