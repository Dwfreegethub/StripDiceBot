# Bondage, Locks and Prizes

## How your restraints are chosen

Before the game, the bot asks each player **outfit or pick**:

* **Outfit:** a preset bondage outfit, applied one piece per loss. No answer within 60 seconds means outfit.
* **Pick:** another player chooses each restraint, slot by slot, from the Bondage Club catalogue. If you choose pick, you also say which body areas you allow (see below).

A fully bound player in pick mode has 7 items on.

### Areas you allow (pick mode)

The bot whispers a list of areas: Arms, Legs, Feet, Torso, Hands, Head, Hood, Neck, Mouth, Boots, Nipples, Breast, Pelvis. Reply with the ones you allow, separated by commas, or `all`. Choose at least 6.

**Nipples, Breast and Pelvis are off unless you name them.** No answer within 60 seconds keeps the defaults (everything else).

### Saying no to a pick

When someone picks a restraint for you, you have 30 seconds:

* `/bot veto`: refuse it. They choose something else.
* `/bot accept`: take it. Silence counts as accepting.

Items that won't show on your character's body are listed at the bottom of the picker's list, with the reason (for example *needs breasts*).

## The lock at the end

When the game ends, the winner's restraints come off and everyone else is locked with timer locks.

1. **The vote.** The bot proposes a lock time, based on the game's lock setting and how many played. The losers and the winner each whisper **1** (5 minutes less), **2** (accept) or **3** (5 minutes more). The majority wins, and voting lasts 30 seconds.
2. **69 bonuses.** Any 69 you rolled adds time to your own lock. A winner who rolled 69s hands their minutes out to the losers instead. In team games, all the 69s go into one pool for the losing team, up to 30 minutes.
3. **The locks go on.** The bot announces everyone's time in the room.
4. **When time is up**, the locks release by themselves. The bot asks you to confirm with `/bot released`, or `/bot stuck` if something stayed locked.

## Toys

Before the game the bot asks whether the winner may add toys and touch players at the end. **If anyone says no, there are no toys that game.** Someone joining a game that already has toys must agree to them to play.

## Prizes

Before the game you can also opt in as a **prize**. If you lose, the winner gets your lock password and a leash: they can take you with them while your lock lasts.

* Only players who said yes can become prizes. Saying no changes nothing else.
* In team games, every member of a team must agree for that team's prizes to count.
* The winner types `/bot claim` to see their prizes and `/bot claim 1` (or `/bot claim 1 2`) to take the passwords.
