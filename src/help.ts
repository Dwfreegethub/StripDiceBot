// ============================================================
// HELP - every player-facing command description, in one place.
//
// !help, !bd, the tournament rules and wiki/Commands.md are all built from
// this table, so the in-game help and the wiki cannot disagree. Pure data and
// formatting: no I/O, no game state (callers pass a HelpContext).
//
// `npm run check:help` fails if a command in game.ts's commandTable is neither
// described here nor listed in HIDDEN_COMMANDS, if a usage line here would not
// reach the command it describes, or if wiki/Commands.md is out of date
// (`npm run wiki` rewrites it).
//
// Commands are written in the /bot form ("/bot roll"). Every one of them also
// works the old way, as a whispered "!roll"; BANG_NOTE says so on every page.
// ============================================================
import { DEFAULT_LOCK_MINUTES } from "./constants";

export interface HelpContext {
    isAdmin: boolean;
    /** A tournament exists (registration open or running). */
    tournamentRunning: boolean;
    /** A team game is in progress. */
    teamGameRunning: boolean;
}

export interface HelpEntry {
    /**
     * What follows "/bot", e.g. "wearing [items]". Alternatives are separated
     * by " / " ("lock10 / lock15 / lock20"); each must reach a real command.
     */
    usage: string;
    text: string | ((ctx: HelpContext) => string);
    adminOnly?: boolean;
    /** Shown in game only while a tournament exists. */
    tournamentOnly?: boolean;
}

export interface HelpSection {
    title: string;
    /** Prose above the command list. */
    intro?: string;
    entries: HelpEntry[];
    /** Prose below the command list. */
    outro?: string;
}

export const BANG_NOTE =
    "Old habits welcome: every command also works with ! in a whisper to me (e.g. !roll).";

export const HELP_MENU: HelpSection = {
    title: "Strip Dice Help",
    intro: "Type /bot followed by a command, right in the chat box. Only I see it, so the room stays quiet.",
    entries: [
        { usage: "help player", text: "Multiplayer game commands (join, clothing, rolling, locks)" },
        { usage: "help solo", text: "Solo whisper game & leaderboard commands" },
        { usage: "help team", text: ctx => `Team mode (2v2/3v3) rules${ctx.teamGameRunning ? " — a team game is running now!" : ""}` },
        { usage: "bd", text: "Matchmaking: get beeped when someone wants a game, and beep them back" },
        { usage: "tournament", text: "Tournament standings, your match and time left — one is running now!", tournamentOnly: true },
        { usage: "tournament rules", text: "How the tournament works", tournamentOnly: true },
        { usage: "help admin", text: "Admin commands", adminOnly: true },
        { usage: "changelog", text: "What's changed recently" },
        { usage: "about", text: "About this bot" },
    ],
};

export const HELP_PLAYER: HelpSection = {
    title: "Strip Dice Commands",
    entries: [
        { usage: "join", text: "Join the game (or start one if none is running)" },
        { usage: "players [min] [max]", text: "Host only, before the start: set how many players the game takes (e.g. /bot players 2 6, or /bot players 4)" },
        { usage: "wearing", text: "Go through your outfit one item at a time (yes/no)" },
        { usage: "wearing [items]", text: "Declare your clothing all at once. Female list: shoes socks jacket top bottom bra panties. Male list: shoes socks jacket shirt pants underwear" },
        { usage: "clothes / clothes male / clothes female", text: "Show or switch which clothing list /bot wearing uses" },
        { usage: "naked", text: "Declare you have no clothing on" },
        { usage: "same", text: "Reuse your outfit from last game" },
        { usage: "ready", text: "Confirm you are ready to play" },
        { usage: "start", text: "Start the game early" },
        { usage: "cancel", text: "Cancel the countdown" },
        { usage: "roll", text: "Roll the dice on your turn" },
        { usage: "removed", text: "Confirm you removed a clothing item (or just close your Wardrobe)" },
        { usage: "veto / accept", text: "When someone picks a restraint for you: refuse it (they pick again) or take it" },
        { usage: "lock10 / lock15 / lock20", text: `Set the end-game lock duration (admin only, default ${DEFAULT_LOCK_MINUTES} min)` },
        { usage: "claim / claim [numbers]", text: "Winner only: list the prizes you won, then take their lock passwords (e.g. /bot claim 1 2)" },
        { usage: "released / stuck", text: "Confirm whether your locks released at the end of the game" },
        { usage: "safeword", text: "Emergency: remove all restraints immediately" },
        { usage: "pause", text: "Request a quick pause; anyone can /bot resume to continue" },
        { usage: "resume", text: "End a pause" },
        { usage: "continue", text: "After someone safewords: carry on without them (within 60 seconds)" },
        { usage: "leaderboard / lb", text: "View the multiplayer win/loss leaderboard" },
        { usage: "feedback [text] / feedback", text: "Send feedback to the developers, or send just /bot feedback and then say it" },
        { usage: "outfit [description]", text: "Submit an outfit idea that may be used as a future penalty" },
        { usage: "friend / unfriend", text: "Add me to your friend list so you can see when the room is up, or undo it" },
        { usage: "changelog", text: "See what's changed recently" },
        { usage: "about", text: "About this bot" },
        { usage: "help", text: "Show the help menu" },
    ],
};

export const HELP_SOLO: HelpSection = {
    title: "Solo & Stats",
    intro: "A whispered game of your own: roll down from a D100, lose an item on every 1, until you're naked.",
    entries: [
        { usage: "solo race", text: "Fewest rolls to get naked wins" },
        { usage: "solo survive", text: "Most rolls before getting naked wins" },
        { usage: "roll", text: "Roll in your solo game" },
        { usage: "removed", text: "Once you've taken off the item I asked for (or just close your Wardrobe). No rush, the game waits for you." },
        { usage: "scores / scores race / scores survive", text: "View solo leaderboards" },
        { usage: "scores me", text: "View your personal solo stats" },
    ],
    outro: "Beat the record for your item count and you go free. Miss it and a bondage penalty locks on.",
};

export const HELP_TEAM: HelpSection = {
    title: "Team Mode (2v2 / 3v3)",
    entries: [
        { usage: "teamgame", text: "Start a team game (asks for team size, then teams sign up)" },
        { usage: "join team1 / join team2", text: "Pick your side during team setup" },
        { usage: "teams", text: "Show current team rosters (and who's a ghost)" },
        { usage: "swap", text: "Confirm a suggested team swap, when I offer one" },
    ],
    outro:
        "Turn order alternates between teams (Team 1, Team 2, Team 1, ...). Everything else — clothing, rolling, bondage — works exactly like a normal game.\n" +
        "\n" +
        "Win condition: a team is eliminated once every one of its members is fully bound. The other team wins!\n" +
        "\n" +
        "👻 Ghosts: if a player safewords mid-game, they become a ghost instead of leaving — their turns auto-roll a 1 (so they keep stripping/binding) but the game never pauses for them. If this brings both teams back to equal active-player counts, everyone still active gets a whisper vote to keep the ghost rolls or drop that player from the game entirely.",
};

export const HELP_MATCHMAKING: HelpSection = {
    title: "Matchmaking",
    intro: "Nobody in the room? Register once, then beep everyone who's online when you want a game.",
    entries: [
        { usage: "bd register", text: "Join the pool (you'll add me as a friend too)" },
        { usage: "bd unregister", text: "Leave the pool" },
        { usage: "bd pause / bd resume", text: "Stop / restart getting beeps (you stay registered)" },
        { usage: "bd status", text: "Your current status" },
        { usage: "looking", text: "Beep every registered player who's online that you're here for a game" },
        { usage: "bd pool", text: "Everyone registered, who's online, and their strike counts", adminOnly: true },
        { usage: "bd clearstrikes [name|memberNumber]", text: "Reset a player's early-leave strikes", adminOnly: true },
        { usage: "bd unblock [name|memberNumber]", text: "Put a blocked player back in the pool", adminOnly: true },
    ],
};

export const HELP_ADMIN: HelpSection = {
    title: "Admin Commands",
    entries: [
        { usage: "locktime [mins]", text: "Set end game lock duration", adminOnly: true },
        { usage: "reset", text: "End the current game immediately, remove bondage items from all players, and reset for a new game", adminOnly: true },
        { usage: "midgamejoin on / midgamejoin off", text: "Allow players to join games already in progress", adminOnly: true },
        { usage: "free [player name]", text: "Remove all bondage items from a player; they stay in the game", adminOnly: true },
        { usage: "kick [player name]", text: "Remove a player from the active game entirely (they keep any bondage already applied)", adminOnly: true },
        { usage: "solo_reset", text: "List players with active solo games", adminOnly: true },
        { usage: "solo_reset [player name]", text: "Discard a player's solo game with no penalty", adminOnly: true },
        { usage: "feedback list", text: "View a summary of all tracked feedback", adminOnly: true },
        { usage: "setstatus [playerID] [status]", text: "Set a player's feedback status (pending, reviewing, testing, researching, implemented, partly_implemented, declined)", adminOnly: true },
        { usage: "outfits", text: "View submitted outfit suggestions", adminOnly: true },
        { usage: "gamestats", text: "Show cumulative game counts (multiplayer / team / solo / aborted)", adminOnly: true },
        { usage: "testoutfit [name]", text: "Force your next bondage outfit (for testing)", adminOnly: true },
        { usage: "debugroll [number]", text: "Force your next roll (for testing)", adminOnly: true },
        { usage: "testbeep [memberNumber|name] [message]", text: "Beep a player to test out-of-room contact (online only)", adminOnly: true },
    ],
    outro: "Admins have no /bot looking cooldown and earn no matchmaking strikes.",
};

// --- Tournament (dev branch only: master is the tournament-free build) ---
export const HELP_TOURNAMENT: HelpSection = {
    title: "Tournament",
    entries: [
        { usage: "tournament / tournament status", text: "Standings, your opponent, time left" },
        { usage: "tournament register", text: "Sign up while registration is open" },
        { usage: "tournament play", text: "Play one of your games for this round" },
        { usage: "tournament serve", text: "Start serving punishment time you owe" },
        { usage: "tournament stop", text: "Stop serving for now (the rest waits for you)" },
        { usage: "claim", text: "Take a claimable tournament prisoner (when no game prize is waiting for you)" },
        { usage: "tournament withdraw", text: "Leave (between rounds, if allowed)" },
        { usage: "tournament rules", text: "How the tournament works" },
        { usage: "tournament setup", text: "Create a tournament (asks 8 questions; durations in plain language)", adminOnly: true },
        { usage: "tournament advance", text: "Start Round 1 now, or close the current round early (unplayed games count as losses)", adminOnly: true },
        { usage: "tournament pause / tournament resume", text: "Freeze or restart round advancement", adminOnly: true },
        { usage: "tournament cancel", text: "Cancel and archive the current tournament", adminOnly: true },
    ],
};
// --- end tournament ---

/** Every section, in the order the wiki's Commands page lists them. */
export const ALL_HELP_SECTIONS: HelpSection[] = [
    HELP_MENU, HELP_PLAYER, HELP_SOLO, HELP_TEAM, HELP_MATCHMAKING, HELP_TOURNAMENT, HELP_ADMIN,
];

/**
 * Commands deliberately left out of the help, each with the reason. Anything
 * in game.ts's commandTable must be either described above or listed here.
 */
export const HIDDEN_COMMANDS: { command: string; why: string }[] = [
    { command: "!r", why: "shortcut for !roll" },
    { command: "!rool", why: "typo of !roll" },
    { command: "!rol", why: "typo of !roll" },
    { command: "!oll", why: "typo of !roll" },
    { command: "!yes", why: "answer to the lock-release check; the prompt says so" },
    { command: "!no", why: "answer to the lock-release check; the prompt says so" },
    { command: "!solo", why: "only prints 'Usage: !solo race or !solo survive'" },
];

// ---- formatting ---------------------------------------------------------

export function entryText(entry: HelpEntry, ctx: HelpContext): string {
    return typeof entry.text === "function" ? entry.text(ctx) : entry.text;
}

function visible(entry: HelpEntry, ctx: HelpContext): boolean {
    if (entry.adminOnly && !ctx.isAdmin) return false;
    if (entry.tournamentOnly && !ctx.tournamentRunning) return false;
    return true;
}

export function renderEntry(entry: HelpEntry, ctx: HelpContext): string {
    return `/bot ${entry.usage} - ${entryText(entry, ctx)}`;
}

/**
 * One section as an in-game whisper. `adminOnly` entries show only to admins;
 * pass `adminEntriesOnly` to list just those (the admin page's matchmaking
 * and tournament parts).
 */
export function renderSection(section: HelpSection, ctx: HelpContext, opts: { header?: boolean; adminEntriesOnly?: boolean; note?: boolean } = {}): string {
    const { header = true, adminEntriesOnly = false, note = true } = opts;
    const lines: string[] = [];
    if (header) lines.push(`=== ${section.title} ===`);
    if (section.intro && !adminEntriesOnly) lines.push(section.intro);
    for (const entry of section.entries) {
        if (adminEntriesOnly && !entry.adminOnly) continue;
        if (visible(entry, ctx)) lines.push(renderEntry(entry, ctx));
    }
    if (section.outro && !adminEntriesOnly) lines.push("", section.outro);
    if (note) lines.push("", BANG_NOTE);
    return lines.join("\n");
}
