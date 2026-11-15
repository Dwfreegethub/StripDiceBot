# Multiplayer Games

## The dice

* The first roll of a round is a **D100**.
* Each roll becomes the size of the next player's die. Roll a 37, and the next player rolls a D37.
* **Roll a 1 and you lose.** Take off your next item of clothing. The next round starts again at D100, with you rolling first.
* Once you're naked, a loss means a **restraint** instead (see [Bondage, Locks and Prizes](Bondage-Locks-and-Prizes)).
* Once you're fully bound, you're out. **The last player who isn't fully bound wins.**

### Special rolls

| Roll | What happens |
|---|---|
| **100** on the D100 | Free pass: you can skip your next required roll. |
| **1** on the D100 | Double penalty: two items (or two restraints) at once. |
| **69** | Bonus lock time if you lose: +10 minutes for a 69 on the D100, +5 on any smaller die. |

## Turns

* The bot announces whose turn it is and the size of the die. Type `/bot roll` (or `!roll` in chat).
* Rolling out of turn does nothing except a reminder.
* Missed your turn? You get a second chance at the end of the round, with 30 seconds to roll.
* After a loss, take the item off and close your Wardrobe (or `/bot removed`). The game waits for you, with reminders.

## Joining, leaving, coming back

* **Before the start:** anyone can `/bot join`. The host can set the number of players with `/bot players 2 6`.
* **During a game:** only if an admin has turned on mid-game joining. The game pauses for up to 60 seconds while you get ready.
* **Leaving the room:** you have **2 rounds** (at least 90 seconds) to come back before you're removed from the game.
* There's a **5-minute break** between games, so everyone can check their locks went on properly.

## Stopping

* `/bot pause` asks for a quick pause during a turn. Anyone can `/bot resume`.
* `/bot safeword` (or the Bondage Club safeword) removes all your restraints immediately. See [Safety](Safety).

## After the game

The winner is freed. Everyone else is locked for the lock time: see [Bondage, Locks and Prizes](Bondage-Locks-and-Prizes).

Check the standings any time with `/bot leaderboard`.
