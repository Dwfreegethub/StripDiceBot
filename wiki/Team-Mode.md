# Team Mode

Two teams of 2 or 3.

## Setting up

1. Someone types `/bot teamgame`. The bot asks how many players per team: 2 or 3.
2. Everyone picks a side with `/bot join team1` or `/bot join team2`.
3. `/bot teams` shows who's on which side.

Clothing, rolling and restraints work exactly as in a [multiplayer game](Multiplayer-Games).

## Playing

* Turns alternate between the teams: Team 1, Team 2, Team 1, ...
* **A team is out once every one of its players is fully bound.** The other team wins, and its players are freed.
* The bot may suggest swapping two players so the prize rules work out. Both of them confirm with `/bot swap`.

## Ghosts

If someone safewords during a team game, the game doesn't stop. They become a **ghost**: their turns roll a 1 automatically, so their side keeps losing items, but nobody waits for them.

If that leaves both teams with the same number of active players, everyone still playing gets a whispered vote: keep the ghost's rolls, or drop that player from the game entirely.

## Locks

The losing team is locked at the end, as in a normal game. 69s go into one shared pool for the losing team, up to 30 minutes. See [Bondage, Locks and Prizes](Bondage-Locks-and-Prizes).
