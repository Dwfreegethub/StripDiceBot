import { BCConnection } from "./connection";
import { log, centralTimestamp } from "./logger";
import * as fs from "fs";
import * as path from "path";
import * as LZString from "lz-string";

const GAME_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Structured game-activity log line, written with a full timestamp (unlike
// log()'s HH:MM:SS-only prefix) so game start/end events can be correlated
// against game_log.json entries.
function logGameEvent(message: string): void {
    console.log(`[${centralTimestamp()}] ${message}`);
}

// ============================================================
// TEST MODE - set to false for production
// ============================================================
const TEST_MODE = true;
const TEST_PASSWORD = "TEST1234";
const DEFAULT_LOCK_MINUTES = 10;
const JOIN_CONFIRMATION_WINDOW_MS = 60 * 1000;
const STARTING_DICE_MAX = 100;

// ============================================================
// SOLO GAME MODE
// ============================================================
const SOLO_BRACKET_MIN = 1;
const SOLO_BRACKET_MAX = 6; // 6 = CLOTHING_SLOTS.length (shoes, socks, top, bottom, bra, panties)
const SOLO_DEFAULT_TARGET = 8; // Used when no daily record exists yet for a bracket
const SOLO_BASE_PENALTY_MINUTES = 5;
const SOLO_DICE_MAX = 100;
const SOLO_INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000;

// ============================================================
// ITEM REMOVAL - end-of-game bondage cleanup
// ============================================================
const REMOVAL_SLOTS = [
    "ItemFeet",
    "ItemBoots",
    "ItemLegs",
    "ItemPelvis",
    "ItemBreast",
    "ItemTorso",
    "ItemTorso2",
    "ItemArms",
    "ItemHands",
    "ItemNeck",
    "ItemNeckRestraints",
    "ItemMouth",
    "ItemHead",
];
const REMOVAL_SLOT_DELAY_MS = 200; // Stagger between each slot's removal attempt
const REMOVAL_UNLOCK_GAP_MS = 500; // Gap between unlocking an item and removing it
const REMOVAL_RETRY_DELAY_MS = 1000;
const MAX_REMOVAL_ATTEMPTS = 5;

// ============================================================
// SAFEWORD / !free - retry logic for removing locked bondage items
// ============================================================
const SAFEWORD_VERIFY_DELAY_MS = 500; // Delay before checking if a removal landed
const SAFEWORD_RETRY_DELAYS_MS = [500, 1000, 1500];

// ============================================================
// END-GAME LOCK VERIFICATION - confirm the 10-minute timer refresh landed
// ============================================================
const LOCK_VERIFY_DELAY_MS = 1000;
const LOCK_TIMER_TOLERANCE_MS = 30 * 1000;
const MAX_END_GAME_LOCK_RETRIES = 3;

// ============================================================
// END-GAME LOCK BURST PACING - every emit in the end-game burst (winner's
// item removal + each bound player's lock application) shares one staggered
// timeline so the combined burst stays well under the BC server's per-second
// rate limit. Baseline ~125ms (~8/sec, 40% of the 20/sec limit) x1.5 safety
// margin.
// ============================================================
const END_GAME_EMIT_STAGGER_MS = 200;

// Pause between games so players have time to confirm their end-game locks
// released/applied correctly before the next bondage phase begins.
const GAME_COOLDOWN_MS = 5 * 60 * 1000;

// ============================================================
// CLOTHING SLOTS - ordered loss sequence
// ============================================================
const CLOTHING_SLOTS = ["shoes", "socks", "top", "bottom", "bra", "panties"];

const CLOTHING_ALIASES: Record<string, string> = {
    // top
    "shirt": "top", "tshirt": "top", "t-shirt": "top", "blouse": "top",
    "tank": "top", "tanktop": "top", "tank-top": "top", "sweater": "top",
    "hoodie": "top", "jacket": "top", "dress": "top", "corset": "top",
    // bottom
    "shorts": "bottom", "pants": "bottom", "jeans": "bottom", "skirt": "bottom",
    "leggings": "bottom", "trousers": "bottom",
    // shoes
    "shoe": "shoes", "heels": "shoes", "boots": "shoes", "sneakers": "shoes",
    "sandals": "shoes", "flats": "shoes",
    // socks
    "sock": "socks", "stockings": "socks", "tights": "socks",
    // bra
    "bikini": "bra", "bralette": "bra",
    // panties
    "underwear": "panties", "thong": "panties", "panty": "panties",
    "knickers": "panties", "briefs": "panties",
};

// ============================================================
// BONDAGE OUTFITS - multiple sets, one is randomly chosen per
// player when they start receiving bondage items.
// Add more outfits here as we confirm asset names.
// ============================================================
interface BondageItem {
    group: string;
    name: string;
    color: string | string[];
    property: any;
}

interface BondageOutfit {
    name: string;
    items: BondageItem[];
}

// Raw shape of an entry in outfits.json. Either a curated "items" array,
// or a BC appearance share code plus the list of item groups to extract from it.
interface OutfitDefinition {
    name: string;
    items?: BondageItem[];
    code?: string;
    groups?: string[];
}

// BC sends each character's body/appearance as an array of items keyed by
// "Group". There's no explicit IsMale/BodyType flag, but the "Pronouns"
// group ("HeHim" / "SheHer" / "TheyThem") reflects how the player has set
// up their character and is the closest available signal for tailoring
// outfit selection.
function extractPronouns(character: any): string | undefined {
    return character?.Appearance?.find((a: any) => a.Group === "Pronouns")?.Name;
}

// Strips owner/lock-specific fields from a decoded appearance item's Property
// so the bot can apply its own lock on top of it.
function cleanDecodedProperty(property: any): any {
    if (!property) return {};
    const {
        LockedBy, LockMemberNumber, LockMemberName, Password, Hint, LockSet,
        RemoveItem, ShowTimer, EnableRandomInput, MemberNumberList, RemoveTimer,
        ...rest
    } = property;
    if (Array.isArray(rest.Effect)) {
        rest.Effect = rest.Effect.filter((e: string) => e !== "Lock");
    }
    return rest;
}

function loadBondageOutfits(): BondageOutfit[] {
    try {
        const filePath = path.join(__dirname, "..", "outfits.json");
        const raw = fs.readFileSync(filePath, "utf8");
        const data: { outfits: OutfitDefinition[] } = JSON.parse(raw);

        const outfits: BondageOutfit[] = [];

        for (const def of data.outfits) {
            if (def.code && def.groups) {
                const decompressed = LZString.decompressFromBase64(def.code);
                if (!decompressed) {
                    log(`Outfit "${def.name}": failed to decompress appearance code, skipping.`);
                    continue;
                }
                const appearance: any[] = JSON.parse(decompressed);
                const items: BondageItem[] = def.groups.map(group => {
                    const entry = appearance.find(e => e.Group === group);
                    if (!entry) {
                        throw new Error(`Outfit "${def.name}": group "${group}" not found in appearance code`);
                    }
                    return {
                        group: entry.Group,
                        name: entry.Name,
                        color: entry.Color,
                        property: cleanDecodedProperty(entry.Property)
                    };
                });
                outfits.push({ name: def.name, items });
            } else if (def.items) {
                outfits.push({ name: def.name, items: def.items });
            } else {
                throw new Error(`Outfit "${def.name}" has neither "items" nor "code"+"groups"`);
            }
        }

        return outfits;
    } catch (err) {
        log(`FATAL: Could not load outfits.json — check the file exists and is valid JSON: ${err}`);
        process.exit(1);
    }
}

const BONDAGE_OUTFITS: BondageOutfit[] = loadBondageOutfits();

// ============================================================
// GAME STATES
// ============================================================
enum GameState {
    Idle,           // No game running, waiting for players to join
    Registration,   // Players joining, declaring clothing
    Countdown,      // All players joined, 30 second countdown
    Rolling,        // Active game, waiting for current player to roll
    WaitingRemove,  // Player lost, waiting for !removed
    WaitingBondage, // Player naked, bot applying bondage
    SafewordPause,  // A player called safeword, waiting for !continue or timeout
    GameOver        // All players bound, applying locks
}

// ============================================================
// PLAYER DATA
// ============================================================
interface Player {
    memberNumber: number;
    name: string;
    clothing: string[];         // Their declared clothing items in order
    clothingRemoved: number;    // How many clothing items removed so far
    bondageApplied: number;     // How many bondage items applied so far
    isNaked: boolean;
    isFullyBound: boolean;
    timeoutWarned: boolean;     // Has been warned once for timeout
    timeoutCount: number;       // Number of times skipped
    ready: boolean;             // Has declared clothing and said !ready
    midGameJoin: boolean;       // Joined while a game was already in progress
    clothingQuestionIndex: number | null; // Position in guided !wearing Q&A, null if not active
    pendingClothing: string[];  // Items collected so far during guided Q&A
    bondageOutfit: BondageOutfit | null; // Outfit assigned once this player starts receiving bondage
    pendingReturn: boolean;     // Left the room mid-game; in grace period to return
    leaveRoundsRemaining: number; // Rounds left to return before removal, while pendingReturn
    freePass: boolean;          // Rolled 100 on the D100 - skips their next roll automatically
    pendingPenaltySteps: number; // Extra penalty steps still owed from a double-penalty (rolled 1 on the D100)
}

// Snapshot of a player's lock-application state, captured when the post-lock
// "did everything apply?" verification whisper is sent. Captured rather than
// read live because resetGame() clears `players` well before the 60s
// response window elapses.
interface PendingLockVerification {
    name: string;
    bondageApplied: number;
    bondageOutfit: BondageOutfit | null;
    lockDurationMinutes: number;
    lockEndTime: number;
    timeout: NodeJS.Timeout;
}

// ============================================================
// FEEDBACK STATUS TRACKING
// ============================================================
type FeedbackItemStatus = "pending" | "reviewing" | "testing" | "researching" | "implemented" | "declined" | "partly_implemented";

interface FeedbackItem {
    timestamp: string;
    text: string;
    status: FeedbackItemStatus;
    // Resolved statuses (implemented/declined/partly_implemented) are only
    // whispered to the submitter once; this flag is set after that whisper
    // so the entry isn't repeated on later joins. Pending entries are never
    // marked shown.
    statusShown?: boolean;
}

interface FeedbackStatusEntry {
    name: string;
    items: FeedbackItem[];
}

const FEEDBACK_STATUS_LABELS: Record<FeedbackItemStatus, string> = {
    pending: "⏳ Pending review",
    reviewing: "🔍 Reviewing",
    testing: "🧪 Testing",
    researching: "🔬 Researching — we're looking into this!",
    implemented: "✅ Implemented",
    declined: "❌ Declined",
    partly_implemented: "🔧 Partly implemented",
};

// Statuses that count as "resolved" - shown to the submitter only once.
const RESOLVED_FEEDBACK_STATUSES: ReadonlySet<FeedbackItemStatus> = new Set([
    "implemented",
    "declined",
    "partly_implemented",
]);

// ============================================================
// PLAYER TRACKING
// ============================================================
interface PlayerRecord {
    memberNumber: number;
    name: string;
    firstSeen: string;
    lastSeen: string;
    gamesPlayed: number;
    gamesWon: number;
    gamesLost: number;
    feedbackGiven: boolean;
}

// ============================================================
// SOLO GAME MODE - types and records persistence
// ============================================================
type SoloMode = "race" | "survive";

// Active solo game state, isolated per player. Solo games run alongside an
// active multiplayer game without interference; all interaction is whispered.
interface SoloGameState {
    memberNumber: number;
    name: string;
    mode: SoloMode;
    bracket: number;          // Starting clothing item count
    currentMax: number;       // Current dice ceiling for the shrinking-dice chain; resets to 100 at the start of each item's chain
    totalRolls: number;       // Running roll count across the whole game
    rollsThisItem: number;    // Rolls taken in the current chain (for display)
    clothingRemaining: string[]; // Items still to lose, in loss order
    clothingLost: string[];      // Items already removed
    startTime: string;        // ISO timestamp when this solo game began
    awaitingRemoval: boolean; // true after losing an item, until the player confirms it's off
    inactivityTimer: NodeJS.Timeout | null; // soft nudge if the player goes quiet
}

// One line of game_log.json (newline-delimited JSON), appended on every
// multiplayer/solo game end.
interface GameLogEntry {
    type: "multiplayer" | "solo";
    mode: SoloMode | null;
    startTime: string;
    endTime: string;
    players: string[];
    outcome: string;
    winner?: string;
    score?: number;
    penaltyMin?: number;
}

interface SoloRecordEntry {
    memberNumber: number;
    name: string;
    rolls: number;
}

type SoloBracketRecords = Record<string, SoloRecordEntry>; // bracket -> record
type SoloAttemptCounts = Record<string, number>;           // memberNumber -> attempts today

interface SoloRecordsData {
    date: string; // UTC date (YYYY-MM-DD) the daily records/attempts were last reset
    daily: Record<SoloMode, SoloBracketRecords>;
    allTime: Record<SoloMode, SoloBracketRecords>;
    attempts: Record<SoloMode, Record<string, SoloAttemptCounts>>; // bracket -> memberNumber -> count
}

function utcDateString(): string {
    return new Date().toISOString().slice(0, 10);
}

function emptySoloRecordsData(): SoloRecordsData {
    return {
        date: utcDateString(),
        daily: { race: {}, survive: {} },
        allTime: { race: {}, survive: {} },
        attempts: { race: {}, survive: {} },
    };
}

// Player-submitted outfit idea, stored for admin review and possible future
// use as a bondage penalty outfit.
interface OutfitSuggestion {
    memberNumber: number;
    name: string;
    description: string;
    timestamp: string;
}

// ============================================================
// PASSWORD GENERATOR
// ============================================================
function generatePassword(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let result = "";
    for (let i = 0; i < 8; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

// ============================================================
// COMMAND DISPATCH TABLE
// ============================================================
type CommandHandler = (memberNumber: number, name: string, msg: string, message: string) => void;

interface CommandDef {
    handler: CommandHandler;
    whisperOnly?: boolean; // Only dispatched from handleWhisper
    chatOnly?: boolean;    // Only dispatched from handleChat
    prefix?: boolean;      // Match if msg starts with the command string, instead of equals
}

// ============================================================
// GAME CLASS
// ============================================================
export class StripDiceGame {
    private bot: BCConnection;
    private state: GameState = GameState.Idle;
    private players: Map<number, Player> = new Map();
    private turnOrder: number[] = [];
    private currentTurnIndex: number = 0;
    private currentDiceMax: number = STARTING_DICE_MAX;
    private countdownTimer: NodeJS.Timeout | null = null;
    private turnTimer: NodeJS.Timeout | null = null;
    private lockDurationMinutes: number = DEFAULT_LOCK_MINUTES;
    private roomMembers: Set<number> = new Set();
    private nameCache: Map<number, string> = new Map();
    private pronounsCache: Map<number, string> = new Map();
    private lastClothing: Map<number, string[]> = new Map();
    private gamePassword: string = "";
    private safewordMember: number | null = null;
    private allowMidGameJoin: boolean = true;
    private bondagePhaseStarted: boolean = false; // True once the first bondage outfit is assigned this game
    private pendingLockConfirmations: Map<number, { name: string; items: string[] }> = new Map();
    private pendingLockVerifications: Map<number, PendingLockVerification> = new Map();
    private pendingJoinConfirmations: Map<number, number> = new Map();
    private pendingLateJoinConfirmations: Map<number, NodeJS.Timeout> = new Map();
    private itemStateCache: Map<string, any> = new Map();
    private lockPermissionWarned: Set<number> = new Set();
    private feedbackStatus: Record<string, FeedbackStatusEntry> = {};
    private feedbackNotified: Set<number> = new Set();
    private readonly feedbackStatusPath = path.join(__dirname, "..", "feedback_status.json");
    private playerRecords: Record<string, PlayerRecord> = {};
    private readonly playerRecordsPath = path.join(__dirname, "..", "players.json");
    private feedbackMemberNumbers: Set<number> = new Set();
    private readonly outfitSuggestionsPath = path.join(__dirname, "..", "outfit_suggestions.json");
    private soloGames: Map<number, SoloGameState> = new Map();
    private pendingSoloSetup: Map<number, { mode: SoloMode; name: string; clothingQuestionIndex: number; pendingClothing: string[] }> = new Map();
    private readonly soloRecordsPath = path.join(__dirname, "..", "solo_records.json");
    private readonly gameLogPath = path.join(__dirname, "..", "game_log.json");
    private readonly botStatePath = path.join(__dirname, "..", "bot_state.json");
    private activeMultiplayer: boolean = false;
    private gameStartTime: string | null = null;
    private gameEndLogged: boolean = false;
    private reconnectPending: boolean = false;
    private gameCooldownUntil: number = 0;

    constructor(bot: BCConnection) {
        this.bot = bot;
        this.loadFeedbackStatus();
        this.feedbackMemberNumbers = this.loadFeedbackMemberNumbers();
        this.loadPlayerRecords();
        this.pruneGameLog();
    }

    // ============================================================
    // PUBLIC - room events
    // ============================================================

    public onMemberJoin(memberNumber: number, name: string, character?: any): void {
        this.roomMembers.add(memberNumber);
        this.nameCache.set(memberNumber, name);
        const pronouns = extractPronouns(character);
        if (pronouns) this.pronounsCache.set(memberNumber, pronouns);
        if (memberNumber === this.bot.getMemberNumber()) return;

        const player = this.players.get(memberNumber);
        if (player?.pendingReturn) {
            player.pendingReturn = false;
            player.leaveRoundsRemaining = 0;
            player.name = name;
            this.bot.sendChat(`${name} is back! They've been added back to the turn order.`);
            return;
        }

        this.recordPlayerSeen(memberNumber, name);
        this.sendWelcomeWhisper(memberNumber, name);
        this.notifyFeedbackStatus(memberNumber, name);
    }

    public onMemberLeave(memberNumber: number): void {
        this.roomMembers.delete(memberNumber);
        this.cleanupSoloOnLeave(memberNumber);
        if (this.state === GameState.Idle || !this.players.has(memberNumber)) return;

        const player = this.players.get(memberNumber)!;
        const activeGameplay = this.state === GameState.Rolling ||
            this.state === GameState.WaitingRemove ||
            this.state === GameState.WaitingBondage;

        if (activeGameplay) {
            player.pendingReturn = true;
            player.leaveRoundsRemaining = 2;
            player.timeoutWarned = false;
            player.timeoutCount = 0;
            this.bot.sendChat(`${player.name} has left the room — they have 2 rounds to return before being removed from the game.`);

            const wasCurrentTurn = this.getCurrentPlayer()?.memberNumber === memberNumber;
            if (wasCurrentTurn) {
                this.clearTurnTimer();
                this.currentDiceMax = STARTING_DICE_MAX;
                this.advanceTurn();
            }
            return;
        }

        // Not mid-turn (e.g. still in registration/countdown) - remove immediately.
        this.bot.sendChat(`${player.name} has left the room and been removed from the game.`);
        this.players.delete(memberNumber);
        this.turnOrder = this.turnOrder.filter(n => n !== memberNumber);

        if (this.players.size === 0) {
            this.bot.sendChat(`No players remaining. Resetting.`);
            this.resetGame();
        }
    }

    public onRoomSync(characters: any[]): void {
        this.roomMembers.clear();
        for (const char of characters) {
            if (char.MemberNumber !== undefined) {
                this.roomMembers.add(char.MemberNumber);
                const name = char.Nickname || char.Name;
                if (name) this.nameCache.set(char.MemberNumber, name);
                const pronouns = extractPronouns(char);
                if (pronouns) this.pronounsCache.set(char.MemberNumber, pronouns);
            }
        }

        if (this.reconnectPending) {
            this.reconnectPending = false;
            this.reconcileAfterReconnect();
        }
    }

    // Called once the underlying connection has reconnected. Defers the
    // actual reconciliation until the next room sync confirms who's
    // actually present.
    public onReconnect(): void {
        this.reconnectPending = true;
    }

    // Runs once after a post-reconnect room sync. Anyone in the active game
    // who isn't in the room is treated like they left - placed into (or kept
    // in, without resetting their counter) their grace period - so the game
    // doesn't silently proceed as though they're still present.
    private reconcileAfterReconnect(): void {
        if (this.state === GameState.Idle || this.players.size === 0) return;

        const currentMemberNumber = this.getCurrentPlayer()?.memberNumber;
        let currentPlayerNewlyAbsent = false;

        for (const [memberNumber, player] of this.players) {
            if (this.roomMembers.has(memberNumber)) continue;
            if (player.pendingReturn) continue; // already in grace - leave counter as-is

            player.pendingReturn = true;
            player.leaveRoundsRemaining = 2;
            player.timeoutWarned = false;
            player.timeoutCount = 0;
            this.bot.sendChat(`${player.name} was not found in the room after reconnect — they have 2 rounds to return.`);

            if (memberNumber === currentMemberNumber) currentPlayerNewlyAbsent = true;
        }

        const activeGameplay = this.state === GameState.Rolling ||
            this.state === GameState.WaitingRemove ||
            this.state === GameState.WaitingBondage;

        if (currentPlayerNewlyAbsent && activeGameplay) {
            this.clearTurnTimer();
            this.currentDiceMax = STARTING_DICE_MAX;
            this.advanceTurn();
        }
    }

    public onItemChange(data: any): void {
        const target = data?.Target;
        const item = data?.Item;
        if (typeof target !== "number" || !item?.Group) return;
        this.itemStateCache.set(`${target}:${item.Group}`, item);
    }

    // ============================================================
    // PUBLIC - command handlers
    // ============================================================

    // Commands shared by handleWhisper and handleChat (plus a few that are
    // restricted to one source via whisperOnly/chatOnly). Order matters for
    // prefix entries: more specific matches (e.g. "!feedback list") must
    // come before broader prefixes (e.g. "!feedback ").
    private readonly commandTable: Record<string, CommandDef> = {
        "!roll": { handler: (mn, name) => this.handleRoll(mn, name) },
        "!join": { handler: (mn, name) => this.handleJoin(mn, name) },
        "!start": { handler: (mn) => this.handleStart(mn) },
        "!cancel": { handler: (mn) => this.handleCancel(mn) },
        "!wearing": { handler: (mn) => this.startGuidedClothing(mn), whisperOnly: true },
        "!wearing ": { handler: (mn, _name, _msg, message) => this.handleWearing(mn, message), whisperOnly: true, prefix: true },
        "!naked": { handler: (mn) => this.handleNoWearing(mn) },
        "!same": { handler: (mn) => this.handleSame(mn) },
        "!ready": { handler: (mn) => this.handleReady(mn) },
        "!locktime ": { handler: (mn, _name, _msg, message) => this.handleLockTime(mn, message), whisperOnly: true, prefix: true },
        "!lock10": { handler: (mn, name, msg) => this.handleLockPreset(mn, name, msg) },
        "!lock15": { handler: (mn, name, msg) => this.handleLockPreset(mn, name, msg) },
        "!lock20": { handler: (mn, name, msg) => this.handleLockPreset(mn, name, msg) },
        "!midgamejoin ": { handler: (mn, _name, _msg, message) => this.handleMidGameJoinToggle(mn, message), whisperOnly: true, prefix: true },
        "!testoutfit ": { handler: (mn, _name, _msg, message) => this.handleTestOutfit(mn, message), whisperOnly: true, prefix: true },
        "!setstatus ": { handler: (mn, _name, _msg, message) => this.handleSetStatus(mn, message), whisperOnly: true, prefix: true },
        "!free ": { handler: (mn, _name, _msg, message) => this.handleFree(mn, message), whisperOnly: true, prefix: true },
        "!kick ": { handler: (mn, _name, _msg, message) => this.handleKick(mn, message), whisperOnly: true, prefix: true },
        "!feedback list": { handler: (mn) => this.handleFeedbackList(mn), whisperOnly: true },
        "!outfit ": { handler: (mn, name, _msg, message) => this.handleOutfitSubmission(mn, name, message), prefix: true },
        "!outfits": { handler: (mn) => this.handleOutfitsList(mn), whisperOnly: true },
        "!safeword": { handler: (mn, name) => this.handleSafeword(mn, name), whisperOnly: true },
        "!reset": { handler: (mn) => this.handleReset(mn), whisperOnly: true },
        "!released": { handler: (mn) => this.handleLockReleaseConfirmation(mn, true) },
        "!stuck": { handler: (mn) => this.handleLockReleaseConfirmation(mn, false) },
        "!yes": { handler: (mn) => this.handleLockVerificationYes(mn) },
        "!no": { handler: (mn) => this.handleLockVerificationNo(mn) },
        "!help player": { handler: (mn) => this.handleHelpPlayer(mn) },
        "!help solo": { handler: (mn) => this.handleHelpSolo(mn) },
        "!help admin": { handler: (mn) => this.handleHelpAdmin(mn) },
        "!help": { handler: (mn) => this.handleHelp(mn) },
        "!about": { handler: (mn) => this.handleAbout(mn) },
        "!solo race": { handler: (mn, name) => this.handleSoloStart(mn, name, "race"), whisperOnly: true },
        "!solo survive": { handler: (mn, name) => this.handleSoloStart(mn, name, "survive"), whisperOnly: true },
        "!solo": { handler: (mn) => this.bot.whisper(mn, "Usage: !solo race or !solo survive"), whisperOnly: true },
        "!solo_reset ": { handler: (mn, _name, _msg, message) => this.handleSoloReset(mn, message), whisperOnly: true, prefix: true },
        "!solo_reset": { handler: (mn) => this.handleSoloReset(mn, ""), whisperOnly: true },
        "!scores me": { handler: (mn) => this.handleScoresMe(mn) },
        "!scores race": { handler: (mn) => this.handleScores(mn, "race") },
        "!scores survive": { handler: (mn) => this.handleScores(mn, "survive") },
        "!scores": { handler: (mn) => this.handleScores(mn) },
        "!leaderboard": { handler: (mn) => this.handleLeaderboard(mn) },
        "!lb": { handler: (mn) => this.handleLeaderboard(mn) },
        "!feedback ": { handler: (mn, name, _msg, message) => this.handleFeedback(mn, name, message), whisperOnly: true, prefix: true },
        "!removed": { handler: (mn, name) => this.handleRemoved(mn, name), chatOnly: true },
        "!continue": { handler: (mn) => this.handleContinue(mn), chatOnly: true },
    };

    private dispatchCommand(memberNumber: number, name: string, message: string, msg: string, source: "whisper" | "chat"): void {
        for (const [command, def] of Object.entries(this.commandTable)) {
            const matches = def.prefix ? msg.startsWith(command) : msg === command;
            if (!matches) continue;
            if (def.whisperOnly && source !== "whisper") continue;
            if (def.chatOnly && source !== "chat") continue;
            def.handler(memberNumber, name, msg, message);
            return;
        }
    }

    public handleWhisper(memberNumber: number, name: string, message: string): void {
        const msg = message.trim().toLowerCase();

        // Guided clothing Q&A takes priority over other commands while active
        const player = this.players.get(memberNumber);
        if (player && player.clothingQuestionIndex !== null && (msg === "yes" || msg === "y" || msg === "no" || msg === "n")) {
            this.handleGuidedAnswer(memberNumber, msg);
            return;
        }

        // Solo game setup: guided clothing Q&A (yes/no), same as !wearing
        if (this.pendingSoloSetup.has(memberNumber) && (msg === "yes" || msg === "y" || msg === "no" || msg === "n")) {
            this.handleSoloClothingAnswer(memberNumber, msg);
            return;
        }

        // Solo game roll takes priority over the multiplayer !roll while active,
        // so it never interferes with multiplayer turn order.
        if (msg === "!roll" && this.soloGames.has(memberNumber)) {
            this.handleSoloRoll(memberNumber);
            return;
        }

        // Solo item-removal confirmation, while waiting on it. Only intercepts
        // when the solo game is actually pausing for it, so multiplayer's
        // !removed (chatOnly) keeps working for players also in solo.
        if (msg === "!removed" && this.soloGames.get(memberNumber)?.awaitingRemoval) {
            this.handleSoloRemoved(memberNumber);
            return;
        }

        this.dispatchCommand(memberNumber, name, message, msg, "whisper");
    }

    public handleChat(memberNumber: number, name: string, message: string): void {
        const msg = message.trim().toLowerCase();

        // Solo game roll takes priority over the multiplayer !roll while active,
        // so a roll typed in room chat (instead of whispered) still counts and
        // doesn't get silently swallowed by the multiplayer roll handler.
        if (msg === "!roll" && this.soloGames.has(memberNumber)) {
            this.handleSoloRoll(memberNumber);
            return;
        }

        // Solo item-removal confirmation, while waiting on it (see handleWhisper).
        if (msg === "!removed" && this.soloGames.get(memberNumber)?.awaitingRemoval) {
            this.handleSoloRemoved(memberNumber);
            return;
        }

        this.dispatchCommand(memberNumber, name, message, msg, "chat");
    }

    // ============================================================
    // COMMAND HANDLERS
    // ============================================================

    private handleJoin(memberNumber: number, name: string): void {
        if (this.state === GameState.Idle && Date.now() < this.gameCooldownUntil) {
            const remainingMin = Math.ceil((this.gameCooldownUntil - Date.now()) / 60000);
            this.bot.whisper(memberNumber,
                `⏳ We just wrapped up a game — give everyone a few minutes to confirm their locks released properly before the next one starts. Try !join again in about ${remainingMin} minute${remainingMin === 1 ? "" : "s"}.`
            );
            return;
        }
        if (this.state === GameState.Idle && this.checkPendingUpdate()) {
            return;
        }
        if (this.bondagePhaseStarted) {
            this.handleLateJoin(memberNumber, name);
            return;
        }

        const gameInProgress = this.state !== GameState.Idle && this.state !== GameState.Registration && this.state !== GameState.Countdown;
        const midGame = this.state === GameState.Rolling || this.state === GameState.WaitingRemove || this.state === GameState.WaitingBondage;

        if (gameInProgress && (!this.allowMidGameJoin || !midGame)) {
            this.bot.whisper(memberNumber, "Sorry, a game is already in progress. Wait for the next round!");
            return;
        }
        if (this.players.has(memberNumber)) {
            this.bot.whisper(memberNumber, "You've already joined! Whisper !wearing followed by your items, or !naked if you have nothing on.");
            return;
        }

        const pendingSince = this.pendingJoinConfirmations.get(memberNumber);
        if (pendingSince === undefined || Date.now() - pendingSince > JOIN_CONFIRMATION_WINDOW_MS) {
            this.pendingJoinConfirmations.set(memberNumber, Date.now());
            this.bot.whisper(memberNumber,
                `Current lock duration is ${this.lockDurationMinutes} minutes. Type !join again to confirm you agree to these stakes.`
            );
            return;
        }
        this.pendingJoinConfirmations.delete(memberNumber);

        const player: Player = {
            memberNumber,
            name,
            clothing: [],
            clothingRemoved: 0,
            bondageApplied: 0,
            isNaked: false,
            isFullyBound: false,
            timeoutWarned: false,
            timeoutCount: 0,
            ready: false,
            midGameJoin: midGame,
            clothingQuestionIndex: null,
            pendingClothing: [],
            bondageOutfit: null,
            pendingReturn: false,
            leaveRoundsRemaining: 0,
            freePass: false,
            pendingPenaltySteps: 0,
        };
        this.players.set(memberNumber, player);

        if (midGame) {
            this.bot.sendChat(`${name} is joining mid-game! They'll enter the turn rotation once ready.`);
        } else {
            const isFirstJoin = this.players.size === 1;
            this.state = GameState.Registration;
            this.bot.sendChat(`${name} has joined the game! (${this.players.size} player${this.players.size > 1 ? "s" : ""} ready)`);
            if (isFirstJoin) {
                this.gameStartTime = new Date().toISOString();
                this.gameEndLogged = false;
                this.bot.sendChat(
                    `Lock duration: type !lock10, !lock15, or !lock20 to set the timer. ` +
                    `Default is ${DEFAULT_LOCK_MINUTES} minutes — game starts in 30 seconds with the current setting.`
                );
            }
        }

        const last = this.lastClothing.get(memberNumber);
        if (last && last.length > 0) {
            this.bot.whisper(memberNumber,
                `Welcome back to Strip Dice! 🎲\n` +
                `Last time you wore: ${last.join(", ")}\n` +
                `Whisper !same to use the same outfit, or:\n` +
                `!wearing - go through your outfit one item at a time (yes/no)\n` +
                `!wearing [items] to declare a new outfit directly\n` +
                `!naked if you have nothing on\n` +
                `Then whisper !ready when done.`
            );
        } else {
            this.bot.whisper(memberNumber,
                `Welcome to Strip Dice! 🎲\n` +
                `Whisper !wearing and I'll ask about your outfit one item at a time (yes/no).\n` +
                `Or declare it all at once:\n` +
                `!wearing shoes socks top bottom bra panties\n` +
                `(only include items you actually have on)\n` +
                `Examples:\n` +
                `  !wearing shoes socks top bottom panties\n` +
                `  !wearing shoes top bottom (no socks, no underwear)\n` +
                `  !wearing shoes socks top bottom bra panties\n` +
                `Or whisper !naked if you have nothing on.\n` +
                `Whisper !ready when done.`
            );
        }

        if (!midGame) this.checkAllJoined();
    }

    // Handles !join attempts after bondage penalties have already started for this game.
    // Players can join naked via the same double-confirm pattern as a normal !join,
    // skipping clothing declaration and going straight to bondage on their first loss.
    private handleLateJoin(memberNumber: number, name: string): void {
        if (this.players.has(memberNumber)) {
            this.bot.whisper(memberNumber, "You've already joined! Whisper !wearing followed by your items, or !naked if you have nothing on.");
            return;
        }

        const pendingTimer = this.pendingLateJoinConfirmations.get(memberNumber);
        if (!pendingTimer) {
            const timer = setTimeout(() => {
                this.pendingLateJoinConfirmations.delete(memberNumber);
                this.bot.whisper(memberNumber, "Join cancelled.");
            }, JOIN_CONFIRMATION_WINDOW_MS);
            this.pendingLateJoinConfirmations.set(memberNumber, timer);
            this.bot.whisper(memberNumber,
                "The game has already started. You can join naked (no starting clothes, straight to bondage penalties) — type !join again to confirm."
            );
            return;
        }

        clearTimeout(pendingTimer);
        this.pendingLateJoinConfirmations.delete(memberNumber);

        const player: Player = {
            memberNumber,
            name,
            clothing: [],
            clothingRemoved: 0,
            bondageApplied: 0,
            isNaked: true,
            isFullyBound: false,
            timeoutWarned: false,
            timeoutCount: 0,
            ready: true,
            midGameJoin: false,
            clothingQuestionIndex: null,
            pendingClothing: [],
            bondageOutfit: null,
            pendingReturn: false,
            leaveRoundsRemaining: 0,
            freePass: false,
            pendingPenaltySteps: 0,
        };
        this.players.set(memberNumber, player);
        this.turnOrder.push(memberNumber);

        this.bot.sendChat(`${name} has joined the game naked — brave!`);
    }

    private handleStart(memberNumber: number): void {
        if (this.state !== GameState.Registration && this.state !== GameState.Countdown) {
            this.bot.whisper(memberNumber, "No game is waiting to start.");
            return;
        }
        if (this.players.size === 0) {
            this.bot.whisper(memberNumber, "No players have joined yet!");
            return;
        }
        this.bot.sendChat(`${this.getPlayerName(memberNumber)} is starting the game early!`);
        this.clearCountdown();
        this.beginClothingDeclaration();
    }

    private handleCancel(memberNumber: number): void {
        if (this.state !== GameState.Countdown) {
            this.bot.whisper(memberNumber, "No countdown is currently running.");
            return;
        }
        this.clearCountdown();
        this.state = GameState.Registration;
        this.bot.sendChat(`Countdown cancelled by ${this.getPlayerName(memberNumber)}. Waiting for more players. Whisper !start when ready.`);
    }

    private handleWearing(memberNumber: number, message: string): void {
        const player = this.requirePlayer(memberNumber);
        if (!player) return;

        const parts = message.trim().toLowerCase().split(/\s+/).slice(1);
        const declared: string[] = [];

        for (const part of parts) {
            const normalized = CLOTHING_ALIASES[part] ?? part;
            if (CLOTHING_SLOTS.includes(normalized) && !declared.includes(normalized)) {
                declared.push(normalized);
            }
        }

        if (declared.length === 0) {
            this.bot.whisper(memberNumber, `No valid items found. Valid items are: ${CLOTHING_SLOTS.join(", ")}`);
            return;
        }

        // Sort by game order
        player.clothing = CLOTHING_SLOTS.filter(slot => declared.includes(slot));
        player.isNaked = false;
        player.ready = false;
        player.clothingQuestionIndex = null;
        this.bot.whisper(memberNumber,
            `Got it! Your clothing list in order: ${player.clothing.join(", ")}.\n` +
            `Whisper !ready when done, or !wearing again to change.`
        );
    }

    private startGuidedClothing(memberNumber: number): void {
        const player = this.requirePlayer(memberNumber);
        if (!player) return;
        player.clothingQuestionIndex = 0;
        player.pendingClothing = [];
        player.ready = false;
        this.bot.whisper(memberNumber, "Let's go through your outfit one item at a time. Answer yes or no.");
        this.askClothingQuestion(memberNumber);
    }

    private askClothingQuestion(memberNumber: number): void {
        const player = this.players.get(memberNumber)!;
        const idx = player.clothingQuestionIndex!;

        if (idx >= CLOTHING_SLOTS.length) {
            player.clothing = CLOTHING_SLOTS.filter(slot => player.pendingClothing.includes(slot));
            player.isNaked = player.clothing.length === 0;
            player.clothingQuestionIndex = null;
            if (player.clothing.length > 0) {
                this.bot.whisper(memberNumber,
                    `Got it! Your clothing list: ${player.clothing.join(", ")}.\n` +
                    `Whisper !ready when done, or !wearing to redo this.`
                );
            } else {
                this.bot.whisper(memberNumber, "Got it — you're starting naked! !ready when done.");
            }
            return;
        }

        this.bot.whisper(memberNumber, `Do you have ${CLOTHING_SLOTS[idx]} on? (yes/no)`);
    }

    private handleGuidedAnswer(memberNumber: number, msg: string): void {
        const player = this.players.get(memberNumber)!;
        const idx = player.clothingQuestionIndex!;
        const item = CLOTHING_SLOTS[idx];

        if (msg === "yes" || msg === "y") {
            player.pendingClothing.push(item);
        }

        player.clothingQuestionIndex = idx + 1;
        this.askClothingQuestion(memberNumber);
    }

    private handleSame(memberNumber: number): void {
        const player = this.requirePlayer(memberNumber);
        if (!player) return;
        const last = this.lastClothing.get(memberNumber);
        if (!last || last.length === 0) {
            this.bot.whisper(memberNumber, "No previous outfit on record. Please use !wearing to declare your clothing.");
            return;
        }
        player.clothing = [...last];
        player.isNaked = false;
        player.ready = false;
        player.clothingQuestionIndex = null;
        this.bot.whisper(memberNumber,
            `Using your last outfit: ${player.clothing.join(", ")}.\n` +
            `Whisper !ready when done, or !wearing to change.`
        );
    }

    private handleNoWearing(memberNumber: number): void {
        const player = this.requirePlayer(memberNumber);
        if (!player) return;
        player.clothing = [];
        player.isNaked = true;
        player.ready = false;
        player.clothingQuestionIndex = null;
        this.bot.whisper(memberNumber, "Got it — you're starting naked! Bondage applies directly on your next loss. !ready when done.");
    }

    private handleReady(memberNumber: number): void {
        const player = this.requirePlayer(memberNumber);
        if (!player) return;

        if (player.clothing.length === 0 && !player.isNaked) {
            this.bot.whisper(memberNumber, "Please declare your clothing first with !wearing or !naked.");
            return;
        }

        player.ready = true;
        if (player.clothing.length > 0) {
            this.lastClothing.set(memberNumber, [...player.clothing]);
        }

        if (player.midGameJoin) {
            player.midGameJoin = false;
            this.turnOrder.push(memberNumber);
            this.bot.whisper(memberNumber, "You're ready! You've been added to the turn rotation.");
            this.bot.sendChat(`${player.name} has joined the game and entered the turn rotation!`);
            return;
        }

        this.bot.whisper(memberNumber, "You're ready! Waiting for other players...");
        this.bot.sendChat(`${player.name} is ready!`);
        this.checkAllReady();
    }

    private isAdmin(memberNumber: number): boolean {
        return memberNumber === 208543 || memberNumber === this.bot.getMemberNumber();
    }

    // Looks up a player, whispering the standard "not joined" message and
    // returning null if they haven't joined the current game.
    private requirePlayer(memberNumber: number): Player | null {
        const player = this.players.get(memberNumber);
        if (!player) {
            this.bot.whisper(memberNumber, "You haven't joined the game yet! Whisper !join first.");
            return null;
        }
        return player;
    }

    // Whispers the standard "admin only" message and returns false if the
    // given member is not the game admin.
    private requireAdmin(memberNumber: number): boolean {
        if (!this.isAdmin(memberNumber)) {
            this.bot.whisper(memberNumber, "Only the game admin can use this command.");
            return false;
        }
        return true;
    }

    private handleLockTime(memberNumber: number, message: string): void {
        if (!this.isAdmin(memberNumber)) {
            this.bot.whisper(memberNumber, "Only the game admin can set the lock duration.");
            return;
        }
        const parts = message.trim().split(/\s+/);
        const minutes = parseInt(parts[1]);
        if (isNaN(minutes) || minutes < 1 || minutes > 720) {
            this.bot.whisper(memberNumber, "Invalid lock time. Use !locktime [minutes] (1-720).");
            return;
        }
        this.lockDurationMinutes = minutes;
        this.bot.whisper(memberNumber, `Lock duration set to ${minutes} minutes.`);
        this.bot.sendChat(`🔒 End game locks will be set to ${minutes} minutes.`);
    }

    private handleLockPreset(memberNumber: number, name: string, msg: string): void {
        if (this.state === GameState.Rolling || this.state === GameState.WaitingRemove ||
            this.state === GameState.WaitingBondage || this.state === GameState.SafewordPause ||
            this.state === GameState.GameOver) {
            this.bot.whisper(memberNumber, "The game has already started — lock duration is locked in.");
            return;
        }
        const minutes = parseInt(msg.replace("!lock", ""), 10);
        this.lockDurationMinutes = minutes;
        this.bot.sendChat(`🔒 ${name} set the lock duration to ${minutes} minutes.`);
    }

    private handleMidGameJoinToggle(memberNumber: number, message: string): void {
        if (!this.isAdmin(memberNumber)) {
            this.bot.whisper(memberNumber, "Only the game admin can change this setting.");
            return;
        }
        const setting = message.trim().toLowerCase().split(/\s+/)[1];
        if (setting !== "on" && setting !== "off") {
            this.bot.whisper(memberNumber, "Invalid option. Use !midgamejoin on or !midgamejoin off.");
            return;
        }
        this.allowMidGameJoin = setting === "on";
        this.bot.whisper(memberNumber, `Mid-game joining is now ${this.allowMidGameJoin ? "ENABLED" : "DISABLED"}.`);
        this.bot.sendChat(`ℹ️ Mid-game joining has been turned ${this.allowMidGameJoin ? "ON" : "OFF"} by the admin.`);
    }

    private handleReset(memberNumber: number): void {
        if (!this.requireAdmin(memberNumber)) return;
        if (this.state === GameState.Idle && this.players.size === 0) {
            this.bot.whisper(memberNumber, "No game is currently running.");
            return;
        }

        this.clearCountdown();
        this.clearTurnTimer();

        let removalDelay = 0;
        for (const player of this.players.values()) {
            this.removeAllItems(player.memberNumber, removalDelay);
            removalDelay += REMOVAL_SLOTS.length * REMOVAL_SLOT_DELAY_MS;
        }

        this.bot.sendChat(`🛑 The game has been reset by an admin.`);
        this.resetGame();
    }

    private handleTestOutfit(memberNumber: number, message: string): void {
        if (!this.requireAdmin(memberNumber)) return;
        const player = this.requirePlayer(memberNumber);
        if (!player) return;
        const requested = message.trim().slice("!testoutfit ".length).trim();
        const outfit = BONDAGE_OUTFITS.find(o => o.name.toLowerCase() === requested.toLowerCase());
        if (!outfit) {
            const names = BONDAGE_OUTFITS.map(o => o.name).join(", ");
            this.bot.whisper(memberNumber, `Unknown outfit "${requested}". Available outfits: ${names}`);
            return;
        }
        player.bondageOutfit = outfit;
        player.bondageApplied = 0;
        this.bot.whisper(memberNumber, `Your next bondage outfit has been forced to: ${outfit.name}`);
    }

    private handleFree(memberNumber: number, message: string): void {
        if (!this.requireAdmin(memberNumber)) return;

        const requested = message.trim().slice("!free ".length).trim();
        if (!requested) {
            this.bot.whisper(memberNumber, "Usage: !free [player name]");
            return;
        }

        const target = [...this.players.values()].find(p => p.name.toLowerCase().includes(requested.toLowerCase()));
        if (!target) {
            this.bot.whisper(memberNumber, `No player found matching "${requested}".`);
            return;
        }

        this.removeAllItemsSafeword(target.memberNumber, target.name, memberNumber);

        const wasFullyBound = target.isFullyBound;
        target.bondageApplied = 0;
        target.isFullyBound = false;
        target.bondageOutfit = null;

        if (wasFullyBound && !this.turnOrder.includes(target.memberNumber)) {
            this.turnOrder.push(target.memberNumber);
        }

        this.bot.sendChat(`Admin has freed ${target.name} from their restraints.`);
    }

    // Admin-only: removes a player from the active game. The player keeps any
    // bondage they're currently wearing — this is a moderation/removal tool,
    // not a safeword.
    private handleKick(memberNumber: number, message: string): void {
        if (!this.requireAdmin(memberNumber)) return;

        if (!this.activeMultiplayer) {
            this.bot.whisper(memberNumber, "No active game to kick a player from.");
            return;
        }

        const requested = message.trim().slice("!kick ".length).trim();
        if (!requested) {
            this.bot.whisper(memberNumber, "Usage: !kick [player name]");
            return;
        }

        const target = [...this.players.values()].find(p => p.name.toLowerCase().includes(requested.toLowerCase()));
        if (!target) {
            this.bot.whisper(memberNumber, `${requested} not found in the current game.`);
            return;
        }

        const wasCurrentTurn = this.getCurrentPlayer()?.memberNumber === target.memberNumber;

        this.clearTurnTimer();
        const removedIndex = this.turnOrder.indexOf(target.memberNumber);
        this.players.delete(target.memberNumber);
        this.turnOrder = this.turnOrder.filter(n => n !== target.memberNumber);

        this.bot.sendChat(`👮 An admin removed ${target.name} from the game.`);

        if (this.players.size === 0) {
            this.bot.sendChat(`No players remaining. Resetting.`);
            this.resetGame();
            return;
        }

        if (removedIndex !== -1 && removedIndex < this.currentTurnIndex) {
            this.currentTurnIndex--;
        }
        if (this.currentTurnIndex >= this.turnOrder.length) {
            this.currentTurnIndex = 0;
        }

        if (this.checkGameEndCondition()) return;

        if (this.players.size === 1) {
            const winner = [...this.players.values()][0];
            this.bot.sendChat(`🏆 ${winner.name} wins! Not enough players remain to continue.`);
            this.recordGameCompletion(winner.memberNumber);
            this.logMultiplayerGameEnd("win", { winner: winner.name });
            this.applyEndGameLocks(winner);
            return;
        }

        if (wasCurrentTurn) {
            this.currentDiceMax = STARTING_DICE_MAX;
            this.resolveCurrentTurn();
        }
    }

    private handleSetStatus(memberNumber: number, message: string): void {
        if (!this.requireAdmin(memberNumber)) return;
        const parts = message.trim().split(/\s+/);
        const playerId = parts[1];
        const status = (parts[2] ?? "").toLowerCase() as FeedbackItemStatus;
        const validStatuses: FeedbackItemStatus[] = ["reviewing", "testing", "researching", "implemented", "partly_implemented"];

        if (!playerId || !/^\d+$/.test(playerId)) {
            this.bot.whisper(memberNumber, "Usage: !setstatus [playerID] [status]");
            return;
        }
        if (!validStatuses.includes(status)) {
            this.bot.whisper(memberNumber, `Invalid status. Valid statuses: ${validStatuses.join(", ")}`);
            return;
        }

        const entry = this.feedbackStatus[playerId];
        if (!entry || entry.items.length === 0) {
            this.bot.whisper(memberNumber, `No feedback found for player #${playerId}.`);
            return;
        }

        for (const item of entry.items) {
            item.status = status;
            item.statusShown = false;
        }
        this.saveFeedbackStatus();
        this.bot.whisper(memberNumber, `Updated ${entry.items.length} feedback item(s) for ${entry.name} (#${playerId}) to "${status}".`);
    }

    private handleSafeword(memberNumber: number, name: string): void {
        this.bot.sendChat(`🔴 SAFEWORD - ${name} has called safeword! Removing all restraints...`);
        this.bot.whisper(memberNumber, "Safeword acknowledged. Removing all restraints now.");
        this.removeAllItemsSafeword(memberNumber, name, memberNumber);

        const player = this.players.get(memberNumber);
        if (!player || this.state === GameState.Idle || this.state === GameState.Registration) return;

        // Reset player state
        player.bondageApplied = 0;
        player.isNaked = false;
        player.isFullyBound = false;
        player.bondageOutfit = null;

        this.clearTurnTimer();
        this.safewordMember = memberNumber;
        this.state = GameState.SafewordPause;

        const others = [...this.players.values()].filter(p => p.memberNumber !== memberNumber);
        if (others.length === 0) {
            this.bot.sendChat(`Game ended. Type !join to start a new game.`);
            this.resetGame();
            return;
        }

        this.bot.sendChat(`Should the game continue without ${name}? Type !continue in chat within 60 seconds, otherwise the game will end.`);
        this.turnTimer = setTimeout(() => {
            if (this.state === GameState.SafewordPause) {
                this.bot.sendChat(`No response — ending the game.`);
                this.resetGame();
            }
        }, 60000);
    }

    private handleContinue(memberNumber: number): void {
        if (this.state !== GameState.SafewordPause) return;
        if (!this.players.has(memberNumber)) return;

        const safeworded = this.safewordMember;
        this.safewordMember = null;
        this.clearTurnTimer();

        if (safeworded !== null) {
            const player = this.players.get(safeworded);
            if (player) {
                this.bot.sendChat(`${player.name} has been removed from the game. Continuing...`);
            }
            this.players.delete(safeworded);
            this.turnOrder = this.turnOrder.filter(n => n !== safeworded);
        }

        if (this.players.size === 0) {
            this.bot.sendChat(`No players remaining. Resetting.`);
            this.resetGame();
            return;
        }

        this.currentDiceMax = STARTING_DICE_MAX;
        // Make sure currentTurnIndex is still valid
        if (this.currentTurnIndex >= this.turnOrder.length) {
            this.currentTurnIndex = 0;
        }
        this.resolveCurrentTurn();
    }

    private handleAbout(memberNumber: number): void {
        this.bot.whisper(memberNumber,
            `=== About StripDiceBot ===\n` +
            `Created and owned by Missy 💕\n` +
            `Source code & updates: https://github.com/Dwfreegethub/StripDiceBot\n` +
            `\n` +
            `⚠️ Currently in early beta — expect bugs and improvements!\n` +
            `Have a suggestion? Whisper !feedback [your thoughts]`
        );
    }

    private handleFeedback(memberNumber: number, name: string, message: string): void {
        const text = message.trim().slice("!feedback ".length).trim();
        if (!text) {
            this.bot.whisper(memberNumber, "Please include your feedback! e.g. !feedback The game was great but...");
            return;
        }
        const timestamp = centralTimestamp();
        const line = `[${timestamp}] ${name} (#${memberNumber}): ${text}\n`;
        const filePath = path.join(__dirname, "..", "feedback.log");
        try {
            fs.appendFileSync(filePath, line, "utf8");
        } catch (err) {
            log("ERROR: Failed to write feedback.log: " + err);
        }
        log(`Feedback from ${name}: ${text}`);
        this.feedbackMemberNumbers.add(memberNumber);

        const key = String(memberNumber);
        const entry = this.feedbackStatus[key] ?? { name, items: [] };
        entry.name = name;
        entry.items.push({ timestamp, text, status: "reviewing" });
        this.feedbackStatus[key] = entry;
        this.saveFeedbackStatus();

        const playerRecord = this.playerRecords[key];
        if (playerRecord && !playerRecord.feedbackGiven) {
            playerRecord.feedbackGiven = true;
            this.savePlayerRecords();
        }

        this.bot.whisper(memberNumber, "Thank you for your feedback! 💬 We read everything and really appreciate it.");
    }

    private handleOutfitSubmission(memberNumber: number, name: string, message: string): void {
        const description = message.trim().slice("!outfit ".length).trim();
        if (!description) {
            this.bot.whisper(memberNumber, "Please describe the outfit! e.g. !outfit Pink leotard with matching gloves");
            return;
        }

        const suggestions = this.loadOutfitSuggestions();
        suggestions.push({
            memberNumber,
            name,
            description,
            timestamp: centralTimestamp(),
        });

        try {
            fs.writeFileSync(this.outfitSuggestionsPath, JSON.stringify(suggestions, null, 2), "utf8");
        } catch (err) {
            log("ERROR: Failed to write outfit_suggestions.json: " + err);
        }

        log(`Outfit submission from ${name}: ${description}`);
        this.bot.whisper(memberNumber, "Outfit submitted! It may appear as a penalty in a future game.");
    }

    private loadOutfitSuggestions(): OutfitSuggestion[] {
        try {
            const raw = fs.readFileSync(this.outfitSuggestionsPath, "utf8");
            return JSON.parse(raw);
        } catch {
            return [];
        }
    }

    private handleOutfitsList(memberNumber: number): void {
        if (!this.requireAdmin(memberNumber)) return;

        const suggestions = this.loadOutfitSuggestions();
        if (suggestions.length === 0) {
            this.bot.whisper(memberNumber, "No outfit suggestions submitted yet.");
            return;
        }

        const lines = suggestions.map((s, i) =>
            `${i + 1}. ${s.name} (#${s.memberNumber}) [${s.timestamp}]: ${s.description}`
        );

        this.sendLongWhisper(memberNumber, `=== Submitted Outfits ===\n${lines.join("\n")}`);
    }

    // ============================================================
    // SOLO GAME MODE
    // ============================================================

    private handleSoloStart(memberNumber: number, name: string, mode: SoloMode): void {
        if (this.soloGames.has(memberNumber)) {
            this.bot.whisper(memberNumber, "You already have a solo game in progress — !roll to continue.");
            return;
        }
        this.pendingSoloSetup.set(memberNumber, { mode, name, clothingQuestionIndex: 0, pendingClothing: [] });
        this.bot.whisper(memberNumber, "Let's go through your outfit — yes or no for each item.");
        this.askSoloClothingQuestion(memberNumber);
    }

    private askSoloClothingQuestion(memberNumber: number): void {
        const pending = this.pendingSoloSetup.get(memberNumber)!;
        const idx = pending.clothingQuestionIndex;

        if (idx >= CLOTHING_SLOTS.length) {
            const clothing = CLOTHING_SLOTS.filter(slot => pending.pendingClothing.includes(slot));
            if (clothing.length === 0) {
                this.bot.whisper(memberNumber, "You need at least one item to start — let's try again.");
                pending.clothingQuestionIndex = 0;
                pending.pendingClothing = [];
                this.askSoloClothingQuestion(memberNumber);
                return;
            }
            this.startSoloGame(memberNumber, pending.mode, pending.name, clothing);
            return;
        }

        this.bot.whisper(memberNumber, `Wearing ${CLOTHING_SLOTS[idx]}? (yes/no)`);
    }

    private handleSoloClothingAnswer(memberNumber: number, msg: string): void {
        const pending = this.pendingSoloSetup.get(memberNumber)!;
        const idx = pending.clothingQuestionIndex;
        const item = CLOTHING_SLOTS[idx];

        if (msg === "yes" || msg === "y") {
            pending.pendingClothing.push(item);
        }

        pending.clothingQuestionIndex = idx + 1;
        this.askSoloClothingQuestion(memberNumber);
    }

    private startSoloGame(memberNumber: number, mode: SoloMode, name: string, clothing: string[]): void {
        this.pendingSoloSetup.delete(memberNumber);

        const bracket = clothing.length;
        const solo: SoloGameState = {
            memberNumber,
            name,
            mode,
            bracket,
            currentMax: SOLO_DICE_MAX,
            totalRolls: 0,
            rollsThisItem: 0,
            clothingRemaining: clothing,
            clothingLost: [],
            startTime: new Date().toISOString(),
            awaitingRemoval: false,
            inactivityTimer: null,
        };
        this.soloGames.set(memberNumber, solo);
        this.writeBotState();
        logGameEvent(`[SOLO START] mode: ${solo.mode} | bracket: ${bracket} | player: ${solo.name} (#${memberNumber})`);

        this.bot.sendChat(`🎲 ${name} is playing a solo game — good luck!`);

        const modeLabel = mode === "race" ? "Race to Naked" : "Survive";
        const objective = mode === "race"
            ? "Each roll's result becomes your next roll's max. Hit a 1 and you lose an item — fewest total rolls wins."
            : "Each roll's result becomes your next roll's max. Hit a 1 and you lose an item — most total rolls before you're naked wins.";

        this.bot.whisper(memberNumber,
            `🎲 ${modeLabel} — starting with ${bracket} item${bracket === 1 ? "" : "s"}: ${clothing.join(", ")}.\n` +
            `${objective}\n` +
            `This is just between us.`
        );
        this.bot.whisper(memberNumber, `${solo.name}, !roll (D${solo.currentMax})`);
        this.startSoloInactivityTimer(memberNumber);
    }

    private handleSoloRoll(memberNumber: number): void {
        const solo = this.soloGames.get(memberNumber);
        if (!solo) return;

        this.clearSoloInactivityTimer(solo);

        if (solo.awaitingRemoval) {
            const lostItem = solo.clothingLost[solo.clothingLost.length - 1];
            this.bot.whisper(memberNumber, `⏸️ Remove your ${lostItem}, or type !removed.`);
            this.startSoloInactivityTimer(memberNumber);
            return;
        }

        const roll = Math.floor(Math.random() * solo.currentMax) + 1;
        solo.totalRolls++;
        solo.rollsThisItem++;

        if (roll === 1) {
            const lostItem = solo.clothingRemaining.shift()!;
            solo.clothingLost.push(lostItem);

            this.bot.whisper(memberNumber,
                `You rolled a 1 — lost your ${lostItem}! (${solo.rollsThisItem} roll${solo.rollsThisItem === 1 ? "" : "s"} for that item, ${solo.totalRolls} total)`
            );

            solo.awaitingRemoval = true;
            this.bot.whisper(memberNumber, `Remove your ${lostItem}, or type !removed.`);
            this.startSoloInactivityTimer(memberNumber);
            return;
        }

        solo.currentMax = roll;
        this.bot.whisper(memberNumber, `You rolled ${roll} — next roll is a D${solo.currentMax}.`);
        this.bot.whisper(memberNumber, `${solo.name}, !roll`);
        this.startSoloInactivityTimer(memberNumber);
    }

    // Called once the player confirms (whispered !removed, or opened their
    // Wardrobe) that the item they just lost is off.
    private handleSoloRemoved(memberNumber: number): void {
        const solo = this.soloGames.get(memberNumber);
        if (!solo || !solo.awaitingRemoval) return;

        this.clearSoloInactivityTimer(solo);
        solo.awaitingRemoval = false;

        if (solo.clothingRemaining.length === 0) {
            this.finishSoloGame(memberNumber);
            return;
        }

        solo.currentMax = SOLO_DICE_MAX;
        solo.rollsThisItem = 0;
        this.bot.whisper(memberNumber, `${solo.clothingRemaining.length} item${solo.clothingRemaining.length === 1 ? "" : "s"} left: ${solo.clothingRemaining.join(", ")}.`);
        this.bot.whisper(memberNumber, `${solo.name}, !roll (D${solo.currentMax})`);
        this.startSoloInactivityTimer(memberNumber);
    }

    // Soft nudge if the player goes quiet for SOLO_INACTIVITY_TIMEOUT_MS after
    // a prompt. Does not end the game; resets whenever the player acts.
    private startSoloInactivityTimer(memberNumber: number): void {
        const solo = this.soloGames.get(memberNumber);
        if (!solo) return;

        this.clearSoloInactivityTimer(solo);
        solo.inactivityTimer = setTimeout(() => {
            solo.inactivityTimer = null;
            if (solo.awaitingRemoval) {
                this.bot.whisper(memberNumber, "Whenever you're ready — type !removed once it's off.");
            } else {
                this.bot.whisper(memberNumber, "Whenever you're ready — type !roll to continue.");
            }
        }, SOLO_INACTIVITY_TIMEOUT_MS);
    }

    private clearSoloInactivityTimer(solo: SoloGameState): void {
        if (solo.inactivityTimer) {
            clearTimeout(solo.inactivityTimer);
            solo.inactivityTimer = null;
        }
    }

    // Returns true if `score` beats `current` (or the hardcoded default target
    // if no record exists yet). For "race", fewer rolls is better; for
    // "survive", more rolls is better.
    private isSoloRecordBeat(mode: SoloMode, score: number, current: SoloRecordEntry | undefined): boolean {
        const target = current ? current.rolls : SOLO_DEFAULT_TARGET;
        return mode === "race" ? score < target : score > target;
    }

    private finishSoloGame(memberNumber: number): void {
        const solo = this.soloGames.get(memberNumber);
        if (!solo) return;
        this.clearSoloInactivityTimer(solo);
        this.soloGames.delete(memberNumber);
        this.writeBotState();

        const records = this.loadSoloRecords();
        const bracketKey = String(solo.bracket);
        const modeLabel = solo.mode === "race" ? "Race to Naked" : "Survive";
        const dailyRecord = records.daily[solo.mode][bracketKey];
        const allTimeRecord = records.allTime[solo.mode][bracketKey];
        const score = solo.totalRolls;
        const endTime = new Date().toISOString();
        const players = [`${solo.name}(#${memberNumber})`];

        this.bot.whisper(memberNumber, `🎉 You're naked! Final score: ${score} roll${score === 1 ? "" : "s"}.`);

        if (this.isSoloRecordBeat(solo.mode, score, dailyRecord)) {
            const entry: SoloRecordEntry = { memberNumber, name: solo.name, rolls: score };
            records.daily[solo.mode][bracketKey] = entry;
            this.bot.sendChat(`🎲 ${solo.name} set a new daily record for ${modeLabel} (${solo.bracket}-item bracket) — ${score} rolls!`);

            if (this.isSoloRecordBeat(solo.mode, score, allTimeRecord)) {
                records.allTime[solo.mode][bracketKey] = entry;
                this.bot.sendChat(`🏆 That's also a new ALL-TIME record for ${modeLabel} (${solo.bracket}-item bracket)!`);
            }

            logGameEvent(`[SOLO END] mode: ${solo.mode} | bracket: ${solo.bracket} | player: ${solo.name} | score: ${score} rolls | outcome: record-beaten`);
            this.appendGameLog({
                type: "solo", mode: solo.mode, startTime: solo.startTime, endTime,
                players, outcome: "record-beaten", score,
            });

            this.removeAllItems(memberNumber);
            this.saveSoloRecords(records);
            return;
        }

        const recordRolls = dailyRecord ? dailyRecord.rolls : SOLO_DEFAULT_TARGET;
        this.bot.whisper(memberNumber, `You didn't beat the record (${recordRolls} rolls). Better luck next time!`);

        const attemptsToday = records.attempts[solo.mode][bracketKey]?.[String(memberNumber)] ?? 0;
        const penaltyMinutes = SOLO_BASE_PENALTY_MINUTES + attemptsToday;
        this.applySoloPenalty(memberNumber, penaltyMinutes);

        logGameEvent(`[SOLO END] mode: ${solo.mode} | bracket: ${solo.bracket} | player: ${solo.name} | score: ${score} rolls | outcome: loss | penalty: ${penaltyMinutes}min`);
        this.appendGameLog({
            type: "solo", mode: solo.mode, startTime: solo.startTime, endTime,
            players, outcome: "loss", score, penaltyMin: penaltyMinutes,
        });

        if (!records.attempts[solo.mode][bracketKey]) records.attempts[solo.mode][bracketKey] = {};
        records.attempts[solo.mode][bracketKey][String(memberNumber)] = attemptsToday + 1;
        this.saveSoloRecords(records);
    }

    // Applies a random eligible bondage outfit (or just its first `itemCap`
    // items, for partial bondage when a player leaves mid-run) locked for
    // `penaltyMinutes`.
    private applySoloPenalty(memberNumber: number, penaltyMinutes: number, itemCap?: number): void {
        const pool = this.getEligibleOutfits(memberNumber);
        if (pool.length === 0) return;

        const outfit = pool[Math.floor(Math.random() * pool.length)];
        const items = itemCap !== undefined ? outfit.items.slice(0, itemCap) : outfit.items;
        if (items.length === 0) return;

        const lockEndTime = Date.now() + penaltyMinutes * 60 * 1000;

        items.forEach((item, i) => {
            setTimeout(() => {
                this.bot.applyItem(memberNumber, item.group, item.name, item.color, item.property);
                setTimeout(() => {
                    this.bot.applyItem(
                        memberNumber,
                        item.group,
                        item.name,
                        item.color,
                        this.buildLockedItemProperty(item, {
                            hint: `Released in ${penaltyMinutes} minutes`,
                            removeItem: true,
                            showTimer: true,
                            removeTimer: lockEndTime
                        })
                    );
                }, REMOVAL_UNLOCK_GAP_MS);
            }, i * REMOVAL_SLOT_DELAY_MS);
        });

        this.bot.whisper(memberNumber, `⛓️ Bondage penalty applied — locked for ${penaltyMinutes} minutes.`);
    }

    // Called when a player leaves the room mid-run. Discards their solo game
    // state, applying partial bondage (one item per clothing item already
    // lost) if they'd made any progress.
    private cleanupSoloOnLeave(memberNumber: number): void {
        this.pendingSoloSetup.delete(memberNumber);

        const solo = this.soloGames.get(memberNumber);
        if (!solo) return;
        this.clearSoloInactivityTimer(solo);
        this.soloGames.delete(memberNumber);
        this.writeBotState();

        logGameEvent(`[SOLO END] mode: ${solo.mode} | bracket: ${solo.bracket} | player: ${solo.name} | outcome: abandoned`);
        this.appendGameLog({
            type: "solo", mode: solo.mode, startTime: solo.startTime, endTime: new Date().toISOString(),
            players: [`${solo.name}(#${memberNumber})`], outcome: "abandoned",
        });

        const clothingRemoved = solo.clothingLost.length;
        if (clothingRemoved <= 0) return;

        const records = this.loadSoloRecords();
        const bracketKey = String(solo.bracket);
        const attemptsToday = records.attempts[solo.mode][bracketKey]?.[String(memberNumber)] ?? 0;
        const penaltyMinutes = SOLO_BASE_PENALTY_MINUTES + attemptsToday;

        this.applySoloPenalty(memberNumber, penaltyMinutes, clothingRemoved);

        if (!records.attempts[solo.mode][bracketKey]) records.attempts[solo.mode][bracketKey] = {};
        records.attempts[solo.mode][bracketKey][String(memberNumber)] = attemptsToday + 1;
        this.saveSoloRecords(records);
    }

    // Admin command: !solo_reset [player name]. With no name, lists all
    // active solo games. With a name, discards that player's solo game with
    // no penalty (e.g. to clear a stuck/buggy run).
    private handleSoloReset(memberNumber: number, message: string): void {
        if (!this.requireAdmin(memberNumber)) return;

        const requested = message.trim().slice("!solo_reset".length).trim();

        if (!requested) {
            if (this.soloGames.size === 0) {
                this.bot.whisper(memberNumber, "No solo games are currently active.");
                return;
            }
            const lines = [...this.soloGames.values()].map(solo => {
                const modeLabel = solo.mode === "race" ? "Race to Naked" : "Survive";
                return `${solo.name} (#${solo.memberNumber}) - ${modeLabel}, ${solo.bracket}-item bracket, ${solo.clothingLost.length}/${solo.bracket} lost, ${solo.totalRolls} rolls so far`;
            });
            this.sendLongWhisper(memberNumber, `=== Active Solo Games ===\n${lines.join("\n")}\nUsage: !solo_reset [player name] to reset one.`);
            return;
        }

        const target = [...this.soloGames.values()].find(s => s.name.toLowerCase().includes(requested.toLowerCase()));
        if (!target) {
            this.bot.whisper(memberNumber, `No active solo game found matching "${requested}".`);
            return;
        }

        this.clearSoloInactivityTimer(target);
        this.soloGames.delete(target.memberNumber);
        this.pendingSoloSetup.delete(target.memberNumber);
        this.writeBotState();

        logGameEvent(`[SOLO END] mode: ${target.mode} | bracket: ${target.bracket} | player: ${target.name} | outcome: admin-reset`);
        this.appendGameLog({
            type: "solo", mode: target.mode, startTime: target.startTime, endTime: new Date().toISOString(),
            players: [`${target.name}(#${target.memberNumber})`], outcome: "admin-reset",
        });

        this.bot.whisper(memberNumber, `Solo game for ${target.name} has been reset.`);
        this.bot.whisper(target.memberNumber, "An admin reset your solo game — !solo race or !solo survive to start a new one.");
    }

    private loadSoloRecords(): SoloRecordsData {
        let data: SoloRecordsData;
        try {
            const raw = fs.readFileSync(this.soloRecordsPath, "utf8");
            data = JSON.parse(raw);
        } catch {
            data = emptySoloRecordsData();
        }

        const today = utcDateString();
        if (data.date !== today) {
            data.date = today;
            data.daily = { race: {}, survive: {} };
            data.attempts = { race: {}, survive: {} };
        }

        return data;
    }

    private saveSoloRecords(data: SoloRecordsData): void {
        try {
            fs.writeFileSync(this.soloRecordsPath, JSON.stringify(data, null, 2), "utf8");
        } catch (err) {
            log("ERROR: Failed to write solo_records.json: " + err);
        }
    }

    // ============================================================
    // GAME ACTIVITY LOGGING
    // ============================================================

    // Appends one NDJSON line to game_log.json for a completed game (multiplayer or solo).
    private appendGameLog(entry: GameLogEntry): void {
        try {
            fs.appendFileSync(this.gameLogPath, JSON.stringify(entry) + "\n", "utf8");
        } catch (err) {
            log("ERROR: Failed to write game_log.json: " + err);
        }
    }

    // Drops game_log.json entries older than 30 days. Called once on startup.
    private pruneGameLog(): void {
        try {
            if (!fs.existsSync(this.gameLogPath)) return;
            const raw = fs.readFileSync(this.gameLogPath, "utf8");
            const cutoff = Date.now() - GAME_LOG_RETENTION_MS;

            const kept = raw.split("\n")
                .filter(line => line.trim().length > 0)
                .filter(line => {
                    try {
                        const entry: GameLogEntry = JSON.parse(line);
                        return new Date(entry.endTime).getTime() >= cutoff;
                    } catch {
                        return false;
                    }
                });

            fs.writeFileSync(this.gameLogPath, kept.map(line => line + "\n").join(""), "utf8");
        } catch (err) {
            log("ERROR: Failed to prune game_log.json: " + err);
        }
    }

    // Writes a small status snapshot read by external monitoring tools.
    private writeBotState(): void {
        const state = {
            activeMultiplayer: this.activeMultiplayer,
            activeSoloCount: this.soloGames.size,
            lastUpdated: new Date().toISOString(),
        };
        try {
            fs.writeFileSync(this.botStatePath, JSON.stringify(state, null, 2), "utf8");
        } catch (err) {
            log("ERROR: Failed to write bot_state.json: " + err);
        }
    }

    // Logs a "[GAME END] multiplayer" line plus a game_log.json entry, and
    // marks this game's end as logged so resetGame() doesn't log it again
    // as a generic "reset".
    private logMultiplayerGameEnd(outcome: "win" | "all-bound" | "reset" | "aborted", options?: { winner?: string; logSuffix?: string }): void {
        const playerNames = [...this.players.values()].map(p => p.name).join(", ");
        const outcomeLabel = options?.logSuffix ? `${outcome} (${options.logSuffix})` : outcome;
        const winnerPart = options?.winner ? ` | winner: ${options.winner}` : "";
        logGameEvent(`[GAME END] multiplayer | outcome: ${outcomeLabel}${winnerPart} | players: ${playerNames}`);

        const entry: GameLogEntry = {
            type: "multiplayer",
            mode: null,
            startTime: this.gameStartTime ?? new Date().toISOString(),
            endTime: new Date().toISOString(),
            players: [...this.players.values()].map(p => `${p.name}(#${p.memberNumber})`),
            outcome,
        };
        if (options?.winner) entry.winner = options.winner;
        this.appendGameLog(entry);
        this.gameEndLogged = true;
    }

    // ============================================================
    // SCORES & LEADERBOARDS
    // ============================================================

    private formatSoloScoreLine(records: SoloRecordsData, mode: SoloMode, bracket: number): string {
        const bracketKey = String(bracket);
        const daily = records.daily[mode][bracketKey];
        const allTime = records.allTime[mode][bracketKey];
        const dailyStr = daily ? `${daily.name} ${daily.rolls} rolls` : "—";
        const allTimeStr = allTime ? `${allTime.name} ${allTime.rolls} rolls` : "—";
        return `${bracket} items: ${dailyStr} | ${allTimeStr}`;
    }

    private handleScores(memberNumber: number, filter?: SoloMode): void {
        const records = this.loadSoloRecords();
        const lines: string[] = [];

        if (!filter || filter === "race") {
            lines.push("🎲 Race to Naked (daily | all-time)");
            for (let b = SOLO_BRACKET_MIN; b <= SOLO_BRACKET_MAX; b++) {
                lines.push(this.formatSoloScoreLine(records, "race", b));
            }
        }
        if (!filter || filter === "survive") {
            lines.push("🧦 Survive (daily | all-time)");
            for (let b = SOLO_BRACKET_MIN; b <= SOLO_BRACKET_MAX; b++) {
                lines.push(this.formatSoloScoreLine(records, "survive", b));
            }
        }
        lines.push("Type !scores me for your personal stats.");

        this.sendLongWhisper(memberNumber, lines.join("\n"));
    }

    private handleScoresMe(memberNumber: number): void {
        const records = this.loadSoloRecords();
        const name = this.getPlayerName(memberNumber);
        const lines: string[] = [`=== Your Solo Stats, ${name} ===`];

        for (const mode of ["race", "survive"] as SoloMode[]) {
            const modeLabel = mode === "race" ? "Race to Naked" : "Survive";
            for (let b = SOLO_BRACKET_MIN; b <= SOLO_BRACKET_MAX; b++) {
                const bracketKey = String(b);
                const daily = records.daily[mode][bracketKey];
                const allTime = records.allTime[mode][bracketKey];
                const isDailyMe = daily?.memberNumber === memberNumber;
                const isAllTimeMe = allTime?.memberNumber === memberNumber;
                const attempts = records.attempts[mode][bracketKey]?.[String(memberNumber)] ?? 0;

                if (!isDailyMe && !isAllTimeMe && attempts === 0) continue;

                const parts: string[] = [];
                if (isAllTimeMe) parts.push(`all-time best ${allTime!.rolls} rolls`);
                if (isDailyMe && !(isAllTimeMe && daily!.rolls === allTime!.rolls)) parts.push(`today's best ${daily!.rolls} rolls`);
                if (parts.length > 0) lines.push(`${modeLabel} (${b} items): ${parts.join(", ")}`);

                if (attempts > 0) {
                    const penaltyMinutes = SOLO_BASE_PENALTY_MINUTES + attempts;
                    lines.push(`  Attempts today: ${attempts} (next penalty if you don't beat the record: ${penaltyMinutes} min)`);
                }
            }
        }

        if (lines.length === 1) lines.push("No personal records yet — try !solo race or !solo survive!");

        this.sendLongWhisper(memberNumber, lines.join("\n"));
    }

    private handleLeaderboard(memberNumber: number): void {
        const records = Object.values(this.playerRecords);
        const me = this.playerRecords[String(memberNumber)];
        const myWins = me?.gamesWon ?? 0;
        const myLosses = me?.gamesLost ?? 0;

        const topWinners = records.filter(r => r.gamesWon > 0).sort((a, b) => b.gamesWon - a.gamesWon).slice(0, 5);
        const topLosers = records.filter(r => r.gamesLost > 0).sort((a, b) => b.gamesLost - a.gamesLost).slice(0, 5);

        const lines: string[] = [`Your record: ${myWins}W / ${myLosses}L`];

        lines.push("─ Top 5 Winners ─");
        if (topWinners.length === 0) {
            lines.push("No wins recorded yet.");
        } else {
            topWinners.forEach((r, i) => lines.push(`${i + 1}. ${r.name} — ${r.gamesWon} wins`));
        }

        lines.push("─ Top 5 Losers ─");
        if (topLosers.length === 0) {
            lines.push("No losses recorded yet.");
        } else {
            topLosers.forEach((r, i) => lines.push(`${i + 1}. ${r.name} — ${r.gamesLost} losses`));
        }

        this.sendLongWhisper(memberNumber, lines.join("\n"));
    }

    // ============================================================
    // FEEDBACK STATUS NOTIFICATIONS
    // ============================================================

    private loadFeedbackStatus(): void {
        try {
            const raw = fs.readFileSync(this.feedbackStatusPath, "utf8");
            this.feedbackStatus = JSON.parse(raw);
        } catch {
            this.feedbackStatus = {};
        }
    }

    private saveFeedbackStatus(): void {
        try {
            fs.writeFileSync(this.feedbackStatusPath, JSON.stringify(this.feedbackStatus, null, 2), "utf8");
        } catch (err) {
            log("ERROR: Failed to write feedback_status.json: " + err);
        }
    }

    private notifyFeedbackStatus(memberNumber: number, name: string): void {
        if (this.feedbackNotified.has(memberNumber)) return;
        const entry = this.feedbackStatus[String(memberNumber)];
        if (!entry || entry.items.length === 0) return;
        this.feedbackNotified.add(memberNumber);

        const itemsToShow = entry.items.filter(item =>
            !(RESOLVED_FEEDBACK_STATUSES.has(item.status) && item.statusShown)
        );
        if (itemsToShow.length === 0) return;

        const lines = itemsToShow.map((item, i) =>
            `${i + 1}. "${item.text}" — ${FEEDBACK_STATUS_LABELS[item.status] ?? item.status}`
        );

        this.sendLongWhisper(memberNumber,
            `Hi ${name}! Here's an update on the feedback you've sent us:\n` +
            lines.join("\n") +
            `\n\nThanks for helping us improve the game! 💕`
        );

        let changed = false;
        for (const item of itemsToShow) {
            if (RESOLVED_FEEDBACK_STATUSES.has(item.status) && !item.statusShown) {
                item.statusShown = true;
                changed = true;
            }
        }
        if (changed) this.saveFeedbackStatus();
    }

    // Whispers tend to get silently dropped by the BC server if they exceed
    // its max chat message length, so split long messages on line boundaries.
    private sendLongWhisper(memberNumber: number, text: string, maxLen: number = 900): void {
        if (text.length <= maxLen) {
            this.bot.whisper(memberNumber, text);
            return;
        }

        const chunks: string[] = [];
        let chunk = "";
        for (const line of text.split("\n")) {
            if (chunk && chunk.length + 1 + line.length > maxLen) {
                chunks.push(chunk);
                chunk = "";
            }
            chunk = chunk ? `${chunk}\n${line}` : line;
        }
        if (chunk) chunks.push(chunk);

        chunks.forEach((c, i) => {
            setTimeout(() => this.bot.whisper(memberNumber, c), i * 300);
        });
    }

    // ============================================================
    // PLAYER TRACKING
    // ============================================================

    // Picks the right welcome message based on whether a multiplayer game is
    // running, whether it's still joinable, and whether solo games are active.
    private sendWelcomeWhisper(memberNumber: number, name: string): void {
        if (this.state === GameState.Idle) {
            if (this.soloGames.size > 0) {
                this.bot.whisper(memberNumber,
                    "Welcome! Some solo games are already going — type !solo race or !solo survive to start your own, or !join to request a multiplayer game."
                );
            } else {
                this.bot.whisper(memberNumber,
                    "Welcome! You can play a solo game (!solo race or !solo survive) or type !join to start a multiplayer game and wait for others."
                );
            }
            return;
        }

        if (this.isMultiplayerJoinable()) {
            this.bot.whisper(memberNumber,
                `Welcome, ${name}! StripDiceBot has been getting regular updates thanks to player feedback. ` +
                `Play a round and let us know what you think — type !join to jump in or !help to see the rules. 🎲`
            );
        } else {
            this.bot.whisper(memberNumber,
                "A multiplayer game is in progress and it's too late to join, but you can play a solo game! Type !solo race or !solo survive to start."
            );
        }
    }

    // True if a normal !join would currently be accepted (i.e. not the
    // "naked late join" path, which !join handles separately).
    private isMultiplayerJoinable(): boolean {
        if (this.state === GameState.Registration || this.state === GameState.Countdown) return true;
        const midGame = this.state === GameState.Rolling || this.state === GameState.WaitingRemove || this.state === GameState.WaitingBondage;
        return midGame && this.allowMidGameJoin && !this.bondagePhaseStarted;
    }

    private loadPlayerRecords(): void {
        try {
            const raw = fs.readFileSync(this.playerRecordsPath, "utf8");
            this.playerRecords = JSON.parse(raw);
        } catch {
            this.playerRecords = {};
        }

        for (const memberNumber of this.feedbackMemberNumbers) {
            const record = this.playerRecords[String(memberNumber)];
            if (record) record.feedbackGiven = true;
        }

        // Backfill gamesLost for records saved before the field existed.
        for (const record of Object.values(this.playerRecords)) {
            record.gamesLost ??= 0;
        }
    }

    private savePlayerRecords(): void {
        try {
            fs.writeFileSync(this.playerRecordsPath, JSON.stringify(this.playerRecords, null, 2), "utf8");
        } catch (err) {
            log("ERROR: Failed to write players.json: " + err);
        }
    }

    // Reads feedback.log and returns the set of member numbers that have
    // submitted feedback, e.g. lines like "... Missy (#208543): ...".
    private loadFeedbackMemberNumbers(): Set<number> {
        const memberNumbers = new Set<number>();
        try {
            const raw = fs.readFileSync(path.join(__dirname, "..", "feedback.log"), "utf8");
            for (const match of raw.matchAll(/\(#(\d+)\)/g)) {
                memberNumbers.add(Number(match[1]));
            }
        } catch {
            // No feedback log yet
        }
        return memberNumbers;
    }

    private recordPlayerSeen(memberNumber: number, name: string): void {
        const key = String(memberNumber);
        const now = centralTimestamp();
        const existing = this.playerRecords[key];
        if (existing) {
            existing.name = name;
            existing.lastSeen = now;
        } else {
            this.playerRecords[key] = {
                memberNumber,
                name,
                firstSeen: now,
                lastSeen: now,
                gamesPlayed: 0,
                gamesWon: 0,
                gamesLost: 0,
                feedbackGiven: this.feedbackMemberNumbers.has(memberNumber),
            };
        }
        this.savePlayerRecords();
    }

    // Called once a game reaches its conclusion (either a winner is found or
    // everyone is bound), crediting every participant with a completed game.
    private recordGameCompletion(winnerMemberNumber: number | null): void {
        for (const player of this.players.values()) {
            const record = this.playerRecords[String(player.memberNumber)];
            if (!record) continue;
            record.gamesPlayed++;
            if (winnerMemberNumber !== null && player.memberNumber === winnerMemberNumber) {
                record.gamesWon++;
            } else if (player.isFullyBound) {
                record.gamesLost++;
            }
        }
        this.savePlayerRecords();
    }

    private handleFeedbackList(memberNumber: number): void {
        if (!this.requireAdmin(memberNumber)) return;

        const entries = Object.entries(this.feedbackStatus);
        if (entries.length === 0) {
            this.bot.whisper(memberNumber, "No feedback recorded yet.");
            return;
        }

        const lines: string[] = [];
        for (const [playerId, entry] of entries) {
            lines.push(`${entry.name} (#${playerId}):`);
            entry.items.forEach((item, i) => {
                lines.push(`  ${i + 1}. [${FEEDBACK_STATUS_LABELS[item.status] ?? item.status}] ${item.text}`);
            });
        }

        this.sendLongWhisper(memberNumber, `=== Feedback Status ===\n${lines.join("\n")}`);
    }

    private handleHelp(memberNumber: number): void {
        let text =
            `=== Strip Dice Help ===\n` +
            `!help player - Multiplayer game commands (join, clothing, rolling, locks)\n` +
            `!help solo - Solo whisper game & leaderboard commands\n`;

        if (this.isAdmin(memberNumber)) {
            text += `!help admin - Admin commands\n`;
        }

        text += `!about - About this bot`;

        this.sendLongWhisper(memberNumber, text);
    }

    private handleHelpPlayer(memberNumber: number): void {
        const text =
            `=== Strip Dice Commands ===\n` +
            `!join - Join the game\n` +
            `!wearing - Go through your outfit one item at a time (yes/no)\n` +
            `!wearing [items] - Declare your clothing all at once\n` +
            `  Valid items: shoes socks top bottom bra panties\n` +
            `!naked - Declare you have no clothing on\n` +
            `!same - Reuse your outfit from last game\n` +
            `!ready - Confirm you are ready to play\n` +
            `!lock10 / !lock15 / !lock20 - Set the end-game lock duration before the game starts (default ${DEFAULT_LOCK_MINUTES} min)\n` +
            `!start - Start the game early\n` +
            `!cancel - Cancel the countdown\n` +
            `!roll - Roll the dice on your turn (in room chat or whispered to me)\n` +
            `!removed - Confirm you removed a clothing item (in room chat)\n` +
            `!safeword - Emergency: remove all restraints immediately\n` +
            `!released / !stuck - Confirm whether your locks released at the end of the game\n` +
            `!feedback [text] - Send feedback to the developers\n` +
            `!outfit [description] - Submit an outfit idea that may be used as a future penalty\n` +
            `!leaderboard / !lb - View the multiplayer win/loss leaderboard\n` +
            `!about - About this bot\n` +
            `!help - Show the help menu`;

        this.sendLongWhisper(memberNumber, text);
    }

    private handleHelpSolo(memberNumber: number): void {
        const text =
            `=== Solo & Stats ===\n` +
            `!solo race - Solo whisper game: fewest rolls to get naked wins\n` +
            `!solo survive - Solo whisper game: most rolls before getting naked wins\n` +
            `!removed - Whisper this once you've taken off an item the game told you to remove (or just open your Wardrobe). No rush, the game waits for you.\n` +
            `!scores / !scores race / !scores survive - View solo leaderboards\n` +
            `!scores me - View your personal solo stats`;

        this.sendLongWhisper(memberNumber, text);
    }

    private handleHelpAdmin(memberNumber: number): void {
        if (!this.requireAdmin(memberNumber)) return;

        const text =
            `=== Admin Commands ===\n` +
            `!locktime [mins] - Set end game lock duration\n` +
            `!reset - End the current game immediately, remove bondage items from all players, and reset for a new game\n` +
            `!midgamejoin on/off - Allow players to join games already in progress\n` +
            `!testoutfit [name] - Force your next bondage outfit (for testing)\n` +
            `!setstatus [playerID] [status] - Set a player's feedback status (reviewing, testing, researching, implemented, partly_implemented)\n` +
            `!feedback list - View a summary of all tracked feedback\n` +
            `!outfits - View submitted outfit suggestions\n` +
            `!free [player name] - Remove all bondage items from a player; they stay in the game\n` +
            `!kick [player name] - Remove a player from the active game entirely (they keep any bondage already applied)\n` +
            `!solo_reset - List players with active solo games\n` +
            `!solo_reset [player name] - Discard a player's solo game with no penalty`;

        this.sendLongWhisper(memberNumber, text);
    }

    private handleRoll(memberNumber: number, name: string): void {
        if (this.state === GameState.WaitingRemove) {
            this.bot.sendChat(`⚠️ ${name}, please remove your item first and type !removed before rolling!`);
            return;
        }
        if (this.state !== GameState.Rolling) return;

        const currentPlayer = this.getCurrentPlayer();
        if (!currentPlayer || currentPlayer.memberNumber !== memberNumber) {
            this.bot.sendChat(`It's not your turn, ${name}!`);
            return;
        }

        this.clearTurnTimer();
        currentPlayer.timeoutCount = 0;

        const roll = Math.floor(Math.random() * this.currentDiceMax) + 1;
        this.bot.sendChat(`🎲 ${name} rolls a D${this.currentDiceMax}... and gets ${roll}!`);

        const isD100 = this.currentDiceMax === STARTING_DICE_MAX;

        if (isD100 && roll === 100) {
            currentPlayer.freePass = true;
            this.bot.sendChat(`🎟️ ${name} rolled 100 — free pass! They can skip their next required roll.`);
            this.advanceTurn();
            return;
        }

        if (isD100 && roll === 1) {
            this.handleDoublePenalty(currentPlayer);
            return;
        }

        if (roll === 1) {
            this.handleLoss(currentPlayer);
        } else {
            this.currentDiceMax = roll;
            this.advanceTurn();
        }
    }

    public handleWardrobe(memberNumber: number, name: string): void {
        if (this.soloGames.get(memberNumber)?.awaitingRemoval) {
            this.handleSoloRemoved(memberNumber);
            return;
        }

        if (this.state !== GameState.WaitingRemove) return;
        const currentPlayer = this.getCurrentPlayer();
        if (!currentPlayer || currentPlayer.memberNumber !== memberNumber) return;
        this.handleRemoved(memberNumber, name);
    }

    private handleRemoved(memberNumber: number, name: string): void {
        if (this.state !== GameState.WaitingRemove) return;

        const currentPlayer = this.getCurrentPlayer();
        if (!currentPlayer || currentPlayer.memberNumber !== memberNumber) return;

        this.clearTurnTimer();
        const player = this.players.get(memberNumber)!;
        player.clothingRemoved++;

        this.bot.sendChat(`✅ ${name} has removed their item.`);

        if (player.pendingPenaltySteps > 0) {
            player.pendingPenaltySteps--;
            this.applyPendingPenaltyStep(player, name);
            return;
        }

        this.bot.sendChat(`Continuing the game...`);

        // Loser rolls first next round with fresh D100
        this.currentDiceMax = STARTING_DICE_MAX;
        this.state = GameState.Rolling;
        this.startTurnTimer();
        this.bot.sendChat(`🎲 ${name} rolls first — !roll (D${this.currentDiceMax})`);
    }

    // ============================================================
    // GAME FLOW
    // ============================================================

    private checkAllJoined(): void {
        const nonBotMembers = [...this.roomMembers].filter(n => n !== this.bot.getMemberNumber());
        const joinedCount = this.players.size;

        if (joinedCount >= nonBotMembers.length && nonBotMembers.length > 0) {
            this.startCountdown();
        }
    }

    private startCountdown(): void {
        this.state = GameState.Countdown;
        this.bot.sendChat(`All players have joined! 🎲 Game starts in 30 seconds... Whisper !start to begin early or !cancel to wait for more players.`);

        let seconds = 30;
        this.countdownTimer = setInterval(() => {
            seconds -= 10;
            if (seconds === 20 || seconds === 10) {
                this.bot.sendChat(`Game starting in ${seconds} seconds...`);
            }
            if (seconds <= 0) {
                this.clearCountdown();
                this.beginClothingDeclaration();
            }
        }, 10000);
    }

    private clearCountdown(): void {
        if (this.countdownTimer) {
            clearInterval(this.countdownTimer);
            this.countdownTimer = null;
        }
    }

    private beginClothingDeclaration(): void {
        this.state = GameState.Registration;
        this.bot.sendChat(`Please whisper me your clothing declaration! Whisper !help for instructions.`);

        for (const [, player] of this.players) {
            if (!player.ready) {
                this.bot.whisper(player.memberNumber,
                    `Game is starting soon! Please whisper:\n` +
                    (this.lastClothing.has(player.memberNumber)
                        ? `!same - use your last outfit (${this.lastClothing.get(player.memberNumber)!.join(", ")})\n`
                        : ``) +
                    `!wearing - go through your outfit one item at a time (yes/no)\n` +
                    `!wearing [items] - e.g. !wearing shoes socks top bottom bra panties\n` +
                    `!naked - if you have nothing on\n` +
                    `Then whisper !ready`
                );
            }
        }
    }

    private checkAllReady(): void {
        if (this.players.size === 0) return;

        for (const [, player] of this.players) {
            if (!player.ready) return;
        }

        this.startGame();
    }

    private startGame(): void {
        this.state = GameState.Rolling;

        // Generate password
        this.gamePassword = TEST_MODE ? TEST_PASSWORD : generatePassword();
        log(`Game password: ${this.gamePassword} (TEST_MODE: ${TEST_MODE})`);

        // Build random turn order
        this.turnOrder = [...this.players.keys()];
        this.shuffleArray(this.turnOrder);
        this.currentTurnIndex = 0;
        this.currentDiceMax = STARTING_DICE_MAX;

        this.activeMultiplayer = true;
        const playerNames = [...this.players.values()].map(p => p.name).join(", ");
        logGameEvent(`[GAME START] multiplayer | players: ${playerNames} | lock: ${this.lockDurationMinutes}min`);
        this.writeBotState();

        const orderNames = this.turnOrder.map(n => this.getPlayerName(n)).join(" → ");
        this.bot.sendChat(`🎲 === STRIP DICE BEGINS === 🎲`);
        this.bot.sendChat(`Turn order: ${orderNames}`);
        this.bot.sendChat(`Lock duration: ${this.lockDurationMinutes} minutes`);

        for (const [, player] of this.players) {
            if (player.isNaked) {
                this.bot.sendChat(`${player.name}: Starting naked 😈`);
            } else {
                this.bot.sendChat(`${player.name}: ${player.clothing.join(", ")}`);
            }
        }

        this.announceCurrentTurn();
        this.startTurnTimer();
    }

    private announceCurrentTurn(): void {
        const player = this.getCurrentPlayer();
        if (!player) return;
        this.bot.whisper(player.memberNumber, `${player.name}, !roll (D${this.currentDiceMax})`);
    }

    private advanceTurn(): void {
        this.currentTurnIndex = (this.currentTurnIndex + 1) % this.turnOrder.length;
        this.resolveCurrentTurn();
    }

    // Starts the current player's turn, unless they're in their post-leave
    // grace period. Grace-period players have their turn skipped and their
    // remaining grace rounds decremented; once a grace period expires the
    // player is removed and we move on to whoever is current next. Returns
    // false if removing an expired player ended the game (caller should stop).
    private resolveCurrentTurn(): boolean {
        while (true) {
            const player = this.getCurrentPlayer();
            if (!player) return true;

            if (player.pendingReturn) {
                player.leaveRoundsRemaining--;
                if (player.leaveRoundsRemaining <= 0) {
                    if (this.removeLeftPlayer(player)) return false;
                    continue;
                }
                const roundsWord = player.leaveRoundsRemaining === 1 ? "round" : "rounds";
                this.bot.sendChat(`⏭️ ${player.name} is still away — skipping their turn (${player.leaveRoundsRemaining} ${roundsWord} left to return).`);
                this.currentTurnIndex = (this.currentTurnIndex + 1) % this.turnOrder.length;
                continue;
            }

            if (player.freePass) {
                player.freePass = false;
                this.bot.sendChat(`🎟️ ${player.name} uses their free pass!`);
                this.currentTurnIndex = (this.currentTurnIndex + 1) % this.turnOrder.length;
                continue;
            }

            this.state = GameState.Rolling;
            this.announceCurrentTurn();
            this.startTurnTimer();
            return true;
        }
    }

    // Removes a player whose post-leave grace period has expired. Returns
    // true if the game ended as a result of the removal.
    private removeLeftPlayer(player: Player): boolean {
        this.bot.sendChat(`${player.name} did not return in time and has been removed from the game.`);

        const removedIndex = this.turnOrder.indexOf(player.memberNumber);
        this.players.delete(player.memberNumber);
        this.turnOrder = this.turnOrder.filter(n => n !== player.memberNumber);

        if (this.players.size === 0) {
            this.bot.sendChat(`No players remaining. Resetting.`);
            this.resetGame();
            return true;
        }

        if (removedIndex !== -1 && removedIndex < this.currentTurnIndex) {
            this.currentTurnIndex--;
        }
        if (this.currentTurnIndex >= this.turnOrder.length) {
            this.currentTurnIndex = 0;
        }

        return this.checkGameEndCondition();
    }

    private handleLoss(player: Player): void {
        this.clearTurnTimer();

        if (player.isNaked) {
            this.applyNextBondageItem(player);
        } else {
            const nextItem = player.clothing[player.clothingRemoved];
            if (nextItem) {
                this.state = GameState.WaitingRemove;
                this.bot.sendChat(`😳 ${player.name} rolled a 1! Remove your ${nextItem}!`);
                this.startTurnTimer(60000);

                if (player.clothingRemoved + 1 >= player.clothing.length) {
                    player.isNaked = true;
                    this.bot.sendChat(`${player.name} will be naked after this! Bondage starts next loss... 😈`);
                }
            } else {
                player.isNaked = true;
                this.applyNextBondageItem(player);
            }
        }
    }

    // Rolling a 1 on the D100 applies two penalty steps instead of one. The
    // first step is applied immediately below; the second is queued via
    // pendingPenaltySteps and picked up by applyPendingPenaltyStep() once the
    // first step resolves (after !removed, or after the first bondage item locks).
    private handleDoublePenalty(player: Player): void {
        this.clearTurnTimer();

        if (player.isNaked) {
            this.bot.sendChat(`💀 ${player.name} rolled a 1 — double penalty! Two bondage items will be applied!`);
            player.pendingPenaltySteps = 1;
            this.applyNextBondageItem(player);
            return;
        }

        const remaining = player.clothing.length - player.clothingRemoved;
        if (remaining >= 2) {
            const item1 = player.clothing[player.clothingRemoved];
            const item2 = player.clothing[player.clothingRemoved + 1];
            this.bot.sendChat(`💀 ${player.name} rolled a 1 — double penalty! Remove your ${item1} and ${item2}!`);
            player.pendingPenaltySteps = 1;
            this.state = GameState.WaitingRemove;
            this.startTurnTimer(60000);
        } else {
            const item1 = player.clothing[player.clothingRemoved];
            this.bot.sendChat(`💀 ${player.name} rolled a 1 — double penalty! Remove your ${item1} — bondage starts immediately after!`);
            player.pendingPenaltySteps = 1;
            player.isNaked = true;
            this.state = GameState.WaitingRemove;
            this.startTurnTimer(60000);
        }
    }

    // Applies the second step of a double penalty once the first step has
    // resolved (called from handleRemoved after pendingPenaltySteps is consumed).
    private applyPendingPenaltyStep(player: Player, name: string): void {
        if (player.isNaked) {
            this.applyNextBondageItem(player);
            return;
        }

        const nextItem = player.clothing[player.clothingRemoved];
        if (nextItem) {
            this.state = GameState.WaitingRemove;
            this.bot.sendChat(`😳 ${name}, remove your ${nextItem} too!`);
            this.startTurnTimer(60000);

            if (player.clothingRemoved + 1 >= player.clothing.length) {
                player.isNaked = true;
                this.bot.sendChat(`${name} will be naked after this! Bondage starts next loss... 😈`);
            }
        } else {
            player.isNaked = true;
            this.applyNextBondageItem(player);
        }
    }

    // Builds the Property object for a padlocked bondage item, used both
    // when applying a fresh bondage item mid-game and when locking everyone
    // up at the end of the game.
    private buildLockedItemProperty(
        item: BondageItem,
        options: { hint: string; removeItem: boolean; showTimer: boolean; removeTimer: number }
    ): any {
        return {
            ...item.property,
            Effect: [...(item.property.Effect || []), "Lock"],
            LockedBy: "TimerPasswordPadlock",
            LockMemberNumber: this.bot.getMemberNumber(),
            LockMemberName: "GameBot",
            Password: this.gamePassword,
            Hint: options.hint,
            LockSet: true,
            RemoveItem: options.removeItem,
            ShowTimer: options.showTimer,
            EnableRandomInput: false,
            MemberNumberList: [],
            RemoveTimer: options.removeTimer
        };
    }

    private applyNextBondageItem(player: Player): void {
        if (!player.bondageOutfit) {
            const pool = this.getEligibleOutfits(player.memberNumber);
            if (pool.length === 0) {
                this.bot.sendChat("Sorry, no eligible outfits available — game cannot continue.");
                this.logMultiplayerGameEnd("aborted", { logSuffix: "no outfits" });
                this.resetGame();
                return;
            }
            player.bondageOutfit = pool[Math.floor(Math.random() * pool.length)];
            log(`${player.name} assigned bondage outfit: ${this.getBondageOutfitName(player.bondageOutfit)}`);
            this.bondagePhaseStarted = true;
        }

        const item = player.bondageOutfit.items[player.bondageApplied];

        if (!item) {
            player.isFullyBound = true;
            this.bot.sendChat(`🔒 ${player.name} is fully bound!`);
            this.checkGameEndCondition();
            return;
        }

        this.state = GameState.WaitingBondage;
        this.bot.sendChat(`⛓️ ${player.name} is naked! Applying bondage item ${player.bondageApplied + 1}...`);

        // Apply item
        this.bot.applyItem(
            player.memberNumber,
            item.group,
            item.name,
            item.color,
            item.property
        );

        // Mid-game locking disabled — restraints stay unlocked during play and
        // are only locked at game end, in applyEndGameLocks(). Kept commented
        // out (rather than deleted) in case we want to revert.
        // this.bot.applyItem(
        //     player.memberNumber,
        //     item.group,
        //     item.name,
        //     item.color,
        //     this.buildLockedItemProperty(item, {
        //         hint: "Game in progress...",
        //         removeItem: false,
        //         showTimer: false,
        //         removeTimer: Date.now() + (24 * 60 * 60 * 1000)
        //     })
        // );
        // this.verifyLockApplied(player, item.group, item.name);

        setTimeout(() => {
            player.bondageApplied++;
            const becameFullyBound = player.bondageApplied >= player.bondageOutfit!.items.length;

            if (becameFullyBound) {
                player.isFullyBound = true;
                this.turnOrder = this.turnOrder.filter(n => n !== player.memberNumber);
                this.bot.sendChat(`🔒 ${player.name} is fully bound and out of the game!`);
            } else {
                const followUp = player.pendingPenaltySteps > 0
                    ? `Applying the second item from their double penalty...`
                    : `Back to the game...`;
                this.bot.sendChat(`✅ ${player.name} has been restrained! ${followUp}`);
            }

            // Double penalty: apply the second bondage item immediately, unless
            // the first one already fully bound the player (nothing left to apply).
            if (player.pendingPenaltySteps > 0 && !becameFullyBound) {
                player.pendingPenaltySteps--;
                this.applyNextBondageItem(player);
                return;
            }
            player.pendingPenaltySteps = 0;

            if (becameFullyBound) {
                if (this.checkGameEndCondition()) return;

                if (this.currentTurnIndex >= this.turnOrder.length) {
                    this.currentTurnIndex = 0;
                }
                this.currentDiceMax = STARTING_DICE_MAX;
                this.resolveCurrentTurn();
            } else {
                this.currentTurnIndex = this.turnOrder.indexOf(player.memberNumber);
                this.currentDiceMax = STARTING_DICE_MAX;
                this.resolveCurrentTurn();
            }
        }, 500);
    }

    private checkGameEndCondition(): boolean {
        const activePlayers = [...this.players.values()].filter(p => !p.isFullyBound);

        if (activePlayers.length === 0) {
            this.recordGameCompletion(null);
            this.logMultiplayerGameEnd("all-bound");
            this.endGame();
            return true;
        } else if (activePlayers.length === 1 && this.players.size > 1) {
            const winner = activePlayers[0];
            this.bot.sendChat(`🏆 ${winner.name} wins! Everyone else is bound!`);
            this.recordGameCompletion(winner.memberNumber);
            this.logMultiplayerGameEnd("win", { winner: winner.name });
            this.applyEndGameLocks(winner);
            return true;
        }
        return false;
    }

    private endGame(): void {
        this.state = GameState.GameOver;
        this.bot.sendChat(`🎲 === GAME OVER === 🎲`);
        this.bot.sendChat(`All players are fully bound! Applying ${this.lockDurationMinutes} minute locks...`);
        this.applyEndGameLocks();
    }

    // winner: an unbound player whose items need stripping (their slots join
    // the same staggered burst as everyone else's lock application). Omitted
    // when every player is fully bound (endGame()) — nothing to strip.
    private applyEndGameLocks(winner?: Player): void {
        const boundPlayers = [...this.players.values()].filter(p => p.isFullyBound);
        const lockEndTime = Date.now() + (this.lockDurationMinutes * 60 * 1000);

        this.bot.sendChat(`🔒 Hold still everyone — applying everyone's end-game locks now, this'll take a few moments!`);

        // Shared stagger counter: every emit in this end-game burst (winner's
        // item removal + each bound player's lock application) gets its own
        // slot on one timeline, so the combined burst stays under the BC
        // server's per-second rate limit.
        let stagger = 0;

        if (winner && winner.bondageApplied > 0) {
            REMOVAL_SLOTS.forEach((group) => {
                const delay = stagger * END_GAME_EMIT_STAGGER_MS;
                setTimeout(() => {
                    this.removeSlotVerified(winner.memberNumber, group);
                }, delay);
                stagger++;
            });
        }

        for (const player of boundPlayers) {
            const pool = this.getEligibleOutfits(player.memberNumber);
            if (pool.length === 0 || !player.bondageOutfit || player.bondageOutfit.items.length === 0) {
                this.bot.sendChat("Sorry, no eligible outfits available — game cannot continue.");
                this.resetGame();
                return;
            }

            let lastEmitDelayMs = 0;
            for (let i = 0; i < player.bondageApplied; i++) {
                const item = player.bondageOutfit?.items[i];
                if (!item) continue;

                const delay = stagger * END_GAME_EMIT_STAGGER_MS;
                lastEmitDelayMs = delay;
                setTimeout(() => {
                    this.applyEndGameLockItem(player, item, lockEndTime);
                }, delay);
                stagger++;
            }

            this.bot.sendChat(`🔒 ${player.name} locked for ${this.lockDurationMinutes} minutes!`);
            this.scheduleLockReleaseCheck(player);
            this.sendLockVerificationWhisper(player, lockEndTime, lastEmitDelayMs);
        }

        // Pause before the next game starts, so players have time to confirm
        // their end-game locks released/applied correctly.
        this.gameCooldownUntil = Date.now() + GAME_COOLDOWN_MS;

        // Give the staggered burst time to land before resetGame() clears
        // player state.
        const resetDelay = stagger * END_GAME_EMIT_STAGGER_MS + 2000;
        setTimeout(() => {
            this.resetGame();
        }, resetDelay);
    }

    // ============================================================
    // LOCK VERIFICATION
    // ============================================================

    // Unused now that mid-game locking is disabled (see applyNextBondageItem).
    // Kept commented out rather than deleted in case we want to revert.
    // private verifyLockApplied(player: Player, group: string, itemName: string): void {
    //     setTimeout(() => {
    //         const current = this.itemStateCache.get(`${player.memberNumber}:${group}`);
    //         if (!current || current.Name !== itemName) return;
    //
    //         const isLocked = !!current.Property?.LockedBy;
    //         if (!isLocked) {
    //             log(`Lock did not apply for ${player.name} (#${player.memberNumber}) on ${group}/${itemName} — likely missing whitelist permission.`);
    //             this.notifyLockPermissionIssue(player);
    //         }
    //     }, 1000);
    // }

    // Applies one end-game lock item and verifies the timer/hint refresh
    // landed, retrying on failure.
    private applyEndGameLockItem(player: Player, item: BondageItem, lockEndTime: number, attempt: number = 1): void {
        this.bot.applyItem(
            player.memberNumber,
            item.group,
            item.name,
            item.color,
            this.buildLockedItemProperty(item, {
                hint: `Released in ${this.lockDurationMinutes} minutes`,
                removeItem: true,
                showTimer: true,
                removeTimer: lockEndTime
            })
        );
        this.verifyEndGameLockApplied(player, item, lockEndTime, attempt);
    }

    // Confirms an end-game lock actually carries the refreshed timer/hint —
    // items locked mid-game already have LockedBy set, so checking LockedBy
    // alone would pass even when the end-game timer refresh was dropped.
    private verifyEndGameLockApplied(player: Player, item: BondageItem, lockEndTime: number, attempt: number): void {
        setTimeout(() => {
            const current = this.itemStateCache.get(`${player.memberNumber}:${item.group}`);
            if (this.isEndGameLockRefreshed(current, item.name, lockEndTime)) return;

            if (!current || current.Name !== item.name || !current.Property?.LockedBy) {
                log(`Lock did not apply for ${player.name} (#${player.memberNumber}) on ${item.group}/${item.name} — likely missing whitelist permission.`);
                this.notifyLockPermissionIssue(player);
            } else {
                log(`Lock timer refresh missing for ${player.name} (#${player.memberNumber}) on ${item.group}/${item.name} (attempt ${attempt}/${MAX_END_GAME_LOCK_RETRIES}).`);
            }

            if (attempt >= MAX_END_GAME_LOCK_RETRIES) {
                log(`LOCK VERIFY FAILED: giving up on ${player.name} (#${player.memberNumber}) ${item.group}/${item.name} after ${attempt} attempts`);
                return;
            }

            const retry = () => this.applyEndGameLockItem(player, item, lockEndTime, attempt + 1);
            if (this.bot.isReconnecting()) {
                log(`Reconnect in progress — delaying lock retry for ${player.name} (#${player.memberNumber}) ${item.group}/${item.name} until reconnected.`);
                this.bot.onceConnected(retry);
            } else {
                retry();
            }
        }, LOCK_VERIFY_DELAY_MS);
    }

    // True only when the item is still locked AND carries the post-game
    // hint/timer (not just whatever lock it had mid-game).
    private isEndGameLockRefreshed(current: any, itemName: string, lockEndTime: number): boolean {
        if (!current || current.Name !== itemName) return false;
        if (!current.Property?.LockedBy) return false;
        if (!(current.Property?.Hint ?? "").includes("Released in")) return false;

        const removeTimer = current.Property?.RemoveTimer;
        return typeof removeTimer === "number" && Math.abs(removeTimer - lockEndTime) <= LOCK_TIMER_TOLERANCE_MS;
    }

    private notifyLockPermissionIssue(player: Player): void {
        if (this.lockPermissionWarned.has(player.memberNumber)) return;
        this.lockPermissionWarned.add(player.memberNumber);
        this.bot.whisper(player.memberNumber,
            `⚠️ I don't have permission to lock your restraints — your BC settings are restricting who can apply locks to you.\n` +
            `Please whitelist GameBot (#${this.bot.getMemberNumber()}): go to your character menu > Online Settings > Whitelist, and add me.\n` +
            `Your bondage items will still be applied, but won't be locked until you do.`
        );
    }

    private scheduleLockReleaseCheck(player: Player): void {
        const memberNumber = player.memberNumber;
        const name = player.name;
        const items = (player.bondageOutfit?.items ?? []).slice(0, player.bondageApplied).map(i => i.name);

        // Small buffer added so the BC server has time to process the RemoveTimer before we ask.
        const delay = (this.lockDurationMinutes * 60 * 1000) + 10000;

        setTimeout(() => {
            this.pendingLockConfirmations.set(memberNumber, { name, items });
            this.bot.whisper(memberNumber,
                `Your locks should have been released — did your bondage items come off? Reply !released or !stuck so we can track any issues.`
            );
        }, delay);
    }

    private handleLockReleaseConfirmation(memberNumber: number, released: boolean): void {
        const pending = this.pendingLockConfirmations.get(memberNumber);
        if (!pending) {
            this.bot.whisper(memberNumber, "No lock release confirmation is pending for you right now.");
            return;
        }
        this.pendingLockConfirmations.delete(memberNumber);

        const status = released ? "released" : "stuck";
        const timestamp = centralTimestamp();
        const itemList = pending.items.length > 0 ? pending.items.join(", ") : "(none)";
        const line = `[${timestamp}] ${pending.name} (#${memberNumber}): items=[${itemList}] status=${status}\n`;
        const filePath = path.join(__dirname, "..", "lock_release_log.txt");
        try {
            fs.appendFileSync(filePath, line, "utf8");
        } catch (err) {
            log("ERROR: Failed to write lock_release_log.txt: " + err);
        }

        if (released) {
            this.bot.whisper(memberNumber, "Great, glad everything came off! Thanks for confirming. 💕");
        } else {
            this.bot.whisper(memberNumber, "Thanks for letting us know — we've logged the stuck item(s) so we can investigate. Sorry about that!");
        }
    }

    // ============================================================
    // POST-LOCK VERIFICATION
    // ============================================================

    // Schedules the "did everything apply correctly?" whisper once a bound
    // player's lock-application setTimeouts have had time to land.
    private sendLockVerificationWhisper(player: Player, lockEndTime: number, lastEmitDelayMs: number): void {
        const memberNumber = player.memberNumber;
        const name = player.name;
        const bondageApplied = player.bondageApplied;
        const bondageOutfit = player.bondageOutfit;
        const lockDurationMinutes = this.lockDurationMinutes;

        const sendDelay = lastEmitDelayMs + 1500;
        setTimeout(() => {
            const timeout = setTimeout(() => {
                this.pendingLockVerifications.delete(memberNumber);
                log(`Lock verification: ${name} (#${memberNumber}) confirmed locks OK`);
            }, 60000);

            this.pendingLockVerifications.set(memberNumber, {
                name, bondageApplied, bondageOutfit, lockDurationMinutes, lockEndTime, timeout
            });

            this.bot.whisper(memberNumber, "Did you receive your bondage and locks correctly? Reply !yes or !no");
        }, sendDelay);
    }

    private handleLockVerificationYes(memberNumber: number): void {
        const pending = this.pendingLockVerifications.get(memberNumber);
        if (!pending) return;

        clearTimeout(pending.timeout);
        this.pendingLockVerifications.delete(memberNumber);
        log(`Lock verification: ${pending.name} (#${memberNumber}) confirmed locks OK`);
    }

    private handleLockVerificationNo(memberNumber: number): void {
        const pending = this.pendingLockVerifications.get(memberNumber);
        if (!pending) return;

        clearTimeout(pending.timeout);
        this.pendingLockVerifications.delete(memberNumber);

        const outfitJson = JSON.stringify(pending.bondageOutfit);
        const attemptedItems = (pending.bondageOutfit?.items ?? []).slice(0, pending.bondageApplied);
        const lockEndIso = new Date(pending.lockEndTime).toISOString();

        log(`LOCK FAILURE REPORTED: ${pending.name} (#${memberNumber}) bondageApplied=${pending.bondageApplied} outfit=${outfitJson} lockEnd=${lockEndIso}`);
        log(`Lock failure details for ${pending.name} (#${memberNumber}): lockDurationMinutes=${pending.lockDurationMinutes}, attemptedItems=${JSON.stringify(attemptedItems)}`);

        this.bot.whisper(memberNumber, "Got it — attempting to reapply your locks now.");

        const retryDelay = this.retryLockApplication(memberNumber, pending);

        setTimeout(() => {
            this.bot.whisper(memberNumber, "Locks reapplied. Please check again and let an admin know if there's still an issue.");
            log(`LOCK RETRY attempted for ${pending.name} (#${memberNumber})`);
        }, retryDelay);
    }

    // Reapplies and re-locks the items a player's bondage outfit had reached,
    // using the same Property shape applyEndGameLocks() uses. Returns the
    // delay (ms) after which all applyItem calls should have landed.
    private retryLockApplication(memberNumber: number, pending: PendingLockVerification): number {
        const outfit = pending.bondageOutfit;
        if (!outfit || pending.bondageApplied === 0) {
            return 500;
        }

        const newLockEndTime = Date.now() + (pending.lockDurationMinutes * 60 * 1000);

        for (let i = 0; i < pending.bondageApplied; i++) {
            const item = outfit.items[i];
            if (!item) continue;

            setTimeout(() => {
                this.bot.applyItem(
                    memberNumber,
                    item.group,
                    item.name,
                    item.color,
                    this.buildLockedItemProperty(item, {
                        hint: `Released in ${pending.lockDurationMinutes} minutes`,
                        removeItem: true,
                        showTimer: true,
                        removeTimer: newLockEndTime
                    })
                );
            }, i * 300);
        }

        return pending.bondageApplied * 300 + 500;
    }

    private resetGame(): void {
        if (this.state !== GameState.Idle && !this.gameEndLogged && this.players.size > 0) {
            this.logMultiplayerGameEnd("reset");
        }
        this.gameEndLogged = false;
        this.activeMultiplayer = false;
        this.writeBotState();

        this.state = GameState.Idle;
        this.players.clear();
        this.turnOrder = [];
        this.currentTurnIndex = 0;
        this.currentDiceMax = STARTING_DICE_MAX;
        this.safewordMember = null;
        this.bondagePhaseStarted = false;
        this.lockDurationMinutes = DEFAULT_LOCK_MINUTES;
        this.lockPermissionWarned.clear();
        for (const timer of this.pendingLateJoinConfirmations.values()) {
            clearTimeout(timer);
        }
        this.pendingLateJoinConfirmations.clear();
        for (const pending of this.pendingLockVerifications.values()) {
            clearTimeout(pending.timeout);
        }
        this.pendingLockVerifications.clear();
        this.clearCountdown();
        this.clearTurnTimer();

        this.bot.sendChat(`Game reset! Whisper !join to start a new game. 🎲`);
    }

    // ============================================================
    // GRACEFUL UPDATE / REBOOT
    // ============================================================

    private checkPendingUpdate(): boolean {
        const updatePath = path.join(__dirname, "..", "pending_update.txt");
        if (!fs.existsSync(updatePath)) return false;

        let note = "";
        try {
            note = fs.readFileSync(updatePath, "utf8").trim();
        } catch {
            note = "";
        }

        const message = note
            ? `⚙️ Update incoming (${note}) — StripDiceBot will be right back!`
            : `⚙️ Update incoming — StripDiceBot will be right back!`;

        this.bot.sendChat(message);
        log(`Pending update detected${note ? ` (${note})` : ""}. Restarting...`);

        setTimeout(() => {
            process.exit(0);
        }, 2000);

        return true;
    }

    // startDelay lets callers stagger removal across multiple players so their
    // slot-removal emits don't all flood the server at once.
    private removeAllItems(memberNumber: number, startDelay: number = 0): void {
        REMOVAL_SLOTS.forEach((group, index) => {
            setTimeout(() => {
                this.removeSlotVerified(memberNumber, group);
            }, startDelay + index * REMOVAL_SLOT_DELAY_MS);
        });
    }

    // Removes whatever is in a slot, unlocking it first if needed, then
    // re-checks the cached item state and retries until the slot is clear.
    private removeSlotVerified(memberNumber: number, group: string, attempt: number = 1): void {
        const current = this.itemStateCache.get(`${memberNumber}:${group}`);

        if (current?.Property?.LockedBy) {
            this.bot.applyItem(memberNumber, group, current.Name, current.Color, cleanDecodedProperty(current.Property));
            setTimeout(() => this.bot.removeItem(memberNumber, group), REMOVAL_UNLOCK_GAP_MS);
        } else {
            this.bot.removeItem(memberNumber, group);
        }

        setTimeout(() => {
            const after = this.itemStateCache.get(`${memberNumber}:${group}`);
            if (!after?.Name) return;

            if (attempt < MAX_REMOVAL_ATTEMPTS) {
                this.removeSlotVerified(memberNumber, group, attempt + 1);
            } else {
                log(`REMOVAL_FAILED: memberNumber=${memberNumber} group=${group} after ${MAX_REMOVAL_ATTEMPTS} attempts`);
                this.bot.whisper(memberNumber,
                    `⚠️ I wasn't able to remove your ${after.Name} automatically. You may need to remove it manually or ask someone to help.`
                );
            }
        }, REMOVAL_RETRY_DELAY_MS);
    }

    // !safeword / !free - removes every restraint from a player, verifying
    // each slot actually cleared and retrying with backoff so a dropped
    // removal emit doesn't leave the player stuck.
    private removeAllItemsSafeword(memberNumber: number, name: string, callerMemberNumber: number): void {
        REMOVAL_SLOTS.forEach((group, index) => {
            setTimeout(() => {
                this.removeItemSafewordVerified(memberNumber, name, group, callerMemberNumber);
            }, index * REMOVAL_SLOT_DELAY_MS);
        });
    }

    private removeItemSafewordVerified(
        memberNumber: number,
        name: string,
        group: string,
        callerMemberNumber: number,
        attempt: number = 1
    ): void {
        const current = this.itemStateCache.get(`${memberNumber}:${group}`);
        if (!current?.Name) return;

        if (current.Property?.LockedBy) {
            this.bot.applyItem(memberNumber, group, current.Name, current.Color, cleanDecodedProperty(current.Property));
            setTimeout(() => this.bot.removeItem(memberNumber, group), REMOVAL_UNLOCK_GAP_MS);
        } else {
            this.bot.removeItem(memberNumber, group);
        }

        setTimeout(() => {
            const after = this.itemStateCache.get(`${memberNumber}:${group}`);
            const stillOn = !!after?.Name && !!after?.Property?.LockedBy;
            if (!stillOn) return;

            if (attempt <= SAFEWORD_RETRY_DELAYS_MS.length) {
                log(`SAFEWORD RETRY: ${name} item ${group} still present after removal attempt ${attempt}`);
                setTimeout(() => {
                    this.removeItemSafewordVerified(memberNumber, name, group, callerMemberNumber, attempt + 1);
                }, SAFEWORD_RETRY_DELAYS_MS[attempt - 1]);
            } else {
                log(`SAFEWORD REMOVAL FAILED: ${name} (#${memberNumber}) item ${group} still present after 3 retries`);
                this.bot.whisper(callerMemberNumber,
                    `⚠️ Could not remove ${after?.Name} from ${name} after 3 attempts — you may need to remove it manually.`
                );
            }
        }, SAFEWORD_VERIFY_DELAY_MS);
    }

    // ============================================================
    // TURN TIMER
    // ============================================================

    // Default timeout grows by ~5s per prior miss this player has racked up,
    // giving them a little more leeway as warnings escalate.
    private startTurnTimer(ms?: number): void {
        this.clearTurnTimer();
        const player = this.getCurrentPlayer();
        if (!player) return;

        const timeout = ms ?? (30000 + player.timeoutCount * 5000);
        this.turnTimer = setTimeout(() => {
            if (this.state === GameState.WaitingRemove) {
                this.handleRemoveTimeout(player);
            } else {
                this.handleTurnTimeout(player);
            }
        }, timeout);
    }

    private clearTurnTimer(): void {
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
            this.turnTimer = null;
        }
    }

    private handleRemoveTimeout(player: Player): void {
        this.bot.whisper(player.memberNumber,
            `Already removed it? !removed to continue.`
        );
        this.startTurnTimer(60000);
    }

    private handleTurnTimeout(player: Player): void {
        if (!player.timeoutWarned) {
            player.timeoutWarned = true;
            this.bot.sendChat(`⏰ ${player.name}, !roll or you'll be skipped!`);
            this.bot.whisper(player.memberNumber, `Still your turn — !roll in chat or you'll be skipped.`);
            this.startTurnTimer(30000 + (player.timeoutCount + 1) * 5000);
        } else {
            player.timeoutWarned = false;
            player.timeoutCount++;
            this.bot.sendChat(`⏭️ ${player.name} was skipped for inactivity.`);

            if (player.timeoutCount >= 2) {
                player.timeoutCount = 0;
                this.handleLoss(player);
            } else {
                this.advanceTurn();
            }
        }
    }

    // ============================================================
    // HELPERS
    // ============================================================

    private getCurrentPlayer(): Player | undefined {
        if (this.turnOrder.length === 0) return undefined;
        const memberNumber = this.turnOrder[this.currentTurnIndex];
        return this.players.get(memberNumber);
    }

    public getNameFor(memberNumber: number): string | undefined {
        return this.players.get(memberNumber)?.name ?? this.nameCache.get(memberNumber);
    }

    private getPlayerName(memberNumber: number): string {
        return this.getNameFor(memberNumber) ?? `Player #${memberNumber}`;
    }

    private getBondageOutfitName(outfit: BondageOutfit): string {
        return outfit.name;
    }

    // TODO: Once a moderation/selection process exists, mix player-submitted
    // outfits from outfit_suggestions.json (see loadOutfitSuggestions) into
    // the eligible pool below.
    //
    // Players who have set their pronouns to HeHim get outfits without
    // breast-targeted items (e.g. a chastity bra), falling back to the full
    // pool if no such outfit is defined.
    private getEligibleOutfits(memberNumber: number): BondageOutfit[] {
        if (this.pronounsCache.get(memberNumber) === "HeHim") {
            const maleFriendly = BONDAGE_OUTFITS.filter(o => !o.items.some(i => i.group === "ItemBreast"));
            if (maleFriendly.length > 0) return maleFriendly;
        }
        return BONDAGE_OUTFITS;
    }

    private shuffleArray<T>(array: T[]): void {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }
}