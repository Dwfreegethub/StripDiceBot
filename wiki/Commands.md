# Commands

<!-- Generated from src/help.ts by `npm run wiki`. Edit help.ts, not this page. -->

Type **`/bot`** and a command straight into the chat box, e.g. `/bot join`. Only the bot sees it, so the room stays quiet. The bot answers by whisper.

> Old habits welcome: every command also works with ! in a whisper to me (e.g. !roll). Commands you type with ! in room chat work as before too, though everyone sees them.

Words in `[brackets]` are what you fill in. Answers to the bot's questions (yes, no, 1, 2...) can be whispered or sent as `/bot yes`.

## Strip Dice Help

Type /bot followed by a command, right in the chat box. Only I see it, so the room stays quiet.

| Command | What it does |
|---|---|
| `/bot help player` | Multiplayer game commands (join, clothing, rolling, locks) |
| `/bot help solo` | Solo whisper game & leaderboard commands |
| `/bot help team` | Team mode (2v2/3v3) rules |
| `/bot bd` | Matchmaking: get beeped when someone wants a game, and beep them back |
| `/bot help admin` | *(admin)* Admin commands |
| `/bot changelog` | What's changed recently |
| `/bot about` | About this bot |

## Strip Dice Commands

| Command | What it does |
|---|---|
| `/bot join` | Join the game (or start one if none is running) |
| `/bot players [min] [max]` | Host only, before the start: set how many players the game takes (e.g. /bot players 2 6, or /bot players 4) |
| `/bot wearing` | Go through your outfit one item at a time (yes/no) |
| `/bot wearing [items]` | Declare your clothing all at once. Female list: shoes socks jacket top bottom bra panties. Male list: shoes socks jacket shirt pants underwear |
| `/bot clothes` · `/bot clothes male` · `/bot clothes female` | Show or switch which clothing list /bot wearing uses |
| `/bot naked` | Declare you have no clothing on |
| `/bot same` | Reuse your outfit from last game |
| `/bot settings` · `/bot settings save` · `/bot settings forget` | Show your saved answers (toys, prize, restraints, outfit), turn saving on, or wipe them. Saved answers let /bot join get you in with one SAME |
| `/bot ready` | Confirm you are ready to play |
| `/bot start` | Start the game early |
| `/bot cancel` | Cancel the countdown |
| `/bot roll` | Roll the dice on your turn |
| `/bot removed` | Confirm you removed a clothing item (or just close your Wardrobe) |
| `/bot veto` · `/bot accept` | When someone picks a restraint for you: refuse it (they pick again) or take it |
| `/bot lock10` · `/bot lock15` · `/bot lock20` | Set the end-game lock duration (admin only, default 10 min) |
| `/bot claim` · `/bot claim [numbers]` | Winner only: list the prizes you won, then take their lock passwords (e.g. /bot claim 1 2) |
| `/bot released` · `/bot stuck` | Confirm whether your locks released at the end of the game |
| `/bot safeword` | Emergency: remove all restraints immediately |
| `/bot pause` | Request a quick pause; anyone can /bot resume to continue |
| `/bot resume` | End a pause |
| `/bot continue` | After someone safewords: carry on without them (within 60 seconds) |
| `/bot leaderboard` · `/bot lb` | View the multiplayer win/loss leaderboard |
| `/bot feedback [text]` · `/bot feedback` | Send feedback to the developers, or send just /bot feedback and then say it |
| `/bot outfit [description]` | Submit an outfit idea that may be used as a future penalty |
| `/bot friend` · `/bot unfriend` | Add me to your friend list so you can see when the room is up, or undo it |
| `/bot changelog` | See what's changed recently |
| `/bot about` | About this bot |
| `/bot help` | Show the help menu |

## Solo & Stats

A whispered game of your own: roll down from a D100, lose an item on every 1, until you're naked.

| Command | What it does |
|---|---|
| `/bot solo race` | Fewest rolls to get naked wins |
| `/bot solo survive` | Most rolls before getting naked wins |
| `/bot roll` | Roll in your solo game |
| `/bot removed` | Once you've taken off the item I asked for (or just close your Wardrobe). No rush, the game waits for you. |
| `/bot scores` · `/bot scores race` · `/bot scores survive` | View solo leaderboards |
| `/bot scores me` | View your personal solo stats |
| `/bot settings sensitive yes` · `/bot settings sensitive no` | Whether a lost solo game's bondage may include sensitive items (nipple clamps, chastity, tail plugs). Asked before your first solo game |

Beat the record for your item count and you go free. Miss it and a bondage penalty locks on. Before your first solo game I ask whether that may include sensitive items; say no and they're left out.

## Team Mode (2v2 / 3v3)

| Command | What it does |
|---|---|
| `/bot teamgame` | Start a team game (asks for team size, then teams sign up) |
| `/bot join team1` · `/bot join team2` | Pick your side during team setup |
| `/bot teams` | Show current team rosters (and who's a ghost) |
| `/bot swap` | Confirm a suggested team swap, when I offer one |

Turn order alternates between teams (Team 1, Team 2, Team 1, ...). Everything else — clothing, rolling, bondage — works exactly like a normal game.

Win condition: a team is eliminated once every one of its members is fully bound. The other team wins!

👻 Ghosts: if a player safewords mid-game, they become a ghost instead of leaving — their turns auto-roll a 1 (so they keep stripping/binding) but the game never pauses for them. If this brings both teams back to equal active-player counts, everyone still active gets a whisper vote to keep the ghost rolls or drop that player from the game entirely.

## Matchmaking

Nobody in the room? Register once, then beep everyone who's online when you want a game.

| Command | What it does |
|---|---|
| `/bot bd register` | Join the pool (you'll add me as a friend too) |
| `/bot bd unregister` | Leave the pool |
| `/bot bd pause` · `/bot bd resume` | Stop / restart getting beeps (you stay registered) |
| `/bot bd status` | Your current status |
| `/bot looking` | Beep every registered player who's online that you're here for a game |
| `/bot bd pool` | *(admin)* Everyone registered, who's online, and their strike counts |
| `/bot bd clearstrikes [name\|memberNumber]` | *(admin)* Reset a player's early-leave strikes |
| `/bot bd unblock [name\|memberNumber]` | *(admin)* Put a blocked player back in the pool |

## Admin Commands

| Command | What it does |
|---|---|
| `/bot locktime [mins]` | *(admin)* Set end game lock duration |
| `/bot reset` | *(admin)* End the current game immediately, remove bondage items from all players, and reset for a new game |
| `/bot midgamejoin on` · `/bot midgamejoin off` | *(admin)* Allow players to join games already in progress |
| `/bot free [player name]` | *(admin)* Remove all bondage items from a player; they stay in the game |
| `/bot kick [player name]` | *(admin)* Remove a player from the active game entirely (they keep any bondage already applied) |
| `/bot solo_reset` | *(admin)* List players with active solo games |
| `/bot solo_reset [player name]` | *(admin)* Discard a player's solo game with no penalty |
| `/bot feedback list` | *(admin)* View a summary of all tracked feedback |
| `/bot setstatus [playerID] [item#\|all] [status]` | *(admin)* Set one feedback item's status (numbers from /bot feedback list): pending, reviewing, testing, researching, implemented, partly_implemented, declined, thanks. Resolved ones are whispered to the player once |
| `/bot feedback remove [playerID] [item#]` | *(admin)* Delete an accidental feedback item so it is never whispered back |
| `/bot outfits` | *(admin)* View submitted outfit suggestions |
| `/bot gamestats` | *(admin)* Show cumulative game counts (multiplayer / team / solo / aborted) |
| `/bot testoutfit [name]` | *(admin)* Force your next bondage outfit (for testing) |
| `/bot debugroll [number]` | *(admin)* Force your next roll (for testing) |
| `/bot testbeep [memberNumber\|name] [message]` | *(admin)* Beep a player to test out-of-room contact (online only) |

Admins have no /bot looking cooldown and earn no matchmaking strikes.
