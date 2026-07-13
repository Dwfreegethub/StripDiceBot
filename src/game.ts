import { BCConnection } from "./connection";
import { log, centralTimestamp } from "./logger";
import * as fs from "fs";
import * as path from "path";
import * as LZString from "lz-string";
import { pickRandomMessage, formatStreakMessage, SIXTY_NINE_MESSAGES } from "./messages";

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
const TEST_MODE = false;
const TEST_PASSWORD = "TEST1234";
const DEFAULT_LOCK_MINUTES = 10;
const JOIN_CONFIRMATION_WINDOW_MS = 60 * 1000;
const STARTING_DICE_MAX = 100;

// How long a missed player has to roll during their end-of-round second chance.
const SECOND_CHANCE_TIMER_MS = 30 * 1000;

// How long a mid-game join pause can run before the game resumes without the
// joining player (they can still join the rotation later via !ready).
const JOIN_PAUSE_TIMEOUT_MS = 60 * 1000;

// Minimum time a player who left mid-game gets before they're actually
// removed, even if their 2-round skip allowance runs out sooner (e.g. other
// players resolve their turns quickly).
const MIN_RETURN_WINDOW_MS = 90 * 1000;

// How long players get to answer the pre-game toys consent question (or a
// late joiner has to answer the same question) before being treated as "no".
const TOYS_CONSENT_TIMEOUT_MS = 60 * 1000;

// How long an admin has to confirm a proxied !feedback (submitted on behalf
// of another room member) before it's auto-cancelled.
const ADMIN_FEEDBACK_PROXY_TIMEOUT_MS = 60 * 1000;

// ============================================================
// SOLO GAME MODE
// ============================================================
const SOLO_BRACKET_MIN = 3;
const SOLO_BRACKET_MAX = 7; // 7 = CLOTHING_SLOTS.length (shoes, socks, jacket, top, bottom, bra, panties)
const SOLO_DEFAULT_TARGET = 8; // Used when no daily record exists yet for a bracket
const SOLO_BASE_PENALTY_MINUTES = 5;
const SOLO_DICE_MAX = 100;
const SOLO_INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000;
// How long to wait for the player to close their Wardrobe (detected via
// handleWardrobe) before nudging them with the !removed fallback.
const SOLO_REMOVAL_REMINDER_MS = 60 * 1000;
// Brief pause after wardrobe-close before applying the end-of-game bondage penalty.
const SOLO_BONDAGE_DELAY_MS = 10 * 1000;

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
    "ItemMouth2",
    "ItemMouth3",
    "ItemHead",
    "ItemHood",
    "ItemNipples",
];
const REMOVAL_SLOT_DELAY_MS = 1000; // Stagger between each slot's removal attempt
const REMOVAL_UNLOCK_GAP_MS = 750; // Gap between unlocking an item and removing it
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
const LOCK_VERIFY_DELAY_MS = 1500;
const MAX_END_GAME_LOCK_RETRIES = 2;

// ============================================================
// END-GAME LOCK BURST PACING - every emit in the end-game burst (winner's
// item removal + each bound player's lock application) shares one staggered
// timeline so the combined burst stays well under the BC server's per-second
// rate limit. Baseline ~125ms (~8/sec, 40% of the 20/sec limit) x1.5 safety
// margin.
// ============================================================
const END_GAME_EMIT_STAGGER_MS = 1000;

// Pause between games so players have time to confirm their end-game locks
// released/applied correctly before the next bondage phase begins.
const GAME_COOLDOWN_MS = 5 * 60 * 1000;

// ============================================================
// CLOTHING SLOTS - ordered loss sequence
// ============================================================
const CLOTHING_SLOTS = ["shoes", "socks", "jacket", "top", "bottom", "bra", "panties"];

const CLOTHING_ALIASES: Record<string, string> = {
    // jacket
    "coat": "jacket", "cardigan": "jacket", "blazer": "jacket",
    // top
    "shirt": "top", "tshirt": "top", "t-shirt": "top", "blouse": "top",
    "tank": "top", "tanktop": "top", "tank-top": "top", "sweater": "top",
    "hoodie": "top", "dress": "top", "corset": "top",
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
// PLAYER-PICK BONDAGE MODE - a designated picker chooses items
// slot-by-slot from the BC catalog instead of a preset outfit.
// ============================================================
type BondageMode = "outfit" | "player-pick";

// Picker-facing display names mapped to BC item groups.
const PICK_SLOTS: { display: string; group: string }[] = [
    { display: "Arms", group: "ItemArms" },
    { display: "Legs", group: "ItemLegs" },
    { display: "Feet", group: "ItemFeet" },
    { display: "Torso", group: "ItemTorso" },
    { display: "Torso (upper)", group: "ItemTorso2" },
    { display: "Hands", group: "ItemHands" },
    { display: "Head", group: "ItemHead" },
    { display: "Hood", group: "ItemHood" },
    { display: "Neck", group: "ItemNeck" },
    { display: "Mouth", group: "ItemMouth" },
    { display: "Boots", group: "ItemBoots" },
    { display: "Nipples", group: "ItemNipples" },
    { display: "Breast", group: "ItemBreast" },
    { display: "Pelvis", group: "ItemPelvis" },
];

// Consent tiers. Tier 1 is on by default; tier 2 requires explicit consent.
// Tier 3 (Vulva, Butt) additionally requires the higher-stakes game mode,
// which is not built yet — the constant exists as a code hook only.
const TIER1_SLOT_GROUPS = [
    "ItemArms", "ItemLegs", "ItemFeet", "ItemTorso", "ItemTorso2",
    "ItemHands", "ItemHead", "ItemHood", "ItemNeck", "ItemMouth", "ItemBoots",
];
const TIER2_SLOT_GROUPS = ["ItemNipples", "ItemBreast", "ItemPelvis"];
const TIER3_SLOT_GROUPS = ["ItemVulva", "ItemButt"]; // code hook — not selectable yet

// ItemMouth2/ItemMouth3 are overflow layers of Mouth: used automatically when
// ItemMouth is already filled, never exposed as separate picker options.
const MOUTH_OVERFLOW_GROUPS = ["ItemMouth", "ItemMouth2", "ItemMouth3"];

// Consent-answer token -> BC groups it grants. "torso" covers both layers.
const CONSENT_TOKEN_GROUPS: Record<string, string[]> = {
    arms: ["ItemArms"],
    legs: ["ItemLegs"],
    feet: ["ItemFeet"],
    torso: ["ItemTorso", "ItemTorso2"],
    hands: ["ItemHands"],
    head: ["ItemHead"],
    hood: ["ItemHood"],
    neck: ["ItemNeck"],
    mouth: ["ItemMouth"],
    boots: ["ItemBoots"],
    nipples: ["ItemNipples"],
    breast: ["ItemBreast"],
    breasts: ["ItemBreast"],
    pelvis: ["ItemPelvis"],
};

// Game ends for a player-pick player once this many items are applied.
// 7 = median item count of the outfits in outfits.json (6/8/7/8/6).
const DEFAULT_BONDAGE_ITEM_LIMIT = 7;
// How many popular items to list per slot (plus one random wildcard).
const PICK_LIST_TOP_N = 9;
// Minimum distinct areas a player-pick player must consent to (Mouth counts
// as one area even though it holds up to 3 gag layers).
const MIN_CONSENT_AREAS = 6;
const BONDAGE_MODE_TIMEOUT_MS = 60 * 1000;   // mode question window; unanswered = outfit
const PICKER_RESPONSE_TIMEOUT_MS = 60 * 1000; // picker slot/item window; then bot picks randomly
const VETO_TIMEOUT_MS = 30 * 1000;            // target's veto window; then auto-accept

// Full BC item catalog (group -> item names), shared read-only reference that
// lives one level above the repo. Missing/invalid file disables player-pick
// mode (everyone silently gets outfit mode) rather than crashing the bot.
function loadBcItemCatalog(): Map<string, string[]> {
    const catalog = new Map<string, string[]>();
    try {
        const filePath = path.join(__dirname, "..", "..", "bc_items.json");
        const raw = fs.readFileSync(filePath, "utf8");
        const data: { group: string; items: string[] }[] = JSON.parse(raw);
        for (const entry of data) {
            if (entry?.group && Array.isArray(entry.items)) {
                catalog.set(entry.group, entry.items);
            }
        }
    } catch (err) {
        log(`WARNING: Could not load bc_items.json — player-pick bondage mode disabled: ${err}`);
    }
    return catalog;
}

const BC_ITEM_CATALOG: Map<string, string[]> = loadBcItemCatalog();

// One in-flight player-pick selection. Only one can be active at a time —
// the game sits in WaitingBondage until it resolves.
interface PendingBondagePick {
    pickerNumber: number;
    targetNumber: number;
    stage: "slot" | "item" | "veto";
    slotDisplay: string | null;  // picker-facing name, e.g. "Mouth"
    slotGroup: string | null;    // actual BC group applied, e.g. "ItemMouth2"
    options: string[];           // current numbered item list
    chosenItem: string | null;
    vetoedItems: { group: string; item: string }[]; // vetoed during this pick session, scoped per group
    timer: NodeJS.Timeout | null; // picker-response or veto timer
}

// ============================================================
// ITEM SETTINGS LIBRARY - learned per-item configurations.
// Many typed items (cuffs especially) are non-restraining in their default
// mode; the mode lives in Property (TypeRecord + Effect). The bot learns
// configurations by watching players adjust items in the room, tracks how
// often each distinct configuration is seen, and applies the most popular
// one when a picked item lands. Seeded from outfits.json properties.
// ============================================================
interface ItemSettingVariant {
    property: any;
    count: number;
}
type ItemSettingsLibrary = Record<string, ItemSettingVariant[]>; // "Group:ItemName" -> observed configs

const MAX_SETTING_VARIANTS_PER_ITEM = 10; // keep the most popular N configs per item
// How to choose among learned settings when applying a picked item:
// "popular" = most-seen config (ties random); "random" = any learned config;
// "weighted" = random, biased by popularity.
const ITEM_SETTING_STRATEGY: "popular" | "random" | "weighted" = "popular";

// A property is worth learning if it selects a mode (TypeRecord) or carries
// active effects — bare default-mode applications teach us nothing.
function isLearnableProperty(property: any): boolean {
    if (!property || typeof property !== "object") return false;
    if (property.TypeRecord && typeof property.TypeRecord === "object" && Object.keys(property.TypeRecord).length > 0) return true;
    return Array.isArray(property.Effect) && property.Effect.length > 0;
}

// Stable JSON (sorted keys, recursive) so identical configs dedupe regardless
// of key order in the incoming payload.
function canonicalJson(value: any): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value && typeof value === "object") {
        const keys = Object.keys(value).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function deepClone<T>(value: T): T {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

// ============================================================
// GAME STATES
// ============================================================
enum GameState {
    Idle,           // No game running, waiting for players to join
    TeamSetup,      // Team mode lobby: picking team size and !join team1/team2
    Registration,   // Players joining, declaring clothing
    Countdown,      // All players joined, 30 second countdown
    Rolling,        // Active game, waiting for current player to roll
    WaitingRemove,  // Player lost, waiting for !removed
    WaitingBondage, // Player naked, bot applying bondage
    SafewordPause,  // A player called safeword, waiting for !continue or timeout
    PausedForJoin,  // Briefly paused so a mid-game joiner can get into rotation
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
    missedTurnPending: boolean;  // Missed regular turn; second chance not yet given
    missedSecondChance: boolean; // Missed second chance too; penalty fires on next regular turn
    ready: boolean;             // Has declared clothing and said !ready
    midGameJoin: boolean;       // Joined while a game was already in progress
    clothingQuestionIndex: number | null; // Position in guided !wearing Q&A, null if not active
    pendingClothing: string[];  // Items collected so far during guided Q&A
    bondageOutfit: BondageOutfit | null; // Outfit assigned once this player starts receiving bondage
    pendingReturn: boolean;     // Left the room mid-game; in grace period to return
    leaveRoundsRemaining: number; // Rounds left to return before removal, while pendingReturn
    leaveTime: number | null;   // Date.now() when they left; gates removal behind a 90s minimum (MIN_RETURN_WINDOW_MS), reset on rejoin
    freePass: boolean;          // Rolled 100 on the D100 - skips their next roll automatically
    pendingPenaltySteps: number; // Extra penalty steps still owed from a double-penalty (rolled 1 on the D100)
    removalWarned: boolean;      // First 15s expired without response — second 10s window now active
    pendingRemovalKick: boolean; // Both windows missed — next turn gives 15s before removal from game
    toysConsent: boolean | null; // null = unanswered, true/false = answered the pre-game toys question
    bondageMode: BondageMode | null; // null = unanswered pre-game mode question; resolved to "outfit" on timeout
    allowedSlots: string[];      // BC group names this player consented to for player-pick mode
    appliedBondageItems: { slot: string; item: string }[]; // player-pick selections applied this game
    lastLossSeq: number;         // lossSeqCounter value when they last rolled a 1; 0 = never lost this game
    teamId: 1 | 2 | null;        // which team in team mode; null outside team mode
    isGhost: boolean;            // true = auto-rolls 1 every turn (safeworded out but still counted for team win condition)
    ghostReason?: "safeword" | "disconnect";
    // Appearance.length captured (see markAwaitingRemoval) the moment this
    // player was told to remove an item — null when no removal is
    // outstanding. Compared against fresh ChatRoomSyncSingle snapshots in
    // onSyncSingle to auto-detect the removal the instant BC confirms it,
    // instead of waiting on !removed or a wardrobe close/open pair.
    pendingRemovalBaselineCount: number | null;
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

// Tracks an end-game lock apply awaiting confirmation. BC's server never
// echoes a ChatRoomSyncItem back to the sender for their own item updates,
// so silence during the verification window means the lock was accepted.
// A ChatRoomSyncSingle arriving for this member+group during the window,
// showing the lock missing, means the server rejected it.
interface PendingLockApplyCheck {
    itemName: string;
    onResult: (rejected: boolean) => void;
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
    // ISO timestamp of the last time this player was sent the bundled
    // "we're reviewing it" ack. A new ack is only sent if a reviewing/pending/
    // researching/testing item with a newer timestamp arrives.
    reviewingAckDate?: string;
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

// Statuses that are still "in progress" - covered by the single bundled
// "we're reviewing it" ack rather than a per-item whisper.
const REVIEWING_FEEDBACK_STATUSES: ReadonlySet<FeedbackItemStatus> = new Set([
    "pending",
    "reviewing",
    "researching",
    "testing",
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
    isTeamMode?: boolean;
    teamSize?: 2 | 3;
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
// Letters-only (no digits) — BC's TimerPasswordPadlock appears to
// reject/silently fail to save a password that starts with a digit,
// confirmed via live testing. Nobody's ever shown this password (it's
// never whispered to a player, only logged), so it doesn't need to be
// memorable — just needs to actually save.
function generatePassword(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
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
    // Pending 30-second lock-time vote, between a game-over/win being
    // detected and the actual end-game locks going on (see applyEndGameLocks/
    // startEndGameLockVote/finalizeEndGameLockVote). Bound players about to
    // be locked get one chance each to nudge suggestedMinutes ±5 min before
    // it's applied; a missing vote at finalization counts as accept.
    private pendingLockTimeVote: {
        winners: Player[] | undefined;
        boundPlayers: Player[];
        // The greater of lockDurationMinutes (host's pre-game setting, now
        // treated as a floor) or playerCount + 5 — the number actually
        // whispered to voters and adjusted by the vote (see
        // startEndGameLockVote). Kept separate from lockDurationMinutes so
        // the vote always starts from this computed baseline, not whatever
        // lockDurationMinutes was left at by a previous round's vote.
        suggestedMinutes: number;
        votes: Map<number, 1 | 2 | 3>;
        timeout: NodeJS.Timeout;
    } | null = null;
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
    private pendingYesNoJoin: Map<number, { name: string; inlineMin: number | null; inlineMax: number | null }> = new Map();
    private pendingLateJoinConfirmations: Map<number, NodeJS.Timeout> = new Map();
    // Admin proxy-feedback confirmation, keyed by admin member number. Set
    // when an admin runs "!feedback <room member name> <text>" so a follow-up
    // yes/no whisper can confirm logging it under the target player's name.
    private pendingAdminFeedbackProxy: Map<number, { targetMemberNumber: number; targetName: string; text: string; timeout: NodeJS.Timeout }> = new Map();
    // Deferred removal timers for players whose 2-round grace period expired
    // before the 90s minimum return window did. Cleared on rejoin or once the
    // timer fires and actually removes them.
    private pendingLeaveRemovalTimers: Map<number, NodeJS.Timeout> = new Map();
    private itemStateCache: Map<string, any> = new Map();
    private pendingLockApplyChecks: Map<string, PendingLockApplyCheck> = new Map();
    private feedbackStatus: Record<string, FeedbackStatusEntry> = {};
    private feedbackNotified: Set<number> = new Set();
    private readonly feedbackStatusPath = path.join(__dirname, "..", "feedback_status.json");
    private playerRecords: Record<string, PlayerRecord> = {};
    private readonly playerRecordsPath = path.join(__dirname, "..", "players.json");
    private feedbackMemberNumbers: Set<number> = new Set();
    private pendingFeedbackRequest: Set<number> = new Set();
    private readonly outfitSuggestionsPath = path.join(__dirname, "..", "outfit_suggestions.json");
    private soloGames: Map<number, SoloGameState> = new Map();
    private pendingSoloSetup: Map<number, { mode: SoloMode; name: string; clothingQuestionIndex: number; pendingClothing: string[] }> = new Map();
    private readonly soloRecordsPath = path.join(__dirname, "..", "solo_records.json");
    private readonly gameLogPath = path.join(__dirname, "..", "game_log.json");
    private readonly botStatePath = path.join(__dirname, "..", "bot_state.json");
    private readonly gameCountsPath = path.join(__dirname, "..", "game_counts.json");
    private activeMultiplayer: boolean = false;
    private gameStartTime: string | null = null;
    private gameEndLogged: boolean = false;
    private reconnectPending: boolean = false;
    private gameCooldownUntil: number = 0;
    private pendingTurnTimerBonusMs: number = 0;
    private pendingJoinPauses: { memberNumber: number; name: string }[] = [];
    // Joiners currently part of the active pause window who haven't resolved yet
    // (member number -> name). The pause ends when this is empty or the timer fires.
    private joinPauseActive: Map<number, string> = new Map();
    // Joiners who successfully readied up during the active pause window.
    private joinPauseJoined: { memberNumber: number; name: string }[] = [];
    private joinPauseTimer: NodeJS.Timeout | null = null;
    private pendingTurnResume: (() => void) | null = null;
    private characterDataCache: Map<number, any> = new Map();
    private botGameVersion: string | null = null;
    private debugNextRoll: number | null = null;
    // Bonus flavor-commentary tracking (streak comments, 69 easter egg) —
    // purely cosmetic, doesn't affect game state/scoring/flow.
    private lastRollValue: number | null = null;
    private rollStreakCount: number = 0;
    private totalRollsThisGame: number = 0;
    private secondChanceQueue: { memberNumber: number; countdown: number }[] = [];
    private activeSecondChance: number | null = null;
    private secondChanceTimer: NodeJS.Timeout | null = null;
    private minPlayers: number = 2;
    private maxPlayers: number = 6;
    private lobbyOpen: boolean = false;
    private hostMemberNumber: number | null = null;
    private awaitingMinMaxReply: boolean = false;
    // Toys consent: whether the winner may add toys/touch players at the end
    // of the current game, decided once all ready players answer (or time out).
    private toysAllowed: boolean = false;
    private awaitingToysConsent: boolean = false;
    private toysConsentTimer: NodeJS.Timeout | null = null;
    // Mid-game joiners being asked the toys consent question before their join
    // completes (only used when toysAllowed is true for the current game).
    private pendingLateJoinToysConsent: Map<number, { onAccept: () => void; onDecline: () => void; timeout: NodeJS.Timeout }> = new Map();
    // Player-pick bondage mode state
    private lastRoundLoser: number | null = null;      // memberNumber of the most recent round loser
    private lossSeqCounter: number = 0;                // increments on every loss; stamps each loser's lastLossSeq
    private pickerHistory: number[] = [];              // memberNumbers who have picked this game
    private allowVeto: boolean = true;                 // false reserved for higher-stakes modes (code hook)
    private bondageItemLimit: number = DEFAULT_BONDAGE_ITEM_LIMIT;
    private gameBondageMode: "outfit" | "player-pick" | "mixed" = "outfit";
    private awaitingBondageMode: boolean = false;
    private bondageModeTimer: NodeJS.Timeout | null = null;
    // Late joiners (mid-game join once clothing is confirmed, or naked join
    // after bondage phase started) are asked the same mode question
    // individually, since the group question has already resolved.
    private awaitingLateBondageMode: Set<number> = new Set();
    private lateBondageModeTimers: Map<number, NodeJS.Timeout> = new Map();
    private awaitingSlotConsent: boolean = false;
    private slotConsentTimer: NodeJS.Timeout | null = null;
    private pendingBondagePick: PendingBondagePick | null = null;
    private pendingSlotConsent: Set<number> = new Set(); // players yet to answer the slot-consent whisper
    private bondageUsage: Record<string, Record<string, number>> = {};
    private readonly bondageUsagePath = path.join(__dirname, "..", "bondage_usage.json");
    private readonly outfitCandidatesPath = path.join(__dirname, "..", "outfit_candidates.json");
    private itemSettings: ItemSettingsLibrary = {};
    private readonly itemSettingsPath = path.join(__dirname, "..", "item_settings.json");

    // ============================================================
    // TEAM MODE (2v2 / 3v3)
    // ============================================================
    private isTeamMode: boolean = false;
    private teamSize: 2 | 3 = 2;
    private teamRoster: { 1: number[]; 2: number[] } = { 1: [], 2: [] };
    private awaitingTeamSizeReply: boolean = false;
    // Parity vote ("keep ghost rolls or drop them?") fired when a safeword
    // brings both teams' active-player counts back to equal.
    private awaitingTeamParityVote: boolean = false;
    private teamParityResponses: Map<number, "keep" | "drop"> = new Map();
    private teamParityVoters: Set<number> = new Set(); // active players asked this round
    private teamParityTimer: NodeJS.Timeout | null = null;

    constructor(bot: BCConnection) {
        this.bot = bot;
        this.loadBondageUsage();
        this.loadItemSettings();
        this.seedItemSettingsFromOutfits();
        this.loadFeedbackStatus();
        this.feedbackMemberNumbers = this.loadFeedbackMemberNumbers();
        this.loadPlayerRecords();
        this.pruneGameLog();
    }

    // ============================================================
    // PUBLIC - room events
    // ============================================================

    // Caches character data for permission pre-flight checks. Also captures
    // the bot's own GameVersion the first time it appears in a sync.
    private cacheCharacterData(character: any): void {
        const memberNumber = character?.MemberNumber;
        if (typeof memberNumber !== "number") return;
        this.characterDataCache.set(memberNumber, character);
        if (memberNumber === this.bot.getMemberNumber() && !this.botGameVersion) {
            const v = character?.OnlineSharedSettings?.GameVersion;
            if (v) this.botGameVersion = v;
        }
    }

    public onMemberJoin(memberNumber: number, name: string, character?: any): void {
        this.roomMembers.add(memberNumber);
        this.nameCache.set(memberNumber, name);
        const pronouns = extractPronouns(character);
        if (pronouns) this.pronounsCache.set(memberNumber, pronouns);
        this.seedItemStateCacheFromCharacter(character);
        if (character) this.cacheCharacterData(character);
        if (memberNumber === this.bot.getMemberNumber()) return;

        const player = this.players.get(memberNumber);
        if (player?.pendingReturn) {
            player.pendingReturn = false;
            player.leaveRoundsRemaining = 0;
            player.leaveTime = null;
            player.name = name;
            this.cancelPendingLeaveRemoval(memberNumber);
            this.bot.sendChat(`${name} is back! They've been added back to the turn order.`);
            return;
        }

        this.recordPlayerSeen(memberNumber, name);
        this.sendWelcomeWhisper(memberNumber, name);
        this.notifyFeedbackStatus(memberNumber, name);
    }

    public onMemberLeave(memberNumber: number): void {
        this.roomMembers.delete(memberNumber);
        this.pendingYesNoJoin.delete(memberNumber);
        this.cleanupSoloOnLeave(memberNumber);
        if (this.state === GameState.Idle || !this.players.has(memberNumber)) return;

        const player = this.players.get(memberNumber)!;

        if (player.midGameJoin) {
            this.pendingJoinPauses = this.pendingJoinPauses.filter(p => p.memberNumber !== memberNumber);
            this.players.delete(memberNumber);

            if (this.joinPauseActive.has(memberNumber)) {
                this.joinPauseActive.delete(memberNumber);
                this.bot.sendChat(`${player.name} left before joining.`);
                if (this.joinPauseActive.size === 0) {
                    this.resumeFromJoinPause();
                }
            } else {
                this.bot.sendChat(`${player.name} left before joining the rotation.`);
            }
            return;
        }

        const activeGameplay = this.state === GameState.Rolling ||
            this.state === GameState.WaitingRemove ||
            this.state === GameState.WaitingBondage;

        if (activeGameplay) {
            player.pendingReturn = true;
            player.leaveRoundsRemaining = 2;
            player.leaveTime = Date.now();
            player.missedTurnPending = false;
            player.missedSecondChance = false;
            this.secondChanceQueue = this.secondChanceQueue.filter(sc => sc.memberNumber !== memberNumber);
            if (this.activeSecondChance === memberNumber) {
                this.clearSecondChanceTimer();
                this.activeSecondChance = null;
            }
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
                this.seedItemStateCacheFromCharacter(char);
                this.cacheCharacterData(char);
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
            player.leaveTime = Date.now();
            player.missedTurnPending = false;
            player.missedSecondChance = false;
            this.secondChanceQueue = this.secondChanceQueue.filter(sc => sc.memberNumber !== memberNumber);
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
        const item = data?.Item;
        const target = item?.Target;
        if (typeof target !== "number" || !item?.Group) return;
        this.itemStateCache.set(`${target}:${item.Group}`, item);

        // Learn item configurations from how players set items up in the
        // room (many adjust the mode right after putting an item on). Skip
        // the bot's own applies so learned settings never self-reinforce.
        if (data.Source !== this.bot.getMemberNumber() &&
            typeof item.Group === "string" && item.Group.startsWith("Item") &&
            item.Name && item.Property) {
            this.recordItemSetting(item.Group, item.Name, item.Property, { increment: true, save: true });
        }
    }

    // BC sends ChatRoomSyncSingle as a full appearance snapshot for one
    // character whenever the server corrects their appearance — including
    // when it rejects an item update the bot just sent (the bot's own
    // ChatRoomCharacterItemUpdate emits never come back as ChatRoomSyncItem,
    // so this is the only signal that a lock apply was rejected).
    public onSyncSingle(data: any): void {
        const character = data?.Character;
        const memberNumber = character?.MemberNumber;
        if (typeof memberNumber !== "number" || !Array.isArray(character.Appearance)) return;

        this.seedItemStateCacheFromCharacter(character);
        this.cacheCharacterData(character);

        // Auto-detect a pending removal the instant BC confirms it, instead
        // of relying solely on !removed or a wardrobe open/close pair —
        // any drop below the Appearance count captured when the removal was
        // requested (see markAwaitingRemoval) counts as done, regardless of
        // whether it's currently this player's active turn (handleRemoved
        // credits it immediately either way — see its isBankedEarly path).
        const removalPlayer = this.players.get(memberNumber);
        if (removalPlayer && removalPlayer.pendingRemovalBaselineCount !== null &&
            character.Appearance.length < removalPlayer.pendingRemovalBaselineCount) {
            this.handleRemoved(memberNumber, removalPlayer.name);
        }

        for (const item of character.Appearance) {
            if (!item?.Group) continue;

            const key = `${memberNumber}:${item.Group}`;
            const pending = this.pendingLockApplyChecks.get(key);
            if (!pending) continue;

            const lockedByBot = item.Property?.LockedBy === "TimerPasswordPadlock" &&
                item.Property?.LockMemberNumber === this.bot.getMemberNumber();
            const stillApplied = item.Name === pending.itemName && lockedByBot;

            if (!stillApplied) {
                pending.onResult(true);
            }
        }
    }

    // Seeds itemStateCache with a character's full appearance, giving a
    // ground-truth baseline for removal/lock checks. Called from room sync,
    // member join, and ChatRoomSyncSingle handlers.
    private seedItemStateCacheFromCharacter(character: any): void {
        const memberNumber = character?.MemberNumber;
        if (typeof memberNumber !== "number" || !Array.isArray(character.Appearance)) return;

        const presentGroups = new Set<string>();
        for (const item of character.Appearance) {
            if (!item?.Group) continue;
            this.itemStateCache.set(`${memberNumber}:${item.Group}`, item);
            presentGroups.add(item.Group);
        }

        // ChatRoomSyncSingle is a complete snapshot — BC omits empty item slots
        // entirely rather than including them with Name:"". Clear stale cache entries
        // for any removal slot absent from this sync so verification sees them as gone.
        for (const group of REMOVAL_SLOTS) {
            if (!presentGroups.has(group)) {
                this.itemStateCache.delete(`${memberNumber}:${group}`);
            }
        }
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
        "!r": { handler: (mn, name) => this.handleRoll(mn, name) },
        "!rool": { handler: (mn, name) => this.handleRoll(mn, name) },
        "!rol": { handler: (mn, name) => this.handleRoll(mn, name) },
        "!oll": { handler: (mn, name) => this.handleRoll(mn, name) },
        "!teamgame": { handler: (mn, name) => this.handleTeamGame(mn, name) },
        "!teams": { handler: (mn) => this.handleTeams(mn) },
        "!join": { handler: (mn, name, _msg, message) => this.handleJoin(mn, name, message), prefix: true },
        "!start": { handler: (mn) => this.handleStart(mn) },
        "!cancel": { handler: (mn) => this.handleCancel(mn) },
        "!wearing": { handler: (mn) => this.startGuidedClothing(mn) },
        "!wearing ": { handler: (mn, _name, _msg, message) => this.handleWearing(mn, message), prefix: true },
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
        "!feedback": { handler: (mn) => this.handleFeedbackPrompt(mn), whisperOnly: true },
        "!outfit ": { handler: (mn, name, _msg, message) => this.handleOutfitSubmission(mn, name, message), prefix: true },
        "!outfits": { handler: (mn) => this.handleOutfitsList(mn), whisperOnly: true },
        "!safeword": { handler: (mn, name) => this.handleSafeword(mn, name) },
        "!reset": { handler: (mn) => this.handleReset(mn), whisperOnly: true },
        "!released": { handler: (mn) => this.handleLockReleaseConfirmation(mn, true) },
        "!stuck": { handler: (mn) => this.handleLockReleaseConfirmation(mn, false) },
        "!yes": { handler: (mn) => this.handleLockVerificationYes(mn) },
        "!no": { handler: (mn) => this.handleLockVerificationNo(mn) },
        "!help player": { handler: (mn) => this.handleHelpPlayer(mn) },
        "!help solo": { handler: (mn) => this.handleHelpSolo(mn) },
        "!help team": { handler: (mn) => this.handleHelpTeam(mn) },
        "!help admin": { handler: (mn) => this.handleHelpAdmin(mn) },
        "!help": { handler: (mn) => this.handleHelp(mn) },
        "!about": { handler: (mn) => this.handleAbout(mn) },
        "!solo race": { handler: (mn, name) => this.handleSoloStart(mn, name, "race"), whisperOnly: true },
        "!solo survive": { handler: (mn, name) => this.handleSoloStart(mn, name, "survive"), whisperOnly: true },
        "!solo": { handler: (mn) => this.bot.whisper(mn, "Usage: !solo race or !solo survive"), whisperOnly: true },
        "!solo_reset ": { handler: (mn, _name, _msg, message) => this.handleSoloReset(mn, message), whisperOnly: true, prefix: true },
        "!solo_reset": { handler: (mn) => this.handleSoloReset(mn, ""), whisperOnly: true },
        "!gamestats": { handler: (mn) => this.handleGameStats(mn), whisperOnly: true },
        "!scores me": { handler: (mn) => this.handleScoresMe(mn) },
        "!scores race": { handler: (mn) => this.handleScores(mn, "race") },
        "!scores survive": { handler: (mn) => this.handleScores(mn, "survive") },
        "!scores": { handler: (mn) => this.handleScores(mn) },
        "!leaderboard": { handler: (mn) => this.handleLeaderboard(mn) },
        "!lb": { handler: (mn) => this.handleLeaderboard(mn) },
        "!feedback ": { handler: (mn, name, _msg, message) => this.handleFeedback(mn, name, message), whisperOnly: true, prefix: true },
        "!removed": { handler: (mn, name) => this.handleRemoved(mn, name) },
        "!veto": { handler: (mn) => this.handleVeto(mn), whisperOnly: true },
        "!accept": { handler: (mn) => this.handleVetoAccept(mn), whisperOnly: true },
        "!continue": { handler: (mn) => this.handleContinue(mn), chatOnly: true },
        "!debugroll ": { handler: (mn, _name, _msg, message) => this.handleDebugRoll(mn, message), whisperOnly: true, prefix: true },
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

    // Yes/No confirmation for a pending !join. Shared by handleWhisper and
    // handleChat so a player can confirm from either channel. Returns true
    // if the message was consumed as a yes/no answer.
    private tryHandleYesNoJoin(memberNumber: number, name: string, msg: string): boolean {
        if (!this.pendingYesNoJoin.has(memberNumber)) return false;
        if (msg === "yes" || msg === "y") {
            const pending = this.pendingYesNoJoin.get(memberNumber)!;
            this.pendingYesNoJoin.delete(memberNumber);
            this.completeJoin(memberNumber, name, pending.inlineMin, pending.inlineMax);
            return true;
        }
        if (msg === "no" || msg === "n") {
            this.pendingYesNoJoin.delete(memberNumber);
            this.bot.whisper(memberNumber, "No problem! Come back anytime.");
            return true;
        }
        return false;
    }

    public handleWhisper(memberNumber: number, name: string, message: string): void {
        const msg = message.trim().toLowerCase();

        // Bare "!feedback" prompts the player to whisper their feedback next.
        // Their following whisper is collected as feedback unless it's itself
        // a command (starts with "!"), in which case it's processed normally.
        if (this.pendingFeedbackRequest.has(memberNumber)) {
            this.pendingFeedbackRequest.delete(memberNumber);
            if (!msg.startsWith("!")) {
                this.handleFeedback(memberNumber, name, "!feedback " + message);
                return;
            }
        }

        // Yes/No confirmation for a pending admin proxy-feedback submission.
        if (this.tryHandleAdminFeedbackProxyYesNo(memberNumber, msg)) return;

        // Pending lock-time vote (after a win/game-over, before end-game
        // locks go on) — only accepts 1/2/3 replies from the bound players
        // being polled.
        if (this.tryHandleEndGameLockVote(memberNumber, msg)) return;

        // Guided clothing Q&A takes priority over other commands while active
        const player = this.players.get(memberNumber);
        if (player && player.clothingQuestionIndex !== null && (msg === "yes" || msg === "y" || msg === "no" || msg === "n")) {
            this.handleGuidedAnswer(memberNumber, msg);
            return;
        }

        // Pre-game toys consent question, while this player hasn't answered yet.
        if (this.awaitingToysConsent && player?.toysConsent === null && (msg === "yes" || msg === "y" || msg === "no" || msg === "n")) {
            this.recordToysConsentAnswer(memberNumber, msg === "yes" || msg === "y");
            return;
        }

        // Toys consent question for a mid-game joiner, while pending.
        if (this.pendingLateJoinToysConsent.has(memberNumber) && (msg === "yes" || msg === "y" || msg === "no" || msg === "n")) {
            this.handleLateJoinToysConsentAnswer(memberNumber, msg === "yes" || msg === "y");
            return;
        }

        // Solo game setup: guided clothing Q&A (yes/no), same as !wearing
        if (this.pendingSoloSetup.has(memberNumber) && (msg === "yes" || msg === "y" || msg === "no" || msg === "n")) {
            this.handleSoloClothingAnswer(memberNumber, msg);
            return;
        }

        // Solo game roll takes priority over the multiplayer !roll while active,
        // so it never interferes with multiplayer turn order.
        if (["!roll", "!r", "!rool", "!rol", "!oll"].includes(msg) && this.soloGames.has(memberNumber)) {
            this.handleSoloRoll(memberNumber);
            return;
        }

        // Solo item-removal confirmation, while waiting on it. Only intercepts
        // when the solo game is actually pausing for it, so multiplayer's
        // !removed keeps working for players also in solo.
        if (msg === "!removed" && this.soloGames.get(memberNumber)?.awaitingRemoval) {
            this.handleSoloRemoved(memberNumber);
            return;
        }

        // Yes/No confirmation for pending !join
        if (this.tryHandleYesNoJoin(memberNumber, name, msg)) return;

        // Team mode: host's numeric reply to "How many players per team?"
        if (this.tryHandleTeamSizeReply(memberNumber, msg)) return;

        // Team mode: active player's keep/drop parity vote
        if (this.tryHandleTeamParityVote(memberNumber, msg)) return;

        // Lock verification: accept bare "yes"/"no" too, so OOC responses
        // like "(yes)"/"(no)" (which strip down to just "yes"/"no") work
        // alongside "!yes"/"!no" and "(!yes)"/"(!no)" (handled by dispatchCommand).
        if (this.pendingLockVerifications.has(memberNumber)) {
            if (msg === "yes" || msg === "y") {
                this.handleLockVerificationYes(memberNumber);
                return;
            }
            if (msg === "no" || msg === "n") {
                this.handleLockVerificationNo(memberNumber);
                return;
            }
        }

        // Min/max reply from host during lobby setup — intercept any message
        // that starts with a digit so commands still fall through normally.
        // Scoped to the open lobby: once the game starts, a digit whisper from
        // the host must not be swallowed (e.g. a player-pick item number).
        if (this.awaitingMinMaxReply && this.lobbyOpen && memberNumber === this.hostMemberNumber && /^\d/.test(msg)) {
            this.awaitingMinMaxReply = false;
            const parts = msg.trim().split(/\s+/);
            const n1 = parseInt(parts[0], 10);
            const n2 = parts.length >= 2 ? parseInt(parts[1], 10) : n1;
            const error = this.validateMinMax(n1, n2);
            if (error) {
                this.awaitingMinMaxReply = true;
                this.bot.whisper(memberNumber, `${error} Please try again (e.g. '2 6').`);
                return;
            }
            this.minPlayers = n1;
            this.maxPlayers = n2;
            const hostName = this.players.get(memberNumber)?.name ?? name;
            this.announceGameStart(hostName);
            return;
        }

        // Bondage mode question ("outfit" or "pick"), while unanswered — either
        // the pre-game group question or a late joiner's individual question.
        if (player && player.bondageMode === null &&
            (this.awaitingBondageMode || this.awaitingLateBondageMode.has(memberNumber))) {
            if (this.tryHandleBondageModeAnswer(memberNumber, msg)) return;
        }

        // Picker's slot/item choice for an in-flight player-pick selection.
        if (this.tryHandleBondagePickInput(memberNumber, message)) return;

        // Veto target's bare yes/no (aliases for !accept/!veto).
        if (this.tryHandleVetoYesNo(memberNumber, msg)) return;

        // Slot-consent answer (comma-separated slot list or "all"). Only
        // consumes non-command whispers, which would otherwise be ignored.
        if (this.pendingSlotConsent.has(memberNumber) && !msg.startsWith("!")) {
            this.handleSlotConsentAnswer(memberNumber, message);
            return;
        }

        this.dispatchCommand(memberNumber, name, message, msg, "whisper");
    }

    public handleChat(memberNumber: number, name: string, message: string): void {
        const msg = message.trim().toLowerCase();

        // Guided clothing Q&A (!wearing) is whisper-only — nudge the player
        // to whisper instead of silently dropping their yes/no.
        const player = this.players.get(memberNumber);
        if (player && player.clothingQuestionIndex !== null && (msg === "yes" || msg === "y" || msg === "no" || msg === "n")) {
            this.bot.whisper(memberNumber, "Psst — whisper your yes or no to me! (Your outfit choices are between us.)");
            return;
        }

        // Pre-game toys consent question is whisper-only — same nudge.
        if (this.awaitingToysConsent && player?.toysConsent === null && (msg === "yes" || msg === "y" || msg === "no" || msg === "n")) {
            this.bot.whisper(memberNumber, "Psst — whisper your yes or no to me! (Toy consent is between us.)");
            return;
        }

        // Toys consent question for a mid-game joiner is whisper-only — same nudge.
        if (this.pendingLateJoinToysConsent.has(memberNumber) && (msg === "yes" || msg === "y" || msg === "no" || msg === "n")) {
            this.bot.whisper(memberNumber, "Psst — whisper your yes or no to me!");
            return;
        }

        // Solo game setup clothing Q&A is whisper-only — same nudge.
        if (this.pendingSoloSetup.has(memberNumber) && (msg === "yes" || msg === "y" || msg === "no" || msg === "n")) {
            this.bot.whisper(memberNumber, "Psst — whisper your yes or no to me! (The solo game is just between us.)");
            return;
        }

        // Solo game roll takes priority over the multiplayer !roll while active,
        // so a roll typed in room chat (instead of whispered) still counts and
        // doesn't get silently swallowed by the multiplayer roll handler.
        if (["!roll", "!r", "!rool", "!rol", "!oll"].includes(msg) && this.soloGames.has(memberNumber)) {
            this.handleSoloRoll(memberNumber);
            return;
        }

        // Solo item-removal confirmation, while waiting on it (see handleWhisper).
        if (msg === "!removed" && this.soloGames.get(memberNumber)?.awaitingRemoval) {
            this.handleSoloRemoved(memberNumber);
            return;
        }

        // Yes/No confirmation for pending !join — nothing sensitive here, so
        // accept it from chat the same as a whisper.
        if (this.tryHandleYesNoJoin(memberNumber, name, msg)) return;

        // Min/max reply from host during lobby setup is whisper-only — nudge
        // instead of silently dropping their digits.
        if (this.awaitingMinMaxReply && memberNumber === this.hostMemberNumber && /^\d/.test(msg)) {
            this.bot.whisper(memberNumber, "Psst — whisper your min and max to me! (e.g., whisper `2 6`)");
            return;
        }

        // Team mode: host's numeric reply to "How many players per team?" —
        // public setup, so accepted from chat the same as a whisper.
        if (this.tryHandleTeamSizeReply(memberNumber, msg)) return;

        // Team mode keep/drop parity vote is whisper-only — nudge instead of
        // silently dropping it.
        if (this.awaitingTeamParityVote && this.teamParityVoters.has(memberNumber) &&
            (msg === "keep" || msg === "drop")) {
            this.bot.whisper(memberNumber, "Psst — whisper your keep or drop vote to me!");
            return;
        }

        // Lock-time vote is whisper-only — nudge instead of silently dropping it.
        if (this.pendingLockTimeVote?.boundPlayers.some(p => p.memberNumber === memberNumber) &&
            (msg === "1" || msg === "2" || msg === "3")) {
            this.bot.whisper(memberNumber, "Psst — whisper your lock-time vote (1/2/3) to me!");
            return;
        }

        // !solo / !solo race / !solo survive are whisper-only — nudge instead
        // of silently dropping the command.
        if (msg === "!solo" || msg.startsWith("!solo ")) {
            this.bot.whisper(memberNumber, "Solo games start with a whisper! Whisper me `!solo race` or `!solo survive` to get started.");
            return;
        }

        // !feedback is whisper-only — nudge instead of silently dropping it.
        if (msg === "!feedback" || msg.startsWith("!feedback ")) {
            this.bot.whisper(memberNumber, "Feedback is sent privately — whisper `!feedback your message` to me so it stays between us.");
            return;
        }

        this.dispatchCommand(memberNumber, name, message, msg, "chat");
    }

    // ============================================================
    // COMMAND HANDLERS
    // ============================================================

    // Extracts the major release number from a BC version string like "R108" or "R108Beta1".
    private parseBCVersion(v: string): number {
        const m = v.match(/R(\d+)/i);
        return m ? parseInt(m[1], 10) : 0;
    }

    // Returns true if the player's permissions allow the bot to apply items.
    // On any failure, whispers the player a specific remediation message and
    // returns false so the caller can abort the join.
    private checkPlayerPermissions(memberNumber: number, name: string): boolean {
        const char = this.characterDataCache.get(memberNumber);
        if (!char) {
            log(`Permission pre-flight for ${name} (#${memberNumber}): no character data cached, skipping.`);
            return true;
        }

        const oss = char.OnlineSharedSettings;
        let passed = true;

        // AllowItem === false means the player has globally blocked item interactions.
        if (oss?.AllowItem === false) {
            this.bot.whisper(memberNumber,
                "⚠️ To play Strip Dice, you need to allow item interactions. " +
                "Go to Online Settings → Items and enable \"Allow others to add items\", then !join again."
            );
            log(`Permission pre-flight: ${name} (#${memberNumber}) has AllowItem=false.`);
            passed = false;
        }

        return passed;
    }

    private handleJoin(memberNumber: number, name: string, rawMessage: string = ""): void {
        if (this.pendingLateJoinToysConsent.has(memberNumber)) {
            this.bot.whisper(memberNumber, "Please answer the toy consent question above first (yes/no).");
            return;
        }
        if (this.state === GameState.TeamSetup) {
            this.handleTeamJoin(memberNumber, name, rawMessage);
            return;
        }
        if (this.isTeamMode && !this.players.has(memberNumber)) {
            this.bot.whisper(memberNumber, "A team game is in progress — you're welcome to watch! Say !help for more info.");
            return;
        }
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
        const midGame = this.state === GameState.Rolling || this.state === GameState.WaitingRemove || this.state === GameState.WaitingBondage || this.state === GameState.PausedForJoin;

        if (gameInProgress && (!this.allowMidGameJoin || !midGame)) {
            this.bot.whisper(memberNumber, "Sorry, a game is already in progress. Wait for the next round!");
            return;
        }
        if (this.players.has(memberNumber)) {
            this.bot.whisper(memberNumber, "You've already joined! Whisper !wearing followed by your items, or !naked if you have nothing on.");
            return;
        }

        // Lobby max-player cap — check before double-confirm so a full game
        // doesn't waste a confirm slot on someone who can't join anyway.
        if (this.lobbyOpen && !midGame && this.players.size >= this.maxPlayers) {
            this.bot.whisper(memberNumber, `The game is currently full (${this.players.size}/${this.maxPlayers} players). Stick around and watch — you can jump in next game!`);
            return;
        }

        if (this.pendingYesNoJoin.has(memberNumber)) {
            this.bot.whisper(memberNumber, "You already have a pending join — reply Yes or No to my last message.");
            return;
        }

        // Parse optional inline min/max: "!join 3 5" or "!join 4"
        const parts = rawMessage.trim().split(/\s+/);
        let inlineMin: number | null = null;
        let inlineMax: number | null = null;
        if (parts.length >= 2) {
            const n1 = parseInt(parts[1], 10);
            if (!isNaN(n1)) { inlineMin = n1; inlineMax = n1; }
        }
        if (parts.length >= 3) {
            const n2 = parseInt(parts[2], 10);
            if (!isNaN(n2)) { inlineMax = n2; }
        }

        this.pendingYesNoJoin.set(memberNumber, { name, inlineMin, inlineMax });
        this.bot.whisper(memberNumber,
            `You may be bound at the end of the game if you lose everything — ${this.lockDurationMinutes} minutes is proposed, but the time can vary a bit (everyone locked gets a vote to nudge it up or down before it's applied). Do you understand? Reply **Yes** to join or **No** to cancel.`
        );
    }

    private completeJoin(memberNumber: number, name: string, inlineMin: number | null, inlineMax: number | null): void {
        if (!this.checkPlayerPermissions(memberNumber, name)) {
            return;
        }

        const midGame = this.state === GameState.Rolling || this.state === GameState.WaitingRemove || this.state === GameState.WaitingBondage || this.state === GameState.PausedForJoin;

        if (midGame && this.toysAllowed) {
            this.gateLateJoinOnToysConsent(memberNumber,
                () => this.finishCompleteJoin(memberNumber, name, inlineMin, inlineMax, midGame),
                () => {} // declined — cancellation whisper already sent, don't add them as a player
            );
            return;
        }

        this.finishCompleteJoin(memberNumber, name, inlineMin, inlineMax, midGame);
    }

    private finishCompleteJoin(memberNumber: number, name: string, inlineMin: number | null, inlineMax: number | null, midGame: boolean): void {
        const player: Player = {
            memberNumber,
            name,
            clothing: [],
            clothingRemoved: 0,
            bondageApplied: 0,
            isNaked: false,
            isFullyBound: false,
            missedTurnPending: false,
            missedSecondChance: false,
            ready: false,
            midGameJoin: midGame,
            clothingQuestionIndex: null,
            pendingClothing: [],
            bondageOutfit: null,
            pendingReturn: false,
            leaveRoundsRemaining: 0,
            leaveTime: null,
            freePass: false,
            pendingPenaltySteps: 0,
            removalWarned: false,
            pendingRemovalKick: false,
            toysConsent: null,
            bondageMode: null,
            allowedSlots: [...TIER1_SLOT_GROUPS],
            appliedBondageItems: [],
            lastLossSeq: 0,
            teamId: null,
            isGhost: false,
            pendingRemovalBaselineCount: null,
        };
        this.players.set(memberNumber, player);

        if (midGame) {
            this.bot.sendChat(`${name} is joining mid-game! They'll enter the turn rotation once ready.`);
            if (this.state === GameState.PausedForJoin) {
                this.joinPauseActive.set(memberNumber, name);
                this.sendJoinPauseInstructions(memberNumber);
            } else {
                this.pendingJoinPauses.push({ memberNumber, name });
            }
        } else {
            const isFirstJoin = this.players.size === 1;
            this.state = GameState.Registration;

            if (isFirstJoin) {
                this.hostMemberNumber = memberNumber;
                this.lobbyOpen = true;
                this.gameStartTime = new Date().toISOString();
                this.gameEndLogged = false;

                if (inlineMin !== null && inlineMax !== null) {
                    const error = this.validateMinMax(inlineMin, inlineMax);
                    if (error) {
                        this.bot.whisper(memberNumber, `${error} Please use !join [min] [max] with valid values (e.g. !join 2 6).`);
                        this.players.delete(memberNumber);
                        this.state = GameState.Idle;
                        this.lobbyOpen = false;
                        this.hostMemberNumber = null;
                        return;
                    }
                    this.minPlayers = inlineMin;
                    this.maxPlayers = inlineMax;
                    this.announceGameStart(name);
                    const onlyOneInRoom = [...this.roomMembers].filter(n => n !== this.bot.getMemberNumber()).length <= 1;
                    if (onlyOneInRoom) {
                        this.bot.whisper(memberNumber, "You're the only one here right now — feel free to get your outfit ready with !wearing while you wait, or try a solo game.");
                    }
                } else {
                    this.awaitingMinMaxReply = true;
                    const onlyOneInRoom = [...this.roomMembers].filter(n => n !== this.bot.getMemberNumber()).length <= 1;
                    let prompt = "How many players? Reply with min and max (e.g. '2 6') or just a number for both.";
                    if (onlyOneInRoom) {
                        prompt += "\n\nYou're the only one here right now — feel free to get your outfit ready with !wearing while you wait, or try a solo game.";
                    }
                    this.bot.whisper(memberNumber, prompt);
                }
            } else {
                this.bot.sendChat(`${name} has joined the game! (${this.players.size}/${this.maxPlayers})`);
                this.bot.whisper(memberNumber, `You're in! (${this.players.size}/${this.maxPlayers} players joined). Declare your outfit with !wearing or !naked, then whisper !ready when done.`);
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

    private validateMinMax(min: number, max: number): string | null {
        if (isNaN(min) || isNaN(max)) return "Invalid numbers.";
        if (min < 2) return "Minimum players must be at least 2.";
        if (max < min) return "Maximum must be >= minimum.";
        if (max > 10) return "Maximum players can be at most 10.";
        return null;
    }

    private announceGameStart(hostName: string): void {
        this.bot.sendChat(
            `🎲 ${hostName} has started a game! Looking for ${this.minPlayers === this.maxPlayers ? `exactly ${this.minPlayers}` : `${this.minPlayers}–${this.maxPlayers}`} players. Type !join to join!`
        );
        this.bot.sendChat(
            `Lock duration: type !lock10, !lock15, or !lock20 to set the timer. Default is ${DEFAULT_LOCK_MINUTES} minutes.`
        );
        this.bot.sendChat(
            `You're the only player right now! A second player needs to join before the game can start, or you can go solo with !solo.`
        );
        this.announcePlayerUpdates();
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

        if (!this.checkPlayerPermissions(memberNumber, name)) {
            return;
        }

        this.gateLateJoinOnToysConsent(memberNumber,
            () => this.finishLateJoin(memberNumber, name),
            () => {} // declined — cancellation whisper already sent, don't add them as a player
        );
    }

    private finishLateJoin(memberNumber: number, name: string): void {
        const player: Player = {
            memberNumber,
            name,
            clothing: [],
            clothingRemoved: 0,
            bondageApplied: 0,
            isNaked: true,
            isFullyBound: false,
            missedTurnPending: false,
            missedSecondChance: false,
            ready: true,
            midGameJoin: false,
            clothingQuestionIndex: null,
            pendingClothing: [],
            bondageOutfit: null,
            pendingReturn: false,
            leaveRoundsRemaining: 0,
            leaveTime: null,
            freePass: false,
            pendingPenaltySteps: 0,
            removalWarned: false,
            pendingRemovalKick: false,
            toysConsent: null,
            bondageMode: null, // resolved right after registering, via askLateBondageMode below
            allowedSlots: [...TIER1_SLOT_GROUPS],
            appliedBondageItems: [],
            lastLossSeq: 0,
            teamId: null,
            isGhost: false,
            pendingRemovalBaselineCount: null,
        };
        this.players.set(memberNumber, player);
        this.turnOrder.push(memberNumber);

        this.bot.sendChat(`${name} has joined the game naked — brave!`);
        this.askLateBondageMode(player);
    }

    // Gate shared by both mid-game join paths (clothed mid-game join and the
    // naked late join). If toys are allowed for the current game, asks the
    // joiner to opt in before letting them in; otherwise lets them straight
    // through. onDecline is only invoked for an explicit "no" or a timeout —
    // the "removed from queue" whisper is sent here either way.
    private gateLateJoinOnToysConsent(memberNumber: number, onAccept: () => void, onDecline: () => void): void {
        if (!this.toysAllowed) {
            onAccept();
            return;
        }

        const timeout = setTimeout(() => {
            this.pendingLateJoinToysConsent.delete(memberNumber);
            this.bot.whisper(memberNumber, "No problem! You've been removed from the joining queue.");
            onDecline();
        }, TOYS_CONSENT_TIMEOUT_MS);

        this.pendingLateJoinToysConsent.set(memberNumber, { onAccept, onDecline, timeout });
        this.bot.whisper(memberNumber,
            "This is a toy game — the winner may add toys and touch players at the end. Are you OK with that? (yes/no)"
        );
    }

    private handleLateJoinToysConsentAnswer(memberNumber: number, accepted: boolean): void {
        const pending = this.pendingLateJoinToysConsent.get(memberNumber);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingLateJoinToysConsent.delete(memberNumber);

        if (accepted) {
            pending.onAccept();
        } else {
            this.bot.whisper(memberNumber, "No problem! You've been removed from the joining queue.");
            pending.onDecline();
        }
    }

    // ============================================================
    // TEAM MODE - lobby
    // ============================================================

    private handleTeamGame(memberNumber: number, name: string): void {
        if (this.state !== GameState.Idle) {
            this.bot.whisper(memberNumber, "A game is already in progress.");
            return;
        }
        if (Date.now() < this.gameCooldownUntil) {
            const remainingMin = Math.ceil((this.gameCooldownUntil - Date.now()) / 60000);
            this.bot.whisper(memberNumber,
                `⏳ We just wrapped up a game — give everyone a few minutes before the next one starts. Try !teamgame again in about ${remainingMin} minute${remainingMin === 1 ? "" : "s"}.`
            );
            return;
        }
        if (this.checkPendingUpdate()) return;

        this.isTeamMode = true;
        this.teamRoster = { 1: [], 2: [] };
        this.state = GameState.TeamSetup;
        this.hostMemberNumber = memberNumber;
        this.awaitingTeamSizeReply = true;
        this.gameStartTime = new Date().toISOString();
        this.gameEndLogged = false;
        this.bot.sendChat(`🎲 ${name} wants to start a team game! How many players per team — 2 or 3?`);
        this.announcePlayerUpdates();
    }

    // Intercepts the host's numeric reply to "2 or 3?" from either whisper or
    // chat. Returns false (uninvolved) for anything that isn't a digit reply
    // from the host during the size-selection window, so normal commands
    // (e.g. !cancel) keep working.
    private tryHandleTeamSizeReply(memberNumber: number, msg: string): boolean {
        if (!this.awaitingTeamSizeReply || memberNumber !== this.hostMemberNumber) return false;
        if (!/^\d/.test(msg)) return false;

        const n = parseInt(msg.trim(), 10);
        if (n !== 2 && n !== 3) {
            this.bot.sendChat(`Please reply with 2 or 3.`);
            return true;
        }
        this.awaitingTeamSizeReply = false;
        this.teamSize = n;
        this.bot.sendChat(`Starting a ${n}v${n} team game! Use !join team1 or !join team2 to pick your side.`);
        return true;
    }

    private handleTeamJoin(memberNumber: number, name: string, rawMessage: string): void {
        if (this.players.has(memberNumber)) {
            this.bot.whisper(memberNumber, "You've already joined a team!");
            return;
        }
        if (!this.checkPlayerPermissions(memberNumber, name)) return;

        const parts = rawMessage.trim().toLowerCase().split(/\s+/);
        const teamArg = parts[1];
        let team: 1 | 2 | null = null;
        if (teamArg === "team1" || teamArg === "1") team = 1;
        else if (teamArg === "team2" || teamArg === "2") team = 2;

        if (team === null) {
            this.bot.sendChat(`${name}, use !join team1 or !join team2 to pick your side.`);
            return;
        }

        if (this.teamRoster[team].length >= this.teamSize) {
            const other: 1 | 2 = team === 1 ? 2 : 1;
            this.bot.sendChat(`Team ${team} is full — join Team ${other} instead.`);
            return;
        }

        const player: Player = {
            memberNumber,
            name,
            clothing: [],
            clothingRemoved: 0,
            bondageApplied: 0,
            isNaked: false,
            isFullyBound: false,
            missedTurnPending: false,
            missedSecondChance: false,
            ready: false,
            midGameJoin: false,
            clothingQuestionIndex: null,
            pendingClothing: [],
            bondageOutfit: null,
            pendingReturn: false,
            leaveRoundsRemaining: 0,
            leaveTime: null,
            freePass: false,
            pendingPenaltySteps: 0,
            removalWarned: false,
            pendingRemovalKick: false,
            toysConsent: null,
            bondageMode: null,
            allowedSlots: [...TIER1_SLOT_GROUPS],
            appliedBondageItems: [],
            lastLossSeq: 0,
            teamId: team,
            isGhost: false,
            pendingRemovalBaselineCount: null,
        };
        this.players.set(memberNumber, player);
        this.teamRoster[team].push(memberNumber);

        this.announceTeamRosters();

        if (this.teamRoster[1].length >= this.teamSize && this.teamRoster[2].length >= this.teamSize) {
            this.lockTeamsAndBegin();
        }
    }

    private announceTeamRosters(): void {
        const t1 = this.teamRoster[1].map(n => this.getPlayerName(n));
        const t2 = this.teamRoster[2].map(n => this.getPlayerName(n));
        this.bot.sendChat(
            `Team 1: ${t1.length ? t1.join(", ") : "(empty)"} (${t1.length}/${this.teamSize}) | ` +
            `Team 2: ${t2.length ? t2.join(", ") : "(empty)"} (${t2.length}/${this.teamSize})`
        );
    }

    private lockTeamsAndBegin(): void {
        const t1 = this.teamRoster[1].map(n => this.getPlayerName(n));
        const t2 = this.teamRoster[2].map(n => this.getPlayerName(n));
        this.bot.sendChat(`Teams locked!\nTeam 1: ${t1.join(", ")}\nTeam 2: ${t2.join(", ")}\nGame starting!`);
        this.beginClothingDeclaration();
    }

    private handleTeams(memberNumber: number): void {
        if (!this.isTeamMode) {
            this.bot.whisper(memberNumber, "No team game is active. Try !teamgame to start one!");
            return;
        }
        const format = (team: 1 | 2): string => {
            const members = [...this.players.values()].filter(p => p.teamId === team);
            if (members.length === 0) return "(empty)";
            const names = members.map(p => p.isGhost ? `${p.name} 👻` : p.name).join(", ");
            return members.every(p => !p.isGhost) ? `${names} (all active)` : names;
        };
        this.bot.sendChat(`Team 1: ${format(1)} | Team 2: ${format(2)}`);
    }

    private handleStart(memberNumber: number): void {
        if (this.state === GameState.TeamSetup) {
            const need1 = Math.max(0, this.teamSize - this.teamRoster[1].length);
            const need2 = Math.max(0, this.teamSize - this.teamRoster[2].length);
            this.bot.whisper(memberNumber, `Teams aren't full yet — Team 1 needs ${need1} more, Team 2 needs ${need2} more.`);
            return;
        }
        if (this.state !== GameState.Registration && this.state !== GameState.Countdown) {
            this.bot.whisper(memberNumber, "No game is waiting to start.");
            return;
        }
        if (this.players.size < this.minPlayers) {
            this.bot.whisper(memberNumber, `Need at least ${this.minPlayers} players to start. ${this.players.size} joined so far.`);
            return;
        }
        this.bot.sendChat(`${this.getPlayerName(memberNumber)} is starting the game early!`);
        this.clearCountdown();
        this.beginClothingDeclaration();
    }

    private handleCancel(memberNumber: number): void {
        if (this.state === GameState.PausedForJoin) {
            if (!this.players.has(memberNumber) && !this.isAdmin(memberNumber)) {
                this.bot.whisper(memberNumber, "You haven't joined the game yet! Whisper !join first.");
                return;
            }
            this.bot.sendChat(`${this.getPlayerName(memberNumber)} called !cancel — resuming the game now.`);
            this.resumeFromJoinPause();
            return;
        }

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
        player.clothingQuestionIndex = null;
        if (player.clothing.length > 0) {
            this.lastClothing.set(memberNumber, [...player.clothing]);
        }

        if (player.midGameJoin) {
            // By the time a late joiner gets in, several rounds have usually
            // passed — 1 remaining item is treated as effectively naked so
            // they go straight to bondage on their first loss like everyone
            // else who's already lost almost everything.
            if (player.clothing.length <= 1) {
                player.isNaked = true;
            }

            player.midGameJoin = false;
            this.turnOrder.push(memberNumber);
            this.bot.whisper(memberNumber, "You're ready! You've been added to the turn rotation.");
            this.askLateBondageMode(player);

            if (this.joinPauseActive.has(memberNumber)) {
                this.joinPauseActive.delete(memberNumber);
                this.joinPauseJoined.push({ memberNumber, name: player.name });
                if (this.joinPauseActive.size === 0) {
                    this.resumeFromJoinPause();
                }
            } else {
                this.bot.sendChat(`${player.name} has joined the game and entered the turn rotation!`);
            }
            return;
        }

        if (this.lobbyOpen && this.hostMemberNumber !== null) {
            if (memberNumber === this.hostMemberNumber) {
                this.bot.whisper(memberNumber, "You're set! You can type !start whenever the others are ready.");
            } else {
                const readyCount = [...this.players.values()].filter(p => p.ready).length;
                const totalCount = this.players.size;
                this.bot.whisper(this.hostMemberNumber, `${player.name} is ready. (${readyCount}/${totalCount} ready)`);
                this.bot.whisper(memberNumber, "You're ready! Waiting for others...");
            }
        } else {
            this.bot.whisper(memberNumber, "You're ready! Waiting for other players...");
        }
        this.bot.sendChat(`${player.name} is ready!`);
        if (this.players.size === 1) {
            this.bot.sendChat(
                `Waiting for a second player to join — the game will start automatically when they do! Or type !solo to play solo right now.`
            );
        }
        this.checkAllReady();
    }

    private isAdmin(memberNumber: number): boolean {
        return memberNumber === 208543 || memberNumber === 247062 || memberNumber === this.bot.getMemberNumber();
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

    private handleDebugRoll(memberNumber: number, message: string): void {
        if (!this.requireAdmin(memberNumber)) return;
        const gameActive = this.state !== GameState.Idle || this.soloGames.size > 0;
        if (!gameActive) {
            this.bot.whisper(memberNumber, "No game in progress.");
            return;
        }
        const parts = message.trim().split(/\s+/);
        const n = parseInt(parts[1]);
        if (isNaN(n) || n < 1) {
            this.bot.whisper(memberNumber, "Usage: !debugroll <number>");
            return;
        }
        this.debugNextRoll = n;
        this.bot.whisper(memberNumber, `Next roll forced to ${n}. Will clear after use.`);
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
        if (target) {
            this.removeAllItemsSafeword(target.memberNumber, target.name, memberNumber);

            const wasFullyBound = target.isFullyBound;
            target.bondageApplied = 0;
            target.isFullyBound = false;
            target.bondageOutfit = null;
            target.appliedBondageItems = [];

            if (wasFullyBound && !this.turnOrder.includes(target.memberNumber)) {
                this.turnOrder.push(target.memberNumber);
            }

            // If a player-pick selection was in flight for them, abandon it
            // and hand the turn back to the game.
            if (this.pendingBondagePick?.targetNumber === target.memberNumber) {
                this.cancelPendingBondagePick();
                this.currentDiceMax = STARTING_DICE_MAX;
                this.resolveCurrentTurn();
            }

            this.bot.sendChat(`Admin has freed ${target.name} from their restraints.`);
            return;
        }

        // Not in the active game roster - search everyone currently in the
        // room for anyone still wearing bot-applied locks (e.g. they left
        // the game but never got unlocked).
        let roomMatch: { memberNumber: number; name: string } | undefined;
        for (const roomMemberNumber of this.roomMembers) {
            const name = this.nameCache.get(roomMemberNumber);
            if (name && name.toLowerCase().includes(requested.toLowerCase())) {
                roomMatch = { memberNumber: roomMemberNumber, name };
                break;
            }
        }

        if (!roomMatch) {
            this.bot.whisper(memberNumber, `No player found matching '${requested}' in the game or room.`);
            return;
        }

        log(`!free: ${roomMatch.name} (#${roomMatch.memberNumber}) found in room but not in the active game - removing bot locks only.`);
        this.removeBotLocksFromRoomMember(roomMatch.memberNumber, roomMatch.name);
        this.bot.sendChat(`Admin has freed ${roomMatch.name} from their restraints.`);
    }

    // Removes any items the bot has padlocked (Property.LockedBy ===
    // "TimerPasswordPadlock", locked by this bot) from a room member who
    // isn't part of the active game - e.g. someone who left mid-game while
    // still wearing end-game locks. Unlike removeAllItemsSafeword(), this
    // leaves items that aren't bot-locked alone.
    private removeBotLocksFromRoomMember(targetMemberNumber: number, name: string): void {
        const botMemberNumber = this.bot.getMemberNumber();
        let foundLock = false;

        REMOVAL_SLOTS.forEach((group, index) => {
            const current = this.itemStateCache.get(`${targetMemberNumber}:${group}`);
            const lockedByBot = current?.Property?.LockedBy === "TimerPasswordPadlock" &&
                current?.Property?.LockMemberNumber === botMemberNumber;
            if (!lockedByBot) return;

            foundLock = true;
            setTimeout(() => {
                this.bot.applyItem(targetMemberNumber, group, current.Name, current.Color, cleanDecodedProperty(current.Property));
                setTimeout(() => this.bot.removeItem(targetMemberNumber, group), REMOVAL_UNLOCK_GAP_MS);
            }, index * REMOVAL_SLOT_DELAY_MS);
        });

        if (!foundLock) {
            log(`!free: ${name} (#${targetMemberNumber}) has no bot-applied locks to remove.`);
        }
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

        // A pick targeting them is moot; a pick they were making resolves
        // via the pick timer's random fallback.
        let cancelledPickForKicked = false;
        if (this.pendingBondagePick?.targetNumber === target.memberNumber) {
            this.cancelPendingBondagePick();
            cancelledPickForKicked = true;
        }

        this.clearTurnTimer();
        this.secondChanceQueue = this.secondChanceQueue.filter(sc => sc.memberNumber !== target.memberNumber);
        if (this.activeSecondChance === target.memberNumber) {
            this.clearSecondChanceTimer();
            this.activeSecondChance = null;
        }
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
            this.recordGameCompletion([winner.memberNumber]);
            this.logMultiplayerGameEnd("win", { winner: winner.name });
            this.applyEndGameLocks([winner]);
            return;
        }

        if (wasCurrentTurn || (cancelledPickForKicked && this.state === GameState.WaitingBondage)) {
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
        player.appliedBondageItems = [];

        // Abandon any in-flight player-pick selection involving them (as
        // target or picker) — the safeword pause takes over the game state.
        let cancelledPick = false;
        if (this.pendingBondagePick &&
            (this.pendingBondagePick.targetNumber === memberNumber ||
             this.pendingBondagePick.pickerNumber === memberNumber)) {
            this.cancelPendingBondagePick();
            cancelledPick = true;
        }

        this.clearTurnTimer();

        // Team mode: safewording doesn't pause the game for a !continue vote —
        // the player becomes a ghost (auto-rolls 1 every turn) and the game
        // keeps going without interruption.
        if (this.isTeamMode) {
            this.handleTeamSafeword(player, cancelledPick);
            return;
        }

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

    // ============================================================
    // TEAM MODE - safeword ghosting, parity vote, ghost drop
    // ============================================================

    // Converts a safewording team-mode player into a ghost instead of pausing
    // the game for a !continue vote. If it was their turn (or their pending
    // pick got cancelled mid-bondage), resumes the turn cycle immediately.
    private handleTeamSafeword(player: Player, cancelledPick: boolean): void {
        player.isGhost = true;
        player.ghostReason = "safeword";
        this.bot.sendChat(`${player.name} has used their safeword. 👻 Their turns will auto-roll 1.`);

        const wasCurrentTurn = this.getCurrentPlayer()?.memberNumber === player.memberNumber;

        this.checkTeamParity();

        if (wasCurrentTurn || (cancelledPick && this.state === GameState.WaitingBondage)) {
            this.currentDiceMax = STARTING_DICE_MAX;
            this.resolveCurrentTurn();
        }
    }

    // After a safeword ghosting, checks whether both teams' active
    // (non-ghost, non-fully-bound) player counts are now equal. If so, and
    // there's at least one ghost to vote about, offers every active player a
    // whisper vote: keep the ghost rolls as-is, or drop the ghost slot(s).
    private checkTeamParity(): void {
        const active = (team: 1 | 2) =>
            [...this.players.values()].filter(p => p.teamId === team && !p.isGhost && !p.isFullyBound);
        const activeT1 = active(1);
        const activeT2 = active(2);

        if (activeT1.length === 0 || activeT2.length === 0) return; // one side already out — win check handles it
        if (activeT1.length !== activeT2.length) return;
        if (![...this.players.values()].some(p => p.isGhost)) return;

        this.startTeamParityVote([...activeT1, ...activeT2]);
    }

    private startTeamParityVote(voters: Player[]): void {
        if (this.awaitingTeamParityVote) return; // a vote is already in progress
        this.awaitingTeamParityVote = true;
        this.teamParityResponses.clear();
        this.teamParityVoters = new Set(voters.map(p => p.memberNumber));

        const n = voters.length;
        for (const voter of voters) {
            this.bot.whisper(voter.memberNumber,
                `Teams are now even with ${n} active players each. Keep ghost rolls or drop them? Reply "keep" or "drop".`
            );
        }
        this.teamParityTimer = setTimeout(() => this.resolveTeamParityVote(), TOYS_CONSENT_TIMEOUT_MS);
    }

    // Intercepts a bare "keep"/"drop" whisper from an active voter. Returns
    // false for anything else so normal command dispatch keeps working.
    private tryHandleTeamParityVote(memberNumber: number, msg: string): boolean {
        if (!this.awaitingTeamParityVote || !this.teamParityVoters.has(memberNumber)) return false;
        if (msg !== "keep" && msg !== "drop") return false;

        this.teamParityResponses.set(memberNumber, msg);
        this.bot.whisper(memberNumber, `Vote recorded: ${msg}.`);

        if (this.teamParityResponses.size >= this.teamParityVoters.size) {
            this.resolveTeamParityVote();
        }
        return true;
    }

    // Majority of responses received decides; ties (including nobody
    // responding before the timeout) default to "keep" as the safer,
    // less-disruptive outcome.
    private resolveTeamParityVote(): void {
        if (!this.awaitingTeamParityVote) return;
        const votes = [...this.teamParityResponses.values()];
        const keepCount = votes.filter(v => v === "keep").length;
        const dropCount = votes.filter(v => v === "drop").length;
        this.clearTeamParityVote();

        if (dropCount > keepCount) {
            this.dropGhostSlots();
        } else {
            this.bot.sendChat(`Ghost rolls stay — the game continues as-is.`);
        }
    }

    private clearTeamParityVote(): void {
        this.awaitingTeamParityVote = false;
        this.teamParityResponses.clear();
        this.teamParityVoters.clear();
        if (this.teamParityTimer) {
            clearTimeout(this.teamParityTimer);
            this.teamParityTimer = null;
        }
    }

    // Drops every current ghost from turnOrder entirely (their Player record
    // stays in `players` for end-game display, but win-condition checks treat
    // anyone absent from turnOrder as "out" — see checkTeamGameEndCondition).
    // Rebuilds turnOrder maintaining team alternation from whoever's left.
    private dropGhostSlots(): void {
        const ghostNumbers = new Set(
            [...this.players.values()].filter(p => p.isGhost).map(p => p.memberNumber)
        );
        if (ghostNumbers.size === 0) return;

        const currentPlayerBefore = this.getCurrentPlayer();
        const remaining = this.turnOrder.filter(n => !ghostNumbers.has(n));

        const t1 = remaining.filter(n => this.players.get(n)?.teamId === 1);
        const t2 = remaining.filter(n => this.players.get(n)?.teamId === 2);
        const rebuilt: number[] = [];
        const max = Math.max(t1.length, t2.length);
        for (let i = 0; i < max; i++) {
            if (t1[i] !== undefined) rebuilt.push(t1[i]);
            if (t2[i] !== undefined) rebuilt.push(t2[i]);
        }
        this.turnOrder = rebuilt;

        const t1Names = t1.map(n => this.getPlayerName(n));
        const t2Names = t2.map(n => this.getPlayerName(n));
        this.bot.sendChat(
            `Ghost slots dropped. Continuing as ${t1.length}v${t2.length} — ` +
            `Team 1: ${t1Names.join(", ") || "(none)"} | Team 2: ${t2Names.join(", ") || "(none)"}`
        );
        if (t1.length === 1 && t2.length === 1) {
            this.bot.sendChat(`Down to 1v1 — this is now a standard duel!`);
        }

        if (currentPlayerBefore && this.turnOrder.includes(currentPlayerBefore.memberNumber)) {
            this.currentTurnIndex = this.turnOrder.indexOf(currentPlayerBefore.memberNumber);
        } else {
            this.currentTurnIndex = Math.min(this.currentTurnIndex, Math.max(0, this.turnOrder.length - 1));
        }

        this.checkGameEndCondition();
    }

    // Handler for BC's native SafewordUsed event (ChatRoomMessage with Type "Action",
    // Content matching the safeword pattern). Unlike !safeword (which pauses and asks
    // other players if they want to continue), this immediately stops the game and
    // removes bondage from ALL players — the non-negotiable emergency stop.
    public handleBCSafewordEvent(memberNumber: number, name: string): void {
        if (this.state === GameState.Idle || !this.players.has(memberNumber)) return;

        const timestamp = centralTimestamp();
        log(`SAFEWORD EVENT: ${name} (#${memberNumber}) triggered BC safeword at ${timestamp}`);

        const line = `[${timestamp}] SAFEWORD EVENT: ${name} (#${memberNumber}) used their BC safeword. Game stopped. All bondage removed.\n`;
        try {
            fs.appendFileSync(path.join(__dirname, "..", "feedback.log"), line, "utf8");
        } catch (err) {
            log("ERROR: Failed to write safeword event to feedback.log: " + err);
        }

        this.bot.sendChat(`⚠️ ${name} has used their safeword. The game has been stopped. All bondage items will be removed.`);
        this.bot.whisper(208543, `⚠️ SAFEWORD: ${name} (#${memberNumber}) triggered BC safeword at ${timestamp}. Game stopped, all bondage removal initiated.`);

        this.clearCountdown();
        this.clearTurnTimer();
        this.clearSecondChanceTimer();
        this.activeSecondChance = null;
        this.secondChanceQueue = [];
        this.logMultiplayerGameEnd("aborted", { logSuffix: `BC safeword by ${name}` });

        let removalDelay = 0;
        for (const player of this.players.values()) {
            this.removeAllItems(player.memberNumber, removalDelay);
            removalDelay += REMOVAL_SLOTS.length * REMOVAL_SLOT_DELAY_MS;
        }

        this.resetGame();
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

    private handleFeedbackPrompt(memberNumber: number): void {
        this.pendingFeedbackRequest.add(memberNumber);
        this.bot.whisper(memberNumber, "What's your feedback? Go ahead and whisper it to me and I'll pass it along! 💬");
    }

    private handleFeedback(memberNumber: number, name: string, message: string): void {
        const text = message.trim().slice("!feedback ".length).trim();
        if (!text) {
            this.bot.whisper(memberNumber, "Please include your feedback! e.g. !feedback The game was great but...");
            return;
        }

        // Admin proxy: "!feedback <room member name> <text>" logs the feedback
        // under that player's name/number instead of the admin's, after a
        // yes/no confirmation. Falls through to normal behavior if the first
        // word doesn't match anyone currently in the room.
        if (this.isAdmin(memberNumber)) {
            const spaceIdx = text.indexOf(" ");
            if (spaceIdx !== -1) {
                const firstWord = text.slice(0, spaceIdx);
                const rest = text.slice(spaceIdx + 1).trim();
                const target = rest ? this.matchRoomMemberByName(firstWord) : undefined;
                if (target && target.memberNumber !== memberNumber) {
                    this.startAdminFeedbackProxy(memberNumber, target, rest);
                    return;
                }
            }
        }

        this.logFeedbackEntry(memberNumber, name, text);
        this.bot.whisper(memberNumber, "Thank you for your feedback! 💬 We read everything and really appreciate it.");
    }

    // Appends a feedback.log line and updates feedback-tracking state for the
    // given member/name. Shared by normal feedback submission and the admin
    // proxy-feedback confirmation, which logs under the target player's
    // identity rather than the submitting admin's.
    private logFeedbackEntry(memberNumber: number, name: string, text: string): void {
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
    }

    // Finds a room member whose name matches the query, preferring an exact
    // (case-insensitive) name match and falling back to a prefix match.
    private matchRoomMemberByName(query: string): { memberNumber: number; name: string } | undefined {
        const lowerQuery = query.toLowerCase();
        let prefixMatch: { memberNumber: number; name: string } | undefined;
        for (const roomMemberNumber of this.roomMembers) {
            const name = this.nameCache.get(roomMemberNumber);
            if (!name) continue;
            const lowerName = name.toLowerCase();
            if (lowerName === lowerQuery) {
                return { memberNumber: roomMemberNumber, name };
            }
            if (!prefixMatch && lowerName.startsWith(lowerQuery)) {
                prefixMatch = { memberNumber: roomMemberNumber, name };
            }
        }
        return prefixMatch;
    }

    // Starts (or restarts) the yes/no confirmation window for an admin's
    // proxied feedback submission on behalf of a room member.
    private startAdminFeedbackProxy(adminMemberNumber: number, target: { memberNumber: number; name: string }, text: string): void {
        const existing = this.pendingAdminFeedbackProxy.get(adminMemberNumber);
        if (existing) clearTimeout(existing.timeout);

        const timeout = setTimeout(() => {
            this.pendingAdminFeedbackProxy.delete(adminMemberNumber);
            this.bot.whisper(adminMemberNumber, "Feedback proxy confirmation timed out — nothing was logged.");
        }, ADMIN_FEEDBACK_PROXY_TIMEOUT_MS);

        this.pendingAdminFeedbackProxy.set(adminMemberNumber, {
            targetMemberNumber: target.memberNumber,
            targetName: target.name,
            text,
            timeout,
        });

        this.bot.whisper(
            adminMemberNumber,
            `Did you mean to submit this feedback on behalf of **${target.name}**? Reply **yes** to confirm or **no** to cancel.`
        );
    }

    // Yes/No confirmation for a pending admin proxy-feedback submission.
    // Returns true if the message was consumed as a yes/no answer.
    private tryHandleAdminFeedbackProxyYesNo(memberNumber: number, msg: string): boolean {
        const pending = this.pendingAdminFeedbackProxy.get(memberNumber);
        if (!pending) return false;
        if (msg === "yes" || msg === "y") {
            clearTimeout(pending.timeout);
            this.pendingAdminFeedbackProxy.delete(memberNumber);
            this.logFeedbackEntry(pending.targetMemberNumber, pending.targetName, pending.text);
            this.bot.whisper(memberNumber, `Feedback logged on behalf of ${pending.targetName}.`);
            return true;
        }
        if (msg === "no" || msg === "n") {
            clearTimeout(pending.timeout);
            this.pendingAdminFeedbackProxy.delete(memberNumber);
            this.bot.whisper(memberNumber, "Feedback cancelled.");
            return true;
        }
        return false;
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
            if (clothing.length < SOLO_BRACKET_MIN) {
                this.bot.whisper(memberNumber, `You need at least ${SOLO_BRACKET_MIN} items to start — let's try again.`);
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
        this.bot.whisper(memberNumber, `${solo.name}, you're at ${solo.currentMax} — !roll.`);
        this.startSoloInactivityTimer(memberNumber);
    }

    private handleSoloRoll(memberNumber: number): void {
        const solo = this.soloGames.get(memberNumber);
        if (!solo) return;

        this.clearSoloInactivityTimer(solo);

        if (solo.awaitingRemoval) {
            const lostItem = solo.clothingLost[solo.clothingLost.length - 1];
            this.bot.whisper(memberNumber, `⏸️ Remove your ${lostItem}.`);
            this.startSoloInactivityTimer(memberNumber);
            return;
        }

        let roll: number;
        if (this.debugNextRoll !== null) {
            roll = this.debugNextRoll;
            this.debugNextRoll = null;
        } else {
            roll = Math.floor(Math.random() * solo.currentMax) + 1;
        }
        solo.totalRolls++;
        solo.rollsThisItem++;

        if (roll === 1) {
            const lostItem = solo.clothingRemaining.shift()!;
            solo.clothingLost.push(lostItem);

            this.bot.whisper(memberNumber,
                `You rolled a 1 — lost your ${lostItem}! (${solo.rollsThisItem} roll${solo.rollsThisItem === 1 ? "" : "s"} for that item, ${solo.totalRolls} total)`
            );

            solo.awaitingRemoval = true;
            this.bot.whisper(memberNumber, `Remove your ${lostItem}.`);
            this.startSoloInactivityTimer(memberNumber);
            return;
        }

        solo.currentMax = roll;
        this.bot.whisper(memberNumber, `You are now at ${roll} — !roll again.`);
        this.startSoloInactivityTimer(memberNumber);
    }

    // Called once the player confirms (whispered !removed, or closed their
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
        this.bot.whisper(memberNumber, `${solo.name}, you're at ${solo.currentMax} — !roll.`);
        this.startSoloInactivityTimer(memberNumber);
    }

    // Soft nudge if the player goes quiet after a prompt. Does not end the
    // game; resets whenever the player acts. While awaiting a clothing
    // removal, we wait for the Wardrobe-close event (handleWardrobe) rather
    // than rushing the player, only mentioning !removed as a fallback if
    // SOLO_REMOVAL_REMINDER_MS passes with no Wardrobe activity — then keeps
    // re-reminding every interval until they act.
    private startSoloInactivityTimer(memberNumber: number): void {
        const solo = this.soloGames.get(memberNumber);
        if (!solo) return;

        this.clearSoloInactivityTimer(solo);
        if (solo.awaitingRemoval) {
            solo.inactivityTimer = setTimeout(() => {
                solo.inactivityTimer = null;
                const lostItem = solo.clothingLost[solo.clothingLost.length - 1];
                this.bot.whisper(memberNumber, `Remove your ${lostItem} or type !removed if you have already removed them to continue.`);
                this.startSoloInactivityTimer(memberNumber);
            }, SOLO_REMOVAL_REMINDER_MS);
        } else {
            solo.inactivityTimer = setTimeout(() => {
                solo.inactivityTimer = null;
                this.bot.whisper(memberNumber, "Whenever you're ready — type !roll to continue.");
            }, SOLO_INACTIVITY_TIMEOUT_MS);
        }
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

        const entry: SoloRecordEntry = { memberNumber, name: solo.name, rolls: score };

        // No all-time record yet for this mode/bracket: this run sets it (and
        // the daily record) penalty-free — the first player to finish in a
        // bracket always gets a free run, since there's no record to beat.
        if (!allTimeRecord) {
            records.daily[solo.mode][bracketKey] = entry;
            records.allTime[solo.mode][bracketKey] = entry;
            this.bot.whisper(memberNumber, `🏆 You set the all-time record for ${modeLabel} (${solo.bracket}-item bracket) — ${score} rolls! No penalty for being first.`);

            logGameEvent(`[SOLO END] mode: ${solo.mode} | bracket: ${solo.bracket} | player: ${solo.name} | score: ${score} rolls | outcome: record-beaten`);
            this.appendGameLog({
                type: "solo", mode: solo.mode, startTime: solo.startTime, endTime,
                players, outcome: "record-beaten", score,
            });

            this.incrementGameCount("solo_strip");
            this.removeAllItems(memberNumber);
            this.saveSoloRecords(records);
            return;
        }

        if (this.isSoloRecordBeat(solo.mode, score, allTimeRecord)) {
            records.daily[solo.mode][bracketKey] = entry;
            records.allTime[solo.mode][bracketKey] = entry;
            this.bot.sendChat(`🎲 ${solo.name} set a new daily record for ${modeLabel} (${solo.bracket}-item bracket) — ${score} rolls!`);
            this.bot.sendChat(`🏆 That's also a new ALL-TIME record for ${modeLabel} (${solo.bracket}-item bracket)!`);

            logGameEvent(`[SOLO END] mode: ${solo.mode} | bracket: ${solo.bracket} | player: ${solo.name} | score: ${score} rolls | outcome: record-beaten`);
            this.appendGameLog({
                type: "solo", mode: solo.mode, startTime: solo.startTime, endTime,
                players, outcome: "record-beaten", score,
            });

            this.incrementGameCount("solo_strip");
            this.removeAllItems(memberNumber);
            this.saveSoloRecords(records);
            return;
        }

        // All-time record stands, but no daily record yet today (or this run
        // beats today's daily record): set/keep the daily record, no penalty.
        if (!dailyRecord || this.isSoloRecordBeat(solo.mode, score, dailyRecord)) {
            records.daily[solo.mode][bracketKey] = entry;
            this.bot.sendChat(`🎲 ${solo.name} set a new daily record for ${modeLabel} (${solo.bracket}-item bracket) — ${score} rolls!`);

            logGameEvent(`[SOLO END] mode: ${solo.mode} | bracket: ${solo.bracket} | player: ${solo.name} | score: ${score} rolls | outcome: record-beaten`);
            this.appendGameLog({
                type: "solo", mode: solo.mode, startTime: solo.startTime, endTime,
                players, outcome: "record-beaten", score,
            });

            this.incrementGameCount("solo_strip");
            this.removeAllItems(memberNumber);
            this.saveSoloRecords(records);
            return;
        }

        const recordRolls = dailyRecord.rolls;
        this.bot.whisper(memberNumber, `You didn't beat the record (${recordRolls} rolls). Better luck next time!`);

        const attemptsToday = records.attempts[solo.mode][bracketKey]?.[String(memberNumber)] ?? 0;
        const penaltyMinutes = SOLO_BASE_PENALTY_MINUTES + attemptsToday;
        setTimeout(() => {
            this.applySoloPenalty(memberNumber, penaltyMinutes);
        }, SOLO_BONDAGE_DELAY_MS);

        logGameEvent(`[SOLO END] mode: ${solo.mode} | bracket: ${solo.bracket} | player: ${solo.name} | score: ${score} rolls | outcome: loss | penalty: ${penaltyMinutes}min`);
        this.appendGameLog({
            type: "solo", mode: solo.mode, startTime: solo.startTime, endTime,
            players, outcome: "loss", score, penaltyMin: penaltyMinutes,
        });

        this.incrementGameCount("solo_bondage");
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
        const name = this.nameCache.get(memberNumber) ?? `#${memberNumber}`;

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

        // Phase 1 (apply) finishes once the last item's lock step has fired.
        const phase1CompleteDelay = (items.length - 1) * REMOVAL_SLOT_DELAY_MS + REMOVAL_UNLOCK_GAP_MS;

        // Phase 2: after everything is locked, verify each lock using the same
        // silence=success / ChatRoomSyncSingle=rejection model as end-game locks.
        let lastVerifyDelay = 0;
        items.forEach((item, i) => {
            const verifyDelay = phase1CompleteDelay + i * REMOVAL_SLOT_DELAY_MS;
            lastVerifyDelay = verifyDelay;
            setTimeout(() => {
                this.verifySoloLockApplied(memberNumber, name, item, lockEndTime, penaltyMinutes, 0);
            }, verifyDelay);
        });

        // The "penalty applied" whisper waits until the full verify pass
        // (including any retries' own verify windows) has had time to land.
        const allVerificationsCompleteDelay = lastVerifyDelay + LOCK_VERIFY_DELAY_MS;
        setTimeout(() => {
            this.bot.whisper(memberNumber, `⛓️ Bondage penalty applied — locked for ${penaltyMinutes} minutes.`);
        }, allVerificationsCompleteDelay);
    }

    // Re-applies one solo penalty lock item and starts its verification window.
    private applySoloLockItem(memberNumber: number, name: string, item: BondageItem, lockEndTime: number, penaltyMinutes: number, attempt: number): void {
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
        this.verifySoloLockApplied(memberNumber, name, item, lockEndTime, penaltyMinutes, attempt);
    }

    // Same silence=success / ChatRoomSyncSingle=rejection model as
    // verifyEndGameLockApplied(), applied to solo penalty locks.
    private verifySoloLockApplied(memberNumber: number, name: string, item: BondageItem, lockEndTime: number, penaltyMinutes: number, attempt: number): void {
        const key = `${memberNumber}:${item.group}`;

        const existing = this.pendingLockApplyChecks.get(key);
        if (existing) this.pendingLockApplyChecks.delete(key);

        const finish = (rejected: boolean) => {
            if (!this.pendingLockApplyChecks.has(key)) return;
            this.pendingLockApplyChecks.delete(key);

            if (!rejected) {
                log(`Solo lock verification: ${name} (#${memberNumber}) ${item.group}/${item.name} confirmed (no rejection received).`);
                return;
            }

            log(`Solo lock verification: BC rejected lock for ${name} (#${memberNumber}) on ${item.group}/${item.name} (attempt ${attempt}/${MAX_END_GAME_LOCK_RETRIES}).`);

            if (attempt >= MAX_END_GAME_LOCK_RETRIES) {
                log(`SOLO LOCK VERIFY FAILED: giving up on ${name} (#${memberNumber}) ${item.group}/${item.name} after ${attempt} attempts`);
                this.bot.whisper(memberNumber, "⚠️ One or more locks may not have applied correctly — please check your items.");
                return;
            }

            const retry = () => this.applySoloLockItem(memberNumber, name, item, lockEndTime, penaltyMinutes, attempt + 1);
            if (this.bot.isReconnecting()) {
                log(`Reconnect in progress — delaying solo lock retry for ${name} (#${memberNumber}) ${item.group}/${item.name} until reconnected.`);
                this.bot.onceConnected(retry);
            } else {
                retry();
            }
        };

        this.pendingLockApplyChecks.set(key, { itemName: item.name, onResult: finish });
        setTimeout(() => finish(false), LOCK_VERIFY_DELAY_MS);
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

    private loadGameCounts(): { multiplayer: number; solo_strip: number; solo_bondage: number; aborted: number; team_2v2: number; team_3v3: number; toysDeclineCount: number; lastUpdated: string } {
        try {
            const raw = fs.readFileSync(this.gameCountsPath, "utf8");
            const parsed = JSON.parse(raw);
            parsed.team_2v2 ??= 0;
            parsed.team_3v3 ??= 0;
            return parsed;
        } catch {
            return { multiplayer: 0, solo_strip: 0, solo_bondage: 0, aborted: 0, team_2v2: 0, team_3v3: 0, toysDeclineCount: 0, lastUpdated: new Date().toISOString() };
        }
    }

    private incrementGameCount(type: "multiplayer" | "solo_strip" | "solo_bondage" | "aborted" | "team_2v2" | "team_3v3"): void {
        const counts = this.loadGameCounts();
        counts[type]++;
        counts.lastUpdated = new Date().toISOString();
        try {
            fs.writeFileSync(this.gameCountsPath, JSON.stringify(counts, null, 2), "utf8");
        } catch (err) {
            log(`ERROR: Failed to write game_counts.json: ${err}`);
        }
    }

    // Running total across all games of explicit "no" answers to the toys
    // consent question (late-join timeouts/declines are NOT counted here —
    // only players who actually answered "no").
    private incrementToysDeclineCount(): void {
        const counts = this.loadGameCounts();
        counts.toysDeclineCount = (counts.toysDeclineCount ?? 0) + 1;
        counts.lastUpdated = new Date().toISOString();
        try {
            fs.writeFileSync(this.gameCountsPath, JSON.stringify(counts, null, 2), "utf8");
        } catch (err) {
            log(`ERROR: Failed to write game_counts.json: ${err}`);
        }
    }

    // Logs a "[GAME END] multiplayer" line plus a game_log.json entry, and
    // marks this game's end as logged so resetGame() doesn't log it again
    // as a generic "reset".
    private logMultiplayerGameEnd(outcome: "win" | "all-bound" | "reset" | "aborted", options?: { winner?: string; logSuffix?: string }): void {
        const playerNames = [...this.players.values()].map(p => p.name).join(", ");
        const outcomeLabel = options?.logSuffix ? `${outcome} (${options.logSuffix})` : outcome;
        const winnerPart = options?.winner ? ` | winner: ${options.winner}` : "";
        const teamTag = this.isTeamMode ? ` | team: ${this.teamSize}v${this.teamSize}` : "";
        logGameEvent(`[GAME END] multiplayer${teamTag} | outcome: ${outcomeLabel}${winnerPart} | players: ${playerNames}`);

        const entry: GameLogEntry = {
            type: "multiplayer",
            mode: null,
            startTime: this.gameStartTime ?? new Date().toISOString(),
            endTime: new Date().toISOString(),
            players: [...this.players.values()].map(p => `${p.name}(#${p.memberNumber})`),
            outcome,
        };
        if (options?.winner) entry.winner = options.winner;
        if (this.isTeamMode) {
            entry.isTeamMode = true;
            entry.teamSize = this.teamSize;
        }
        this.appendGameLog(entry);
        this.gameEndLogged = true;

        if (outcome === "win" || outcome === "all-bound") {
            this.logOutfitCandidates();
        }

        if (outcome === "win" || outcome === "all-bound") {
            if (this.isTeamMode) {
                this.incrementGameCount(this.teamSize === 3 ? "team_3v3" : "team_2v2");
            } else {
                this.incrementGameCount("multiplayer");
            }
        } else {
            this.incrementGameCount("aborted");
        }
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

        let changed = false;

        const resolvedToShow = entry.items.filter(item =>
            RESOLVED_FEEDBACK_STATUSES.has(item.status) && !item.statusShown
        );
        if (resolvedToShow.length > 0) {
            const lines = resolvedToShow.map((item, i) =>
                `${i + 1}. "${item.text}" — ${FEEDBACK_STATUS_LABELS[item.status] ?? item.status}`
            );
            this.sendLongWhisper(memberNumber,
                `Hi ${name}! Here's an update on the feedback you've sent us:\n` +
                lines.join("\n") +
                `\n\nThanks for helping us improve the game! 💕`
            );
            for (const item of resolvedToShow) {
                item.statusShown = true;
            }
            changed = true;
        }

        const reviewingItems = entry.items.filter(item => REVIEWING_FEEDBACK_STATUSES.has(item.status));
        if (reviewingItems.length > 0) {
            const ackDate = entry.reviewingAckDate ? new Date(entry.reviewingAckDate) : null;
            const hasNewSinceAck = reviewingItems.some(item => !ackDate || new Date(item.timestamp) > ackDate);
            if (hasNewSinceAck) {
                this.sendLongWhisper(memberNumber,
                    `Hi ${name}! We've received your feedback and are reviewing it. We'll let you know when there's an update!`
                );
                entry.reviewingAckDate = new Date().toISOString();
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
                    "Welcome! Some solo games are already going — type !solo race or !solo survive to start your own, or !join to request a multiplayer game.\n🆕 NEW: Try !teamgame for 2v2 or 3v3 team play!"
                );
            } else {
                this.bot.whisper(memberNumber,
                    "Welcome! You can play a solo game (!solo race or !solo survive) or type !join to start a multiplayer game and wait for others.\n🆕 NEW: Try !teamgame for 2v2 or 3v3 team play!"
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
        if (this.isTeamMode) return false; // no mid-game joins into a team game — see handleJoin
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

    // Called once a game reaches its conclusion (either winner(s) are found
    // or everyone is bound), crediting every participant with a completed game.
    private recordGameCompletion(winnerMemberNumbers: number[] | null): void {
        for (const player of this.players.values()) {
            const record = this.playerRecords[String(player.memberNumber)];
            if (!record) continue;
            record.gamesPlayed++;
            if (winnerMemberNumbers !== null && winnerMemberNumbers.includes(player.memberNumber)) {
                record.gamesWon++;
            } else if (player.isFullyBound) {
                record.gamesLost++;
            }
        }
        this.savePlayerRecords();
    }

    private handleFeedbackList(memberNumber: number): void {
        if (!this.requireAdmin(memberNumber)) return;

        const entries = Object.entries(this.feedbackStatus).filter(([k]) => !k.startsWith("_"));
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
            `!help solo - Solo whisper game & leaderboard commands\n` +
            `!help team - Team mode (2v2/3v3) rules${this.isTeamMode ? " — a team game is running now!" : ""}\n`;

        if (this.isAdmin(memberNumber)) {
            text += `!help admin - Admin commands\n`;
        }

        text += `!about - About this bot`;

        this.sendLongWhisper(memberNumber, text);
    }

    private handleHelpTeam(memberNumber: number): void {
        const text =
            `=== Team Mode (2v2 / 3v3) ===\n` +
            `!teamgame - Start a team game (asks for team size, then teams sign up)\n` +
            `!join team1 / !join team2 - Pick your side during team setup\n` +
            `!teams - Show current team rosters (and who's a ghost)\n` +
            `Turn order alternates between teams (Team 1, Team 2, Team 1, ...). Everything else — clothing, rolling, bondage — works exactly like a normal game.\n` +
            `\n` +
            `Win condition: a team is eliminated once every one of its members is fully bound. The other team wins!\n` +
            `\n` +
            `👻 Ghosts: if a player safewords mid-game, they become a ghost instead of leaving — their turns auto-roll a 1 (so they keep stripping/binding) but the game never pauses for them. If this brings both teams back to equal active-player counts, everyone still active gets a whisper vote to keep the ghost rolls or drop that player from the game entirely.`;

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
            `!removed - Confirm you removed a clothing item\n` +
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
            `!removed - Whisper this once you've taken off an item the game told you to remove (or just close your Wardrobe). No rush, the game waits for you.\n` +
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
            `!solo_reset [player name] - Discard a player's solo game with no penalty\n` +
            `!gamestats - Show cumulative game counts (multiplayer / team / solo / aborted)`;

        this.sendLongWhisper(memberNumber, text);
    }

    private handleGameStats(memberNumber: number): void {
        if (!this.requireAdmin(memberNumber)) return;
        const counts = this.loadGameCounts();
        const total = counts.multiplayer + counts.solo_strip + counts.solo_bondage + counts.aborted + counts.team_2v2 + counts.team_3v3;
        this.bot.whisper(memberNumber,
            `=== Game Stats ===\n` +
            `Multiplayer: ${counts.multiplayer}\n` +
            `Team 2v2: ${counts.team_2v2}\n` +
            `Team 3v3: ${counts.team_3v3}\n` +
            `Solo (strip): ${counts.solo_strip}\n` +
            `Solo (bondage): ${counts.solo_bondage}\n` +
            `Aborted: ${counts.aborted}\n` +
            `Total: ${total}\n` +
            `Last updated: ${counts.lastUpdated}`
        );
    }

    private handleRoll(memberNumber: number, name: string): void {
        if (this.state === GameState.WaitingRemove) {
            this.bot.sendChat(`⚠️ ${name}, please remove your item first and type !removed before rolling!`);
            return;
        }
        if (this.state !== GameState.Rolling) return;

        // Late joiners must answer the bondage mode question before their
        // first roll — holds their turn instead of racing the question.
        if (this.awaitingLateBondageMode.has(memberNumber)) {
            this.bot.whisper(memberNumber, "Please answer the bondage mode question above first (outfit/pick) before rolling.");
            return;
        }

        // Second chance takes priority: only the active second-chance player can roll.
        if (this.activeSecondChance !== null) {
            if (memberNumber === this.activeSecondChance) {
                this.handleSecondChanceRoll(memberNumber, name);
            }
            return;
        }

        const currentPlayer = this.getCurrentPlayer();
        if (!currentPlayer || currentPlayer.memberNumber !== memberNumber) {
            this.bot.sendChat(`It's not your turn, ${name}!`);
            return;
        }

        this.clearTurnTimer();

        let roll: number;
        if (this.debugNextRoll !== null) {
            roll = this.debugNextRoll;
            this.debugNextRoll = null;
        } else {
            roll = Math.floor(Math.random() * this.currentDiceMax) + 1;
        }
        this.bot.sendChat(`🎲 ${this.teamLabel(currentPlayer)}${name} rolls a D${this.currentDiceMax}... and gets ${roll}!`);

        const isD100 = this.currentDiceMax === STARTING_DICE_MAX;
        this.emitBonusRollCommentary(roll, this.currentDiceMax);

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

    // Bonus flavor commentary fired after a roll's result is known — repeated
    // same-number streaks and a 69 easter egg. Purely cosmetic: never touches
    // game state, scoring, or turn flow beyond this.lastRollValue/rollStreakCount
    // (which exist only to drive this commentary).
    private emitBonusRollCommentary(roll: number, diceMax: number): void {
        this.totalRollsThisGame++;
        const isFirstRoll = this.totalRollsThisGame === 1;

        if (roll === 69 && !isFirstRoll) {
            this.bot.sendChat(pickRandomMessage(SIXTY_NINE_MESSAGES));
            this.lastRollValue = null;
            this.rollStreakCount = 0;
            return;
        }

        if (this.lastRollValue === roll) {
            this.rollStreakCount++;
        } else {
            this.lastRollValue = roll;
            this.rollStreakCount = 1;
        }

        if (this.rollStreakCount >= 2 && Math.pow(1 / diceMax, this.rollStreakCount - 1) < 0.01) {
            this.bot.sendChat(formatStreakMessage(roll));
        }
    }

    public handleWardrobeOpen(memberNumber: number): void {
        if (this.state !== GameState.WaitingRemove) return;
        const currentPlayer = this.getCurrentPlayer();
        if (!currentPlayer || currentPlayer.memberNumber !== memberNumber) return;
        // They opened their wardrobe — cancel the 15s nudge and wait for them to close it
        this.clearTurnTimer();
    }

    public handleWardrobe(memberNumber: number, name: string): void {
        if (this.soloGames.get(memberNumber)?.awaitingRemoval) {
            this.handleSoloRemoved(memberNumber);
            return;
        }

        const player = this.players.get(memberNumber);
        if (!player) return;

        const isLiveTurn = this.state === GameState.WaitingRemove && this.getCurrentPlayer()?.memberNumber === memberNumber;
        if (!isLiveTurn && !player.pendingRemovalKick) return;

        this.handleRemoved(memberNumber, name);
    }

    // Confirms a removal either (a) live, during this player's active
    // WaitingRemove turn, or (b) "banked" early/out of turn — a player whose
    // removal window was skipped (pendingRemovalKick) gets credited the
    // moment they confirm, rather than being forced to wait for their next
    // turn's re-prompt (see resolveCurrentTurn's pendingRemovalKick branch).
    // That gap used to silently reject any !removed/wardrobe-close sent
    // while it wasn't their exact current turn, with no way to recover
    // before the kick timer ran out — see wd_todo-equivalent bug notes.
    private handleRemoved(memberNumber: number, name: string): void {
        const player = this.players.get(memberNumber);
        if (!player) return;

        const isLiveTurn = this.state === GameState.WaitingRemove && this.getCurrentPlayer()?.memberNumber === memberNumber;
        const isBankedEarly = !isLiveTurn && player.pendingRemovalKick;

        if (!isLiveTurn && !isBankedEarly) {
            this.bot.whisper(memberNumber, "Got it — I'll be watching for your wardrobe to close, no need to send !removed right now.");
            return;
        }

        if (isLiveTurn) this.clearTurnTimer();
        player.removalWarned = false;
        player.pendingRemovalKick = false;
        player.pendingRemovalBaselineCount = null;
        player.clothingRemoved++;

        this.bot.sendChat(`✅ ${name} has removed their item.`);

        if (isBankedEarly) {
            // Not their active turn — don't touch game flow (another
            // player's turn is in progress). Clearing pendingRemovalKick
            // above is enough; resolveCurrentTurn will let them roll
            // normally instead of re-prompting when it cycles back to them.
            this.bot.whisper(memberNumber, "Got it — you're all set, no need to do anything else.");
            return;
        }

        if (player.pendingPenaltySteps > 0) {
            player.pendingPenaltySteps--;
            this.applyPendingPenaltyStep(player, name);
            return;
        }

        this.bot.sendChat(`Continuing the game...`);

        // Loser rolls first next round with fresh D100
        this.currentDiceMax = STARTING_DICE_MAX;

        if (this.maybeStartJoinPause(() => this.resumeRollsFirst(name))) return;
        this.resumeRollsFirst(name);
    }

    // Puts the current player back in the Rolling state to take the
    // "loser rolls first" turn after a removal (or after a join pause
    // for that turn finishes).
    private resumeRollsFirst(name: string): void {
        this.state = GameState.Rolling;
        this.startTurnTimer();
        this.bot.sendChat(`🎲 ${name} rolls first — !roll (D${this.currentDiceMax})`);
    }

    // ============================================================
    // GAME FLOW
    // ============================================================

    private checkAllJoined(): void {
        if (this.awaitingMinMaxReply) return;

        const nonBotMembers = [...this.roomMembers].filter(n => n !== this.bot.getMemberNumber());
        const joinedCount = this.players.size;

        if (joinedCount < this.minPlayers) return;

        const roomFull = joinedCount >= nonBotMembers.length && nonBotMembers.length > 0;
        const maxReached = this.lobbyOpen && joinedCount >= this.maxPlayers;

        if (roomFull || maxReached) {
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

        // Warn any already-joined player whose permissions may have changed
        // since they used !join (e.g. they toggled AllowItem off, or the bot
        // was updated and now has a version gap with one of them). This is a
        // soft warning — they stay in the game so they can fix the setting.
        for (const [, player] of this.players) {
            const char = this.characterDataCache.get(player.memberNumber);
            if (!char) continue;
            const oss = char.OnlineSharedSettings;
            if (oss?.AllowItem === false) {
                this.bot.whisper(player.memberNumber,
                    "⚠️ Heads up: your item permission is currently blocking interactions. " +
                    "Enable \"Allow others to add items\" in Online Settings → Items or bondage penalties won't apply."
                );
            } else if (oss?.GameVersion && this.botGameVersion &&
                       this.parseBCVersion(oss.GameVersion) > this.parseBCVersion(this.botGameVersion)) {
                this.bot.whisper(player.memberNumber,
                    "⚠️ Heads up: your BC version may not be compatible with this bot. " +
                    "Item interactions may not work correctly."
                );
            }
        }

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
        if (this.players.size < this.minPlayers) return;
        if (this.awaitingToysConsent) return;
        if (this.awaitingBondageMode) return;
        if (this.awaitingSlotConsent) return;
        for (const [, player] of this.players) {
            if (!player.ready) return;
        }

        this.beginToysConsent();
    }

    // The moment the game would normally start: every ready player is asked,
    // simultaneously, whether the eventual winner may add toys/touch them.
    // The game doesn't actually start until everyone has answered or the
    // window times out (unanswered players are then treated as "no").
    private beginToysConsent(): void {
        clearTimeout(this.toysConsentTimer);
        this.toysConsentTimer = null;
        this.awaitingToysConsent = true;
        for (const player of this.players.values()) {
            player.toysConsent = null;
            this.bot.whisper(player.memberNumber,
                "Before we start — is it OK for the winner to add toys and touch you at the end of the game? (yes/no)"
            );
            logGameEvent(`[ToysConsent] Sent question to ${player.name} (#${player.memberNumber})`);
        }
        this.toysConsentTimer = setTimeout(() => this.resolveToysConsent(), TOYS_CONSENT_TIMEOUT_MS);
    }

    // Records one player's answer to the pre-game toys question and starts
    // the game immediately once everyone still in the lobby has answered.
    private recordToysConsentAnswer(memberNumber: number, accepted: boolean): void {
        const player = this.players.get(memberNumber);
        if (!player || player.toysConsent !== null) return;
        player.toysConsent = accepted;
        logGameEvent(`[ToysConsent] ${player.name} (#${player.memberNumber}) answered: ${accepted ? "yes" : "no"}`);
        if (!accepted) this.incrementToysDeclineCount();

        if ([...this.players.values()].every(p => p.toysConsent !== null)) {
            this.resolveToysConsent();
        }
    }

    // Finalizes toysAllowed from however many players answered (anyone still
    // unanswered when this fires — i.e. the 60s window expired — counts as
    // "no") and starts the game.
    private resolveToysConsent(): void {
        if (!this.awaitingToysConsent) return;
        for (const player of this.players.values()) {
            logGameEvent(`[ToysConsent] Resolving — ${player.name}: ${player.toysConsent}`);
        }
        this.awaitingToysConsent = false;
        if (this.toysConsentTimer) {
            clearTimeout(this.toysConsentTimer);
            this.toysConsentTimer = null;
        }

        for (const player of this.players.values()) {
            if (player.toysConsent === null) player.toysConsent = false;
        }
        this.toysAllowed = [...this.players.values()].every(p => p.toysConsent === true);
        logGameEvent(`[ToysConsent] Result: toysAllowed=${this.toysAllowed}`);

        if (this.toysAllowed) {
            this.bot.sendChat("All players have agreed — the winner may add toys at the end of the game! 🎉");
        } else {
            this.bot.sendChat("Not everyone agreed to toys this round — toys will not be part of this game.");
        }

        // The 60s wait gives a window for someone new to join the lobby (or an
        // existing player to un-ready via !wearing) before the game actually
        // starts. If that happened, hold off — the next !ready re-runs
        // checkAllReady() and we'll re-evaluate from there.
        if (this.players.size < this.minPlayers || [...this.players.values()].some(p => !p.ready)) {
            return;
        }

        this.beginBondageModeSelection();
    }

    // Alternating turn order [T1P1, T2P1, T1P2, T2P2, ...], players within
    // each team kept in join order (not shuffled).
    private buildTeamTurnOrder(): number[] {
        const t1 = this.teamRoster[1];
        const t2 = this.teamRoster[2];
        const order: number[] = [];
        const max = Math.max(t1.length, t2.length);
        for (let i = 0; i < max; i++) {
            if (t1[i] !== undefined) order.push(t1[i]);
            if (t2[i] !== undefined) order.push(t2[i]);
        }
        return order;
    }

    private startGame(): void {
        this.state = GameState.Rolling;
        this.lobbyOpen = false;
        this.awaitingMinMaxReply = false; // lobby sizing is settled once play begins
        this.pendingSlotConsent.clear(); // players who never answered keep the tier-1 defaults

        // Generate password
        this.gamePassword = TEST_MODE ? TEST_PASSWORD : generatePassword();
        log(`Game password: ${this.gamePassword} (TEST_MODE: ${TEST_MODE})`);

        // Build turn order: alternating team1/team2 in team mode, random otherwise.
        this.turnOrder = this.isTeamMode ? this.buildTeamTurnOrder() : [...this.players.keys()];
        if (!this.isTeamMode) this.shuffleArray(this.turnOrder);
        this.currentTurnIndex = 0;
        this.currentDiceMax = STARTING_DICE_MAX;
        this.lastRollValue = null;
        this.rollStreakCount = 0;
        this.totalRollsThisGame = 0;

        this.activeMultiplayer = true;
        const playerNames = [...this.players.values()].map(p => p.name).join(", ");
        const teamTag = this.isTeamMode ? ` | team: ${this.teamSize}v${this.teamSize}` : "";
        logGameEvent(`[GAME START] multiplayer${teamTag} | players: ${playerNames} | lock: ${this.lockDurationMinutes}min`);
        this.writeBotState();

        const orderNames = this.turnOrder
            .map(n => {
                const p = this.players.get(n);
                return p ? `${this.teamLabel(p)}${p.name}` : this.getPlayerName(n);
            })
            .join(" → ");
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
        this.bot.whisper(player.memberNumber, `${player.name} roll your (D${this.currentDiceMax}) dice with !roll`);
    }

    private advanceTurn(): void {
        this.currentTurnIndex = (this.currentTurnIndex + 1) % this.turnOrder.length;

        // Decrement all pending second-chance countdowns.
        for (const sc of this.secondChanceQueue) {
            sc.countdown--;
        }

        // Fire the first ready second chance (if any) before starting the next regular turn.
        const readyIdx = this.secondChanceQueue.findIndex(sc => sc.countdown <= 0);
        if (readyIdx !== -1) {
            const sc = this.secondChanceQueue.splice(readyIdx, 1)[0];
            const candidate = this.players.get(sc.memberNumber);
            if (candidate && !candidate.isFullyBound && !candidate.pendingReturn) {
                this.fireSecondChance(sc.memberNumber);
                return;
            }
            // Player gone or in leave-grace — skip and fall through to regular turn.
            if (candidate) {
                candidate.missedTurnPending = false;
                candidate.missedSecondChance = false;
            }
        }

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

            if (player.isGhost) {
                this.resolveGhostTurn(player);
                return true;
            }

            if (player.pendingReturn) {
                player.leaveRoundsRemaining--;
                if (player.leaveRoundsRemaining <= 0) {
                    if (this.isWithinMinReturnWindow(player)) {
                        this.deferLeftPlayerRemoval(player);
                        this.currentTurnIndex = (this.currentTurnIndex + 1) % this.turnOrder.length;
                        continue;
                    }
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

            // Missed second chance last round — fire penalty immediately instead of rolling.
            if (player.missedSecondChance) {
                player.missedSecondChance = false;
                this.handleLoss(player);
                return true;
            }

            // Player skipped a removal last round — give them 20 seconds to confirm or be kicked.
            if (player.pendingRemovalKick) {
                this.state = GameState.WaitingRemove;
                this.bot.sendChat(`⚠️ ${player.name}, you still need to remove your item! Whisper !removed within 20 seconds or you'll be removed from the game.`);
                this.startTurnTimer(20000);
                return true;
            }

            if (this.maybeStartJoinPause(() => this.resolveCurrentTurn())) return true;

            this.state = GameState.Rolling;
            this.announceCurrentTurn();
            this.startTurnTimer();
            return true;
        }
    }

    // ============================================================
    // TEAM MODE - ghost turns
    // ============================================================

    // A ghost (safeworded/disconnected team-mode player) auto-rolls a 1 every
    // turn instead of waiting for input. Goes through the exact same
    // handleLoss() path a real roll of 1 would. Clothing removal normally
    // waits on a "!removed" whisper, which a ghost will never send — that
    // one step is auto-confirmed below. Bondage application (outfit mode)
    // is already fully automatic and needs no ghost-specific handling.
    private resolveGhostTurn(player: Player): void {
        this.bot.sendChat(`👻 ${player.name} (ghost) rolls... 1!`);
        this.handleLoss(player);

        if (this.state === GameState.WaitingRemove && this.getCurrentPlayer()?.memberNumber === player.memberNumber) {
            setTimeout(() => this.autoConfirmGhostRemoval(player), 800);
        }
    }

    // Stands in for a ghost's "!removed" confirmation. Mirrors handleRemoved()'s
    // bookkeeping, then resumes the turn cycle — which re-enters the ghost
    // check above if this same ghost is still up (e.g. "loser rolls first"
    // after a clothing removal, or a queued double-penalty step).
    private autoConfirmGhostRemoval(player: Player): void {
        if (this.state !== GameState.WaitingRemove || this.getCurrentPlayer()?.memberNumber !== player.memberNumber) {
            return;
        }
        this.clearTurnTimer();
        player.removalWarned = false;
        player.pendingRemovalKick = false;
        player.clothingRemoved++;
        this.bot.sendChat(`✅ ${player.name} (ghost) auto-removes their item.`);

        if (player.pendingPenaltySteps > 0) {
            player.pendingPenaltySteps--;
            this.applyPendingPenaltyStep(player, player.name);
            if (this.state === GameState.WaitingRemove && this.getCurrentPlayer()?.memberNumber === player.memberNumber) {
                setTimeout(() => this.autoConfirmGhostRemoval(player), 800);
            }
            return;
        }

        this.currentDiceMax = STARTING_DICE_MAX;
        setTimeout(() => this.resolveCurrentTurn(), 500);
    }

    // True if a player whose 2-round grace period just ran out hasn't yet
    // been away for the full MIN_RETURN_WINDOW_MS - i.e. removal should be
    // deferred rather than happening immediately (other players may have
    // resolved their turns quickly, cutting the grace period short in wall-
    // clock terms).
    private isWithinMinReturnWindow(player: Player): boolean {
        const elapsed = Date.now() - (player.leaveTime ?? 0);
        return elapsed < MIN_RETURN_WINDOW_MS;
    }

    // Schedules removeLeftPlayer() for whenever the 90s minimum return window
    // actually closes, instead of removing the player right away. A no-op if
    // a timer is already pending for this player. Cancelled on rejoin via
    // cancelPendingLeaveRemoval().
    private deferLeftPlayerRemoval(player: Player): void {
        const memberNumber = player.memberNumber;
        if (this.pendingLeaveRemovalTimers.has(memberNumber)) return;

        const elapsed = Date.now() - (player.leaveTime ?? 0);
        const remaining = Math.max(0, MIN_RETURN_WINDOW_MS - elapsed);
        const remainingSeconds = Math.round(remaining / 1000);
        const secondsWord = remainingSeconds === 1 ? "second" : "seconds";
        this.bot.sendChat(`${player.name} hasn't had long to return — we'll give them ${remainingSeconds} more ${secondsWord} before the game moves on.`);

        const timer = setTimeout(() => {
            this.pendingLeaveRemovalTimers.delete(memberNumber);
            const current = this.players.get(memberNumber);
            if (!current || !current.pendingReturn) return;
            this.removeLeftPlayer(current);
        }, remaining);
        this.pendingLeaveRemovalTimers.set(memberNumber, timer);
    }

    // Cancels a pending deferred-removal timer for a player, if any. Called
    // when they rejoin the room before the 90s window closes.
    private cancelPendingLeaveRemoval(memberNumber: number): void {
        const timer = this.pendingLeaveRemovalTimers.get(memberNumber);
        if (!timer) return;
        clearTimeout(timer);
        this.pendingLeaveRemovalTimers.delete(memberNumber);
    }

    // Removes a player whose post-leave grace period has expired. Returns
    // true if the game ended as a result of the removal.
    private removeLeftPlayer(player: Player): boolean {
        this.cancelPendingLeaveRemoval(player.memberNumber);
        this.bot.sendChat(`${player.name} did not return in time and has been removed from the game.`);

        this.secondChanceQueue = this.secondChanceQueue.filter(sc => sc.memberNumber !== player.memberNumber);

        // A pick targeting them is moot; a pick they were making resolves
        // via the pick timer's random fallback.
        let cancelledPickForRemoved = false;
        if (this.pendingBondagePick?.targetNumber === player.memberNumber) {
            this.cancelPendingBondagePick();
            cancelledPickForRemoved = true;
        }

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

        const ended = this.checkGameEndCondition();
        // If we cancelled a pick that had the game parked in WaitingBondage
        // (deferred leave-removal timer path — resolveCurrentTurn isn't
        // driving), restart the turn cycle ourselves.
        if (!ended && cancelledPickForRemoved && this.state === GameState.WaitingBondage) {
            this.currentDiceMax = STARTING_DICE_MAX;
            this.resolveCurrentTurn();
        }
        return ended;
    }

    // Snapshots this player's current Appearance.length (from
    // characterDataCache, updated on every ChatRoomSyncSingle/room sync) as
    // the baseline onSyncSingle compares future syncs against — the moment
    // that count drops, the removal is auto-confirmed without waiting on
    // !removed or a wardrobe open/close pair. Null baseline (no cached data
    // yet) just disables auto-detection for this prompt; manual !removed
    // and wardrobe-close still work as always.
    private markAwaitingRemoval(player: Player): void {
        player.pendingRemovalBaselineCount = this.characterDataCache.get(player.memberNumber)?.Appearance?.length ?? null;
    }

    private handleLoss(player: Player): void {
        this.clearTurnTimer();
        this.noteRoundLoser(player);

        if (player.isNaked) {
            this.applyNextBondageItem(player);
        } else {
            const nextItem = player.clothing[player.clothingRemoved];
            if (nextItem) {
                this.state = GameState.WaitingRemove;
                this.markAwaitingRemoval(player);
                this.bot.sendChat(`😳 ${this.teamLabel(player)}${player.name} rolled a 1! Remove your ${nextItem}!`);
                this.startTurnTimer(20000);

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
        this.noteRoundLoser(player);

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
            this.markAwaitingRemoval(player);
            this.startTurnTimer(20000);
        } else {
            const item1 = player.clothing[player.clothingRemoved];
            this.bot.sendChat(`💀 ${player.name} rolled a 1 — double penalty! Remove your ${item1} — bondage starts immediately after!`);
            player.pendingPenaltySteps = 1;
            player.isNaked = true;
            this.state = GameState.WaitingRemove;
            this.markAwaitingRemoval(player);
            this.startTurnTimer(20000);
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
            this.markAwaitingRemoval(player);
            this.bot.sendChat(`😳 ${name}, remove your ${nextItem} too!`);
            this.startTurnTimer(20000);

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
            Difficulty: 20,
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
        if (player.bondageMode === "player-pick") {
            this.beginPlayerPickBondage(player);
            return;
        }

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
            this.continueAfterBondageApply(player, becameFullyBound);
        }, 500);
    }

    // Shared continuation after a bondage item lands (preset outfit or
    // player-pick): announces the result, chains double-penalty items, and
    // hands the turn back to the game.
    private continueAfterBondageApply(player: Player, becameFullyBound: boolean): void {
        if (becameFullyBound) {
            player.isFullyBound = true;
            this.turnOrder = this.turnOrder.filter(n => n !== player.memberNumber);
            if (this.isTeamMode && player.teamId !== null) {
                const remaining = [...this.players.values()]
                    .filter(p => p.teamId === player.teamId && !p.isFullyBound && this.turnOrder.includes(p.memberNumber));
                this.bot.sendChat(`🔒 Team ${player.teamId}'s ${player.name} is fully bound! Team ${player.teamId} has ${remaining.length} active player${remaining.length === 1 ? "" : "s"} remaining.`);
            } else {
                this.bot.sendChat(`🔒 ${player.name} is fully bound and out of the game!`);
            }
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
    }

    // ============================================================
    // PLAYER-PICK BONDAGE MODE
    // ============================================================

    // Captures who lost this round. Each loss stamps the loser with the
    // current loss sequence number — picker selection favors the player
    // who has gone longest without rolling a 1 (lowest stamp; 0 = never).
    private noteRoundLoser(player: Player): void {
        this.lastRoundLoser = player.memberNumber;
        this.lossSeqCounter++;
        player.lastLossSeq = this.lossSeqCounter;
    }

    // --- pre-game mode selection -------------------------------

    private beginBondageModeSelection(): void {
        if (BC_ITEM_CATALOG.size === 0) {
            // Catalog unavailable — player-pick mode can't work, skip the question.
            for (const player of this.players.values()) player.bondageMode = "outfit";
            this.gameBondageMode = "outfit";
            this.startGame();
            return;
        }

        if (this.bondageModeTimer) {
            clearTimeout(this.bondageModeTimer);
            this.bondageModeTimer = null;
        }
        this.awaitingBondageMode = true;
        for (const player of this.players.values()) {
            player.bondageMode = null;
            this.sendBondageModeQuestion(player.memberNumber);
            logGameEvent(`[BondageMode] Sent question to ${player.name} (#${player.memberNumber})`);
        }
        this.bondageModeTimer = setTimeout(() => this.resolveBondageModeSelection(), BONDAGE_MODE_TIMEOUT_MS);
    }

    private sendBondageModeQuestion(memberNumber: number): void {
        this.bot.whisper(memberNumber,
            "How should your bondage penalties be chosen?\n" +
            "pick — another player picks your restraints piece by piece (you'll choose which slots are OK next, and can veto items)\n" +
            "outfit — I apply one of my predefined outfits (classic — no more questions)\n" +
            "Reply \"pick\" or \"outfit\". (60s — no answer counts as outfit)"
        );
    }

    // Asks a single late joiner (mid-game joiner once clothing is confirmed,
    // or a naked late joiner right after registering) the same mode question,
    // scoped to just this player since the group question already resolved
    // for the rest of the game.
    private askLateBondageMode(player: Player): void {
        if (BC_ITEM_CATALOG.size === 0) {
            // Catalog unavailable — player-pick mode can't work, skip the question.
            player.bondageMode = "outfit";
            return;
        }

        const existingTimer = this.lateBondageModeTimers.get(player.memberNumber);
        if (existingTimer) clearTimeout(existingTimer);

        player.bondageMode = null;
        this.awaitingLateBondageMode.add(player.memberNumber);
        this.sendBondageModeQuestion(player.memberNumber);
        logGameEvent(`[BondageMode] Sent question to ${player.name} (#${player.memberNumber}) [late join]`);

        const timer = setTimeout(() => this.resolveLateBondageMode(player.memberNumber), BONDAGE_MODE_TIMEOUT_MS);
        this.lateBondageModeTimers.set(player.memberNumber, timer);
    }

    private resolveLateBondageMode(memberNumber: number): void {
        if (!this.awaitingLateBondageMode.has(memberNumber)) return;
        this.awaitingLateBondageMode.delete(memberNumber);
        const timer = this.lateBondageModeTimers.get(memberNumber);
        if (timer) {
            clearTimeout(timer);
            this.lateBondageModeTimers.delete(memberNumber);
        }
        const player = this.players.get(memberNumber);
        if (player && player.bondageMode === null) player.bondageMode = "outfit";
    }

    private tryHandleBondageModeAnswer(memberNumber: number, msg: string): boolean {
        let mode: BondageMode | null = null;
        if (["pick", "p", "player-pick", "playerpick", "player pick", "player", "1"].includes(msg)) mode = "player-pick";
        else if (["outfit", "o", "preset", "2"].includes(msg)) mode = "outfit";
        if (!mode) return false;

        const player = this.players.get(memberNumber);
        if (!player || player.bondageMode !== null) return false;
        player.bondageMode = mode;
        logGameEvent(`[BondageMode] ${player.name} (#${memberNumber}) answered: ${mode}`);
        this.bot.whisper(memberNumber, mode === "outfit"
            ? "Preset outfit it is!"
            : "Player-pick it is — your restraints will be chosen piece by piece. 😈");

        if (this.awaitingLateBondageMode.has(memberNumber)) {
            this.resolveLateBondageMode(memberNumber);
        } else if ([...this.players.values()].every(p => p.bondageMode !== null)) {
            this.resolveBondageModeSelection();
        }
        return true;
    }

    private resolveBondageModeSelection(): void {
        if (!this.awaitingBondageMode) return;
        this.awaitingBondageMode = false;
        if (this.bondageModeTimer) {
            clearTimeout(this.bondageModeTimer);
            this.bondageModeTimer = null;
        }

        for (const player of this.players.values()) {
            if (player.bondageMode === null) player.bondageMode = "outfit";
        }

        const pickers = [...this.players.values()].filter(p => p.bondageMode === "player-pick");
        this.gameBondageMode = pickers.length === 0
            ? "outfit"
            : (pickers.length === this.players.size ? "player-pick" : "mixed");
        logGameEvent(`[BondageMode] Result: ${this.gameBondageMode}`);

        if (this.gameBondageMode === "player-pick") {
            this.bot.sendChat("Everyone chose player-pick — all restraints will be chosen piece by piece! 😈");
        } else if (this.gameBondageMode === "mixed") {
            this.bot.sendChat(`${pickers.map(p => p.name).join(", ")} chose player-pick restraints; everyone else gets preset outfits.`);
        }

        // Same guard as resolveToysConsent: the question window gives time for
        // the lobby to change — if it did, the next !ready re-evaluates.
        if (this.players.size < this.minPlayers || [...this.players.values()].some(p => !p.ready)) {
            return;
        }

        // Only player-pick players get the slot-consent question; a pure
        // outfit game has nothing more to ask.
        if (pickers.length > 0) {
            this.beginSlotConsentPhase(pickers);
        } else {
            this.startGame();
        }
    }

    // Asks each player-pick player which slots they consent to, then starts
    // the game once everyone answered or the window times out (unanswered
    // players keep the tier-1 defaults).
    private beginSlotConsentPhase(pickers: Player[]): void {
        if (this.slotConsentTimer) {
            clearTimeout(this.slotConsentTimer);
            this.slotConsentTimer = null;
        }
        this.awaitingSlotConsent = true;
        for (const player of pickers) {
            this.sendSlotConsentQuestion(player.memberNumber);
            logGameEvent(`[SlotConsent] Sent question to ${player.name} (#${player.memberNumber})`);
        }
        this.slotConsentTimer = setTimeout(() => this.resolveSlotConsentPhase(), TOYS_CONSENT_TIMEOUT_MS);
    }

    private resolveSlotConsentPhase(): void {
        if (!this.awaitingSlotConsent) return;
        this.awaitingSlotConsent = false;
        if (this.slotConsentTimer) {
            clearTimeout(this.slotConsentTimer);
            this.slotConsentTimer = null;
        }

        for (const memberNumber of this.pendingSlotConsent) {
            this.bot.whisper(memberNumber, "No answer — using the default slots (all non-sensitive).");
        }
        this.pendingSlotConsent.clear();

        if (this.players.size < this.minPlayers || [...this.players.values()].some(p => !p.ready)) {
            return;
        }

        this.startGame();
    }

    // --- slot consent ------------------------------------------

    private sendSlotConsentQuestion(memberNumber: number): void {
        if (BC_ITEM_CATALOG.size === 0) return; // player-pick disabled, don't bother
        this.pendingSlotConsent.add(memberNumber);
        this.sendLongWhisper(memberNumber,
            "Which bondage slots do you consent to having items applied to?\n" +
            "Reply with a comma-separated list, or \"all\" for everything. Pick at least 6 different areas.\n" +
            "Slots: Arms, Legs, Feet, Torso, Hands, Head, Hood, Neck, Mouth, Nipples, Breast, Pelvis, Boots\n" +
            "Sensitive slots (Pelvis, Nipples, Breast) are OFF by default — include them explicitly if you want them available.\n" +
            "(60s — no answer keeps the defaults: all non-sensitive slots.)"
        );
    }

    private handleSlotConsentAnswer(memberNumber: number, message: string): void {
        const player = this.players.get(memberNumber);
        if (!player) {
            this.pendingSlotConsent.delete(memberNumber);
            return;
        }

        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const tokens = message.split(/[,\s]+/).map(norm).filter(t => t.length > 0);

        const groups = new Set<string>();
        const ignored: string[] = [];
        let recognized = false;
        for (const token of tokens) {
            if (token === "all" || token === "everything") {
                for (const g of [...TIER1_SLOT_GROUPS, ...TIER2_SLOT_GROUPS]) groups.add(g);
                recognized = true;
            } else if (token === "none") {
                recognized = true; // explicit empty consent
            } else if (token === "default" || token === "defaults" || token === "skip") {
                for (const g of TIER1_SLOT_GROUPS) groups.add(g);
                recognized = true;
            } else if (token === "vulva" || token === "butt") {
                ignored.push(`${token} (not available yet)`); // tier 3 — higher-stakes mode not built
            } else if (CONSENT_TOKEN_GROUPS[token]) {
                for (const g of CONSENT_TOKEN_GROUPS[token]) groups.add(g);
                recognized = true;
            } else {
                ignored.push(token);
            }
        }

        if (!recognized) {
            this.bot.whisper(memberNumber,
                "I didn't recognize any slots there. Reply with slot names separated by commas (e.g. \"Arms, Legs, Mouth\"), or \"all\" for everything.");
            return;
        }

        // Player-pick needs room for the full game (7 items) — require at
        // least MIN_CONSENT_AREAS distinct areas. Mouth holds up to 3 gags
        // and "Torso" covers both torso layers, so 6 areas is enough.
        const areaCount = PICK_SLOTS.filter(s => groups.has(s.group)).length;
        if (areaCount < MIN_CONSENT_AREAS) {
            this.bot.whisper(memberNumber,
                `That's only ${areaCount} area${areaCount === 1 ? "" : "s"} — the game needs room for up to 7 items, ` +
                `so please pick at least ${MIN_CONSENT_AREAS} different areas. ` +
                `(Mouth can take up to 3 gags, and Torso covers both torso layers.) Send your full list again.`);
            return;
        }

        player.allowedSlots = [...groups];
        this.pendingSlotConsent.delete(memberNumber);
        logGameEvent(`[SlotConsent] ${player.name} (#${memberNumber}) -> ${player.allowedSlots.join(",") || "(none)"}`);

        const displays = PICK_SLOTS.filter(s => groups.has(s.group)).map(s => s.display);
        let reply = groups.size === 0
            ? "Got it — no bondage slots allowed. Pickers won't be able to choose items for you."
            : `Got it — pickable slots for you: ${displays.join(", ")}.`;
        if (ignored.length > 0) reply += ` (Ignored: ${ignored.join(", ")})`;
        this.bot.whisper(memberNumber, reply);

        if (this.awaitingSlotConsent && this.pendingSlotConsent.size === 0) {
            this.resolveSlotConsentPhase();
        }
    }

    // --- pick flow ---------------------------------------------

    // Entry point when bondage is due for a player-pick-mode player.
    private beginPlayerPickBondage(target: Player): void {
        this.state = GameState.WaitingBondage;
        this.bondagePhaseStarted = true;

        const slots = this.availablePickSlots(target);
        if (slots.length === 0) {
            // Nothing consented and unfilled remains — nothing more can be applied.
            this.bot.sendChat(`🔒 ${target.name} has no remaining slots to fill!`);
            target.pendingPenaltySteps = 0;
            this.continueAfterBondageApply(target, true);
            return;
        }

        const picker = this.choosePickerFor(target);
        this.pickerHistory.push(picker.memberNumber);
        this.pendingBondagePick = {
            pickerNumber: picker.memberNumber,
            targetNumber: target.memberNumber,
            stage: "slot",
            slotDisplay: null,
            slotGroup: null,
            options: [],
            chosenItem: null,
            vetoedItems: [],
            timer: null,
        };

        if (picker.memberNumber === target.memberNumber) {
            this.bot.sendChat(`⛓️ ${target.name} is naked — and gets to pick their own restraint!`);
        } else {
            this.bot.sendChat(`⛓️ ${target.name} is naked! ${picker.name} is picking their next restraint...`);
        }
        this.bot.whisper(picker.memberNumber, this.slotPromptText(target));
        this.startPickTimer();
    }

    // The picker is whoever has gone longest without rolling a 1 (lowest
    // lastLossSeq; 0 = never lost, which outranks everyone). Ties — including
    // round 1, where nobody has lost yet — resolve randomly among the tied.
    // The target never picks their own items, and ghosts never pick (they
    // don't respond to anything). In team mode, an opposing-team member is
    // preferred when one's available; otherwise falls back to anyone eligible.
    private choosePickerFor(target: Player): Player {
        const basePool = (includeAway: boolean) => [...this.players.values()].filter(p =>
            p.memberNumber !== target.memberNumber && !p.isFullyBound && !p.isGhost && (includeAway || !p.pendingReturn));

        let pool = basePool(false);
        if (pool.length === 0) {
            // Everyone else is away — let an away player pick; the 60s pick
            // timer auto-picks if they don't respond.
            pool = basePool(true);
        }

        if (this.isTeamMode) {
            const opposing = pool.filter(p => p.teamId !== target.teamId);
            if (opposing.length > 0) pool = opposing;
        }

        if (pool.length === 0) return target; // unreachable in practice: game would already be over

        const oldestLoss = Math.min(...pool.map(p => p.lastLossSeq));
        const tied = pool.filter(p => p.lastLossSeq === oldestLoss);
        return tied[Math.floor(Math.random() * tied.length)];
    }

    private slotPromptText(target: Player): string {
        const slots = this.availablePickSlots(target).map(s => s.display).join(", ");
        return `It's your turn to pick a bondage item for ${target.name}. Choose a slot: ${slots} — type a slot name.`;
    }

    // Slots the picker may choose for this target: consented, not already
    // filled (Mouth counts as free while any of its overflow layers is), and
    // present in the item catalog.
    private availablePickSlots(target: Player): { display: string; group: string }[] {
        return PICK_SLOTS.filter(s => {
            if (!target.allowedSlots.includes(s.group)) return false;
            const actual = s.group === "ItemMouth"
                ? this.resolveMouthGroup(target)
                : (this.isSlotFilled(target, s.group) ? null : s.group);
            if (!actual) return false;
            return (BC_ITEM_CATALOG.get(actual) ?? []).length > 0;
        });
    }

    // First free layer of Mouth/Mouth2/Mouth3, or null if all are filled.
    private resolveMouthGroup(target: Player): string | null {
        return MOUTH_OVERFLOW_GROUPS.find(g => !this.isSlotFilled(target, g)) ?? null;
    }

    private isSlotFilled(target: Player, group: string): boolean {
        if (target.appliedBondageItems.some(e => e.slot === group)) return true;
        // Also respect anything already on the character (pre-existing items).
        const cached = this.itemStateCache.get(`${target.memberNumber}:${group}`);
        return !!cached?.Name;
    }

    // Whisper input from the active picker (slot name, option number, or
    // free-text item name). Returns true if the message was consumed.
    private tryHandleBondagePickInput(memberNumber: number, message: string): boolean {
        const pending = this.pendingBondagePick;
        if (!pending || memberNumber !== pending.pickerNumber) return false;
        const input = message.trim();
        if (input.startsWith("!")) return false; // let commands through

        if (pending.stage === "slot") {
            this.handleSlotChoice(input);
            return true;
        }
        if (pending.stage === "item") {
            this.handleItemChoice(input);
            return true;
        }
        return false;
    }

    // Bare yes/no from the veto target, as aliases for !accept/!veto —
    // consistent with every other yes/no flow in the bot.
    private tryHandleVetoYesNo(memberNumber: number, msg: string): boolean {
        const pending = this.pendingBondagePick;
        if (!pending || pending.stage !== "veto" || memberNumber !== pending.targetNumber) return false;
        if (msg === "yes" || msg === "y") {
            this.handleVetoAccept(memberNumber);
            return true;
        }
        if (msg === "no" || msg === "n") {
            this.handleVeto(memberNumber);
            return true;
        }
        return false;
    }

    private handleSlotChoice(input: string): void {
        const pending = this.pendingBondagePick;
        if (!pending) return;
        const target = this.players.get(pending.targetNumber);
        if (!target) {
            this.cancelPendingBondagePick();
            return;
        }

        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const q = norm(input);
        const slots = this.availablePickSlots(target);
        const match = slots.find(s =>
            norm(s.display) === q || norm(s.group) === q ||
            (s.group === "ItemTorso2" && q === "torso2")
        );
        if (!match) {
            this.bot.whisper(pending.pickerNumber,
                `That's not an available slot for ${target.name}. Choose one of: ${slots.map(s => s.display).join(", ")}`);
            return;
        }

        const actualGroup = match.group === "ItemMouth" ? this.resolveMouthGroup(target) : match.group;
        if (!actualGroup) {
            this.bot.whisper(pending.pickerNumber, `That slot is already filled — pick a different one.`);
            return;
        }

        const { options, hasRandom } = this.buildPickList(actualGroup, this.vetoedItemsFor(pending, actualGroup));
        if (options.length === 0) {
            this.bot.whisper(pending.pickerNumber, `No items are available for that slot — pick a different one.`);
            return;
        }

        pending.slotDisplay = match.display;
        pending.slotGroup = actualGroup;
        pending.options = options;
        pending.stage = "item";
        this.sendLongWhisper(pending.pickerNumber, this.formatPickList(match.display, options, hasRandom));
        this.startPickTimer();
    }

    private handleItemChoice(input: string): void {
        const pending = this.pendingBondagePick;
        if (!pending || !pending.slotGroup) return;

        let chosen: string | null = null;
        const trimmed = input.trim();
        if (/^\d+$/.test(trimmed)) {
            const idx = parseInt(trimmed, 10);
            if (idx >= 1 && idx <= pending.options.length) {
                chosen = pending.options[idx - 1];
            } else {
                this.bot.whisper(pending.pickerNumber, `Pick a number 1-${pending.options.length} or type an item name.`);
                return;
            }
        } else {
            const result = this.fuzzyMatchItem(pending.slotGroup, trimmed, this.vetoedItemsFor(pending, pending.slotGroup));
            if (result.match) {
                chosen = result.match;
            } else if (result.candidates) {
                this.bot.whisper(pending.pickerNumber,
                    `Multiple matches: ${result.candidates.slice(0, 8).join(", ")} — be more specific.`);
                return;
            } else {
                this.bot.whisper(pending.pickerNumber,
                    `No item matching "${trimmed}" in this slot. Reply with a number 1-${pending.options.length} or an item name.`);
                return;
            }
        }

        pending.chosenItem = chosen;
        this.beginVetoStage();
    }

    private vetoedItemsFor(pending: PendingBondagePick, group: string): string[] {
        return pending.vetoedItems.filter(v => v.group === group).map(v => v.item);
    }

    // Top-N most popular items for this slot plus one random wildcard.
    // Bootstrap: below N tracked entries, fill from outfits.json items for
    // this group in the order they appear, so the list is never empty.
    private buildPickList(group: string, excluded: string[]): { options: string[]; hasRandom: boolean } {
        const catalogItems = BC_ITEM_CATALOG.get(group) ?? [];
        const usage = this.bondageUsage[group] ?? {};

        const options: string[] = Object.entries(usage)
            .filter(([name, count]) => count > 0 && !excluded.includes(name) && catalogItems.includes(name))
            .sort((a, b) => b[1] - a[1])
            .slice(0, PICK_LIST_TOP_N)
            .map(([name]) => name);

        if (options.length < PICK_LIST_TOP_N) {
            for (const outfit of BONDAGE_OUTFITS) {
                for (const item of outfit.items) {
                    if (item.group !== group || options.includes(item.name) || excluded.includes(item.name)) continue;
                    options.push(item.name);
                    if (options.length >= PICK_LIST_TOP_N) break;
                }
                if (options.length >= PICK_LIST_TOP_N) break;
            }
        }

        const rest = catalogItems.filter(n => !options.includes(n) && !excluded.includes(n));
        let hasRandom = false;
        if (rest.length > 0) {
            options.push(rest[Math.floor(Math.random() * rest.length)]);
            hasRandom = true;
        }
        return { options, hasRandom };
    }

    private formatPickList(slotDisplay: string, options: string[], hasRandom: boolean): string {
        const lines = [`Slot: ${slotDisplay} — pick one:`];
        options.forEach((name, i) => {
            const marker = hasRandom && i === options.length - 1 ? ` ← random pick (not in top ${PICK_LIST_TOP_N})` : "";
            lines.push(`${i + 1}. ${name}${marker}`);
        });
        lines.push("Or type any item name from this slot.");
        return lines.join("\n");
    }

    // Case-insensitive fuzzy match against the slot's catalog: exact (spaces
    // stripped), then startsWith, then includes. Multiple hits ask the picker
    // to clarify.
    private fuzzyMatchItem(group: string, input: string, excluded: string[]): { match?: string; candidates?: string[] } {
        const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
        const q = norm(input);
        if (!q) return {};
        const items = (BC_ITEM_CATALOG.get(group) ?? []).filter(n => !excluded.includes(n));

        const exact = items.filter(n => norm(n) === q);
        if (exact.length >= 1) return { match: exact[0] };
        const starts = items.filter(n => norm(n).startsWith(q));
        if (starts.length === 1) return { match: starts[0] };
        if (starts.length > 1) return { candidates: starts };
        const includes = items.filter(n => norm(n).includes(q));
        if (includes.length === 1) return { match: includes[0] };
        if (includes.length > 1) return { candidates: includes };
        return {};
    }

    // --- veto flow ---------------------------------------------

    private beginVetoStage(): void {
        const pending = this.pendingBondagePick;
        if (!pending || !pending.chosenItem) return;
        this.clearPickTimer();
        pending.stage = "veto";

        const target = this.players.get(pending.targetNumber);
        if (!target) {
            this.cancelPendingBondagePick();
            return;
        }

        // No veto step for self-picks, or when vetoes are disabled
        // (higher-stakes mode hook — not built yet).
        if (!this.allowVeto || pending.pickerNumber === pending.targetNumber) {
            this.applyPickedItem();
            return;
        }

        this.bot.whisper(target.memberNumber,
            `You are about to have ${pending.chosenItem} applied to your ${pending.slotDisplay}. ` +
            `Type !veto to decline, or !accept to confirm (or wait 30s to auto-accept). Yes/no works too.`);
        pending.timer = setTimeout(() => this.applyPickedItem(), VETO_TIMEOUT_MS);
    }

    private handleVeto(memberNumber: number): void {
        const pending = this.pendingBondagePick;
        if (!pending || pending.stage !== "veto" || pending.targetNumber !== memberNumber) {
            this.bot.whisper(memberNumber, "Nothing to veto right now.");
            return;
        }
        this.clearPickTimer();

        const target = this.players.get(pending.targetNumber);
        if (!target) {
            this.cancelPendingBondagePick();
            return;
        }

        const vetoed = pending.chosenItem!;
        pending.vetoedItems.push({ group: pending.slotGroup!, item: vetoed });
        pending.chosenItem = null;
        const pickerName = this.getPlayerName(pending.pickerNumber);

        const { options, hasRandom } = this.buildPickList(pending.slotGroup!, this.vetoedItemsFor(pending, pending.slotGroup!));
        if (options.length === 0) {
            // Every item in this slot has been vetoed — back to slot choice.
            pending.stage = "slot";
            pending.slotDisplay = null;
            pending.slotGroup = null;
            pending.options = [];
            this.bot.whisper(pending.pickerNumber,
                `${target.name} vetoed ${vetoed}, and no other items are available for that slot. ${this.slotPromptText(target)}`);
            this.bot.whisper(target.memberNumber, `Vetoed! ${pickerName} is choosing a different slot.`);
            this.startPickTimer();
            return;
        }

        pending.stage = "item";
        pending.options = options;
        this.sendLongWhisper(pending.pickerNumber,
            `${target.name} vetoed ${vetoed} — pick a different item.\n` +
            this.formatPickList(pending.slotDisplay!, options, hasRandom));
        this.bot.whisper(target.memberNumber, `Vetoed! ${pickerName} is picking another item.`);
        this.startPickTimer();
    }

    private handleVetoAccept(memberNumber: number): void {
        const pending = this.pendingBondagePick;
        if (!pending || pending.stage !== "veto" || pending.targetNumber !== memberNumber) {
            this.bot.whisper(memberNumber, "Nothing to accept right now.");
            return;
        }
        this.applyPickedItem();
    }

    // --- application -------------------------------------------

    private applyPickedItem(): void {
        const pending = this.pendingBondagePick;
        if (!pending || !pending.chosenItem || !pending.slotGroup) return;
        this.clearPickTimer();
        this.pendingBondagePick = null;

        const target = this.players.get(pending.targetNumber);
        if (!target) return;

        const itemName = pending.chosenItem;
        const group = pending.slotGroup;
        const pickerName = this.getPlayerName(pending.pickerNumber);

        // Apply with the most popular learned configuration for this item
        // (restraining mode etc.); {} = BC default mode if nothing learned yet.
        const setting = this.pickItemSetting(group, itemName);

        this.bot.sendChat(`⛓️ ${pickerName} chose ${itemName} for ${target.name}'s ${pending.slotDisplay}!`);
        this.bot.applyItem(target.memberNumber, group, itemName, "Default", setting);

        target.appliedBondageItems.push({ slot: group, item: itemName });
        // Mirror the pick into a synthesized outfit so the end-game lock /
        // verify / release machinery works unchanged for player-pick players
        // (and re-locks keep the same configuration).
        if (!target.bondageOutfit) {
            target.bondageOutfit = { name: "Player picks", items: [] };
        }
        target.bondageOutfit.items.push({ group, name: itemName, color: "Default", property: setting });

        this.incrementBondageUsage(group, itemName);

        setTimeout(() => {
            target.bondageApplied++;
            const becameFullyBound = target.bondageApplied >= this.bondageItemLimit
                || this.availablePickSlots(target).length === 0;
            this.continueAfterBondageApply(target, becameFullyBound);
        }, 500);
    }

    // --- timers ------------------------------------------------

    private startPickTimer(): void {
        const pending = this.pendingBondagePick;
        if (!pending) return;
        this.clearPickTimer();
        pending.timer = setTimeout(() => this.handlePickTimeout(), PICKER_RESPONSE_TIMEOUT_MS);
    }

    private clearPickTimer(): void {
        const pending = this.pendingBondagePick;
        if (pending?.timer) {
            clearTimeout(pending.timer);
            pending.timer = null;
        }
    }

    private cancelPendingBondagePick(): void {
        this.clearPickTimer();
        this.pendingBondagePick = null;
    }

    // Picker went quiet — pick randomly so the game keeps moving. The target
    // still gets their veto window.
    private handlePickTimeout(): void {
        const pending = this.pendingBondagePick;
        if (!pending) return;
        pending.timer = null;

        const target = this.players.get(pending.targetNumber);
        if (!target) {
            this.cancelPendingBondagePick();
            return;
        }

        if (pending.stage === "slot") {
            const slots = this.availablePickSlots(target);
            if (slots.length === 0) {
                this.cancelPendingBondagePick();
                this.beginPlayerPickBondage(target); // re-enters the no-slots path
                return;
            }
            const slot = slots[Math.floor(Math.random() * slots.length)];
            const actualGroup = slot.group === "ItemMouth" ? this.resolveMouthGroup(target) : slot.group;
            if (!actualGroup) {
                this.cancelPendingBondagePick();
                this.beginPlayerPickBondage(target);
                return;
            }
            const { options } = this.buildPickList(actualGroup, this.vetoedItemsFor(pending, actualGroup));
            if (options.length === 0) {
                this.cancelPendingBondagePick();
                this.beginPlayerPickBondage(target);
                return;
            }
            pending.slotDisplay = slot.display;
            pending.slotGroup = actualGroup;
            pending.options = options;
            pending.chosenItem = options[Math.floor(Math.random() * options.length)];
            this.bot.whisper(pending.pickerNumber, `Time's up — I picked ${pending.chosenItem} (${slot.display}) for you.`);
            this.beginVetoStage();
            return;
        }

        if (pending.stage === "item") {
            pending.chosenItem = pending.options[Math.floor(Math.random() * pending.options.length)];
            this.bot.whisper(pending.pickerNumber, `Time's up — I picked ${pending.chosenItem} for you.`);
            this.beginVetoStage();
        }
    }

    // --- item settings library ---------------------------------

    private loadItemSettings(): void {
        try {
            if (fs.existsSync(this.itemSettingsPath)) {
                this.itemSettings = JSON.parse(fs.readFileSync(this.itemSettingsPath, "utf8"));
            }
        } catch (err) {
            log(`WARNING: Could not load item_settings.json — starting with empty settings library: ${err}`);
            this.itemSettings = {};
        }
    }

    private saveItemSettings(): void {
        try {
            fs.writeFileSync(this.itemSettingsPath, JSON.stringify(this.itemSettings, null, 2), "utf8");
        } catch (err) {
            log(`ERROR: Failed to write item_settings.json: ${err}`);
        }
    }

    // Preloads configurations from the preset outfits so common items have a
    // known-good restraining mode before any room observations come in. Adds
    // only missing variants — never inflates counts across restarts.
    private seedItemSettingsFromOutfits(): void {
        let added = false;
        for (const outfit of BONDAGE_OUTFITS) {
            for (const item of outfit.items) {
                if (this.recordItemSetting(item.group, item.name, item.property, { increment: false, save: false })) {
                    added = true;
                }
            }
        }
        if (added) this.saveItemSettings();
    }

    // Records one observed configuration for an item. Returns true if the
    // library changed. increment=false only adds unseen variants (seeding).
    private recordItemSetting(group: string, name: string, rawProperty: any, opts: { increment: boolean; save: boolean }): boolean {
        const property = cleanDecodedProperty(rawProperty);
        if (!isLearnableProperty(property)) return false;

        const key = `${group}:${name}`;
        const canon = canonicalJson(property);
        const variants = this.itemSettings[key] ?? (this.itemSettings[key] = []);
        const existing = variants.find(v => canonicalJson(v.property) === canon);

        let changed = false;
        if (existing) {
            if (opts.increment) {
                existing.count++;
                changed = true;
            }
        } else {
            variants.push({ property: deepClone(property), count: 1 });
            if (variants.length > MAX_SETTING_VARIANTS_PER_ITEM) {
                variants.sort((a, b) => b.count - a.count);
                variants.length = MAX_SETTING_VARIANTS_PER_ITEM;
            }
            changed = true;
        }

        if (changed && opts.save) this.saveItemSettings();
        return changed;
    }

    // Chooses the configuration to apply for a picked item, per
    // ITEM_SETTING_STRATEGY. Returns {} when nothing has been learned yet
    // (item applies in its BC default mode).
    private pickItemSetting(group: string, name: string): any {
        const variants = this.itemSettings[`${group}:${name}`];
        if (!variants || variants.length === 0) return {};

        if (ITEM_SETTING_STRATEGY === "random") {
            return deepClone(variants[Math.floor(Math.random() * variants.length)].property);
        }
        if (ITEM_SETTING_STRATEGY === "weighted") {
            const total = variants.reduce((sum, v) => sum + v.count, 0);
            let roll = Math.random() * total;
            for (const v of variants) {
                roll -= v.count;
                if (roll <= 0) return deepClone(v.property);
            }
            return deepClone(variants[variants.length - 1].property);
        }

        const best = Math.max(...variants.map(v => v.count));
        const top = variants.filter(v => v.count === best);
        return deepClone(top[Math.floor(Math.random() * top.length)].property);
    }

    // --- popularity tracking & candidate logging ---------------

    private loadBondageUsage(): void {
        try {
            if (fs.existsSync(this.bondageUsagePath)) {
                this.bondageUsage = JSON.parse(fs.readFileSync(this.bondageUsagePath, "utf8"));
            }
        } catch (err) {
            log(`WARNING: Could not load bondage_usage.json — starting with empty usage data: ${err}`);
            this.bondageUsage = {};
        }
    }

    private saveBondageUsage(): void {
        try {
            fs.writeFileSync(this.bondageUsagePath, JSON.stringify(this.bondageUsage, null, 2), "utf8");
        } catch (err) {
            log(`ERROR: Failed to write bondage_usage.json: ${err}`);
        }
    }

    private incrementBondageUsage(group: string, itemName: string): void {
        if (!this.bondageUsage[group]) this.bondageUsage[group] = {};
        this.bondageUsage[group][itemName] = (this.bondageUsage[group][itemName] ?? 0) + 1;
        this.saveBondageUsage();
    }

    // Appends this game's player-pick selections to outfit_candidates.json
    // (gitignored) for periodic manual review / promotion into outfits.json.
    private logOutfitCandidates(): void {
        const pickPlayers = [...this.players.values()]
            .filter(p => p.bondageMode === "player-pick" && p.appliedBondageItems.length > 0);
        if (pickPlayers.length === 0) return;

        const entry = {
            date: new Date().toISOString(),
            players: [...this.players.values()].map(p => p.name),
            selections: pickPlayers.flatMap(p =>
                p.appliedBondageItems.map(e => ({ slot: e.slot, item: e.item, appliedTo: p.name }))),
        };

        try {
            let existing: any[] = [];
            if (fs.existsSync(this.outfitCandidatesPath)) {
                const parsed = JSON.parse(fs.readFileSync(this.outfitCandidatesPath, "utf8"));
                if (Array.isArray(parsed)) existing = parsed;
            }
            existing.push(entry);
            fs.writeFileSync(this.outfitCandidatesPath, JSON.stringify(existing, null, 2), "utf8");
            log(`Logged ${entry.selections.length} player-pick selection(s) to outfit_candidates.json`);
        } catch (err) {
            log(`ERROR: Failed to write outfit_candidates.json: ${err}`);
        }
    }

    private checkGameEndCondition(): boolean {
        if (this.isTeamMode) return this.checkTeamGameEndCondition();

        const activePlayers = [...this.players.values()].filter(p => !p.isFullyBound);

        if (activePlayers.length === 0) {
            this.recordGameCompletion(null);
            this.logMultiplayerGameEnd("all-bound");
            this.endGame();
            return true;
        } else if (this.players.size === 1 && activePlayers.length === 1) {
            // Everyone else left or was removed — not a win, just end the game.
            this.bot.sendChat(`Only one player remaining — not enough to continue. Ending the game, no winner this time.`);
            this.logMultiplayerGameEnd("aborted", { logSuffix: "not enough players" });
            this.resetGame();
            return true;
        } else if (activePlayers.length === 1 && this.players.size > 1) {
            const winner = activePlayers[0];
            this.bot.sendChat(`🏆 ${winner.name} wins! Everyone else is bound!`);
            this.recordGameCompletion([winner.memberNumber]);
            this.logMultiplayerGameEnd("win", { winner: winner.name });
            this.applyEndGameLocks([winner]);
            return true;
        }
        return false;
    }

    // Team mode win condition: a team is eliminated once every one of its
    // members is fully bound. The other team (its still-unbound members) wins.
    // A team member is "out" once fully bound, or once dropped from turnOrder
    // via a parity-vote ghost drop (dropGhostSlots) — their Player record
    // stays around for end-game display, but they no longer block their
    // team's win/loss condition.
    private checkTeamGameEndCondition(): boolean {
        const team1 = [...this.players.values()].filter(p => p.teamId === 1);
        const team2 = [...this.players.values()].filter(p => p.teamId === 2);
        const isOut = (p: Player) => p.isFullyBound || !this.turnOrder.includes(p.memberNumber);
        const team1AllOut = team1.length > 0 && team1.every(isOut);
        const team2AllOut = team2.length > 0 && team2.every(isOut);

        if (team1AllOut && team2AllOut) {
            this.recordGameCompletion(null);
            this.logMultiplayerGameEnd("all-bound");
            this.endGame();
            return true;
        }
        if (team1AllOut) {
            const winners = team2.filter(p => !isOut(p));
            this.bot.sendChat(`🔒 Team 1 is fully bound! Team 2 wins! 🎉`);
            this.recordGameCompletion(winners.map(p => p.memberNumber));
            this.logMultiplayerGameEnd("win", { winner: `Team 2 (${winners.map(p => p.name).join(", ")})` });
            this.applyEndGameLocks(winners);
            return true;
        }
        if (team2AllOut) {
            const winners = team1.filter(p => !isOut(p));
            this.bot.sendChat(`🔒 Team 2 is fully bound! Team 1 wins! 🎉`);
            this.recordGameCompletion(winners.map(p => p.memberNumber));
            this.logMultiplayerGameEnd("win", { winner: `Team 1 (${winners.map(p => p.name).join(", ")})` });
            this.applyEndGameLocks(winners);
            return true;
        }
        return false;
    }

    private endGame(): void {
        this.state = GameState.GameOver;
        this.bot.sendChat(`🎲 === GAME OVER === 🎲`);
        this.bot.sendChat(`All players are fully bound! Settling the final lock duration...`);
        this.applyEndGameLocks();
    }

    // winners: unbound player(s) whose partial bondage items need stripping
    // (their slots join the same staggered burst as everyone else's lock
    // application). Omitted when every player is fully bound (endGame()) —
    // nothing to strip. A single-player standard win passes a one-element
    // array; a team-mode win passes every surviving member of the winning team.
    // Kicks off a 30-second lock-time vote among the bound players about to
    // be locked (see startEndGameLockVote) before actually applying anything
    // — the vote's finalize step calls finalizeEndGameLocks with the same
    // winners once lockDurationMinutes has (maybe) been nudged.
    private applyEndGameLocks(winners?: Player[]): void {
        const boundPlayers = [...this.players.values()].filter(p => p.isFullyBound);
        if (boundPlayers.length === 0) {
            this.finalizeEndGameLocks(winners);
            return;
        }
        this.startEndGameLockVote(winners, boundPlayers);
    }

    // Give every bound player a 30-second window to nudge the proposed lock
    // duration up or down in 5-minute increments before it's applied. The
    // proposal itself is the greater of lockDurationMinutes (the host's
    // pre-game !lock10/!lock15/!lock20/!locktime setting, now treated as a
    // floor rather than a fixed value) or (number of players in the match)
    // + 5 — so bigger games start the vote from a higher baseline. No reply
    // within the window counts as "accept" (see finalizeEndGameLockVote).
    private startEndGameLockVote(winners: Player[] | undefined, boundPlayers: Player[]): void {
        const suggestedMinutes = Math.max(this.lockDurationMinutes, this.players.size + 5);
        const timeout = setTimeout(() => this.finalizeEndGameLockVote(), 30 * 1000);
        this.pendingLockTimeVote = { winners, boundPlayers, suggestedMinutes, votes: new Map(), timeout };

        for (const player of boundPlayers) {
            this.bot.whisper(player.memberNumber,
                `⏱️ Lock time vote: ${suggestedMinutes} min proposed. Reply: 1 = less (−5 min)  2 = accept  3 = more (+5 min). You have 30 seconds.`);
        }
    }

    // Dispatches a bound player's vote reply. Returns true if the message
    // was consumed (whether or not it was a valid 1/2/3). Ignores anything
    // from someone who isn't one of the polled bound players, or a second
    // reply from someone who already voted.
    private tryHandleEndGameLockVote(memberNumber: number, msg: string): boolean {
        const vote = this.pendingLockTimeVote;
        if (!vote || !vote.boundPlayers.some(p => p.memberNumber === memberNumber)) return false;
        if (vote.votes.has(memberNumber)) return true;

        if (msg !== "1" && msg !== "2" && msg !== "3") {
            this.bot.whisper(memberNumber, `Please reply 1 (less), 2 (accept), or 3 (more).`);
            return true;
        }

        vote.votes.set(memberNumber, Number(msg) as 1 | 2 | 3);

        if (vote.votes.size === vote.boundPlayers.length) {
            clearTimeout(vote.timeout);
            this.finalizeEndGameLockVote();
        }
        return true;
    }

    // Tallies whatever votes came in — missing votes count as "accept" —
    // adjusts lockDurationMinutes (floor of 5, no ceiling), and moves on to
    // actually applying the locks. Guards against running twice (once from
    // the last vote in, once from the timeout) by clearing
    // pendingLockTimeVote first.
    private finalizeEndGameLockVote(): void {
        const vote = this.pendingLockTimeVote;
        if (!vote) return;
        clearTimeout(vote.timeout);
        this.pendingLockTimeVote = null;

        let lessCount = 0;
        let moreCount = 0;
        for (const player of vote.boundPlayers) {
            const choice = vote.votes.get(player.memberNumber) ?? 2;
            if (choice === 1) lessCount++;
            else if (choice === 3) moreCount++;
        }

        this.lockDurationMinutes = Math.max(5, vote.suggestedMinutes + moreCount * 5 - lessCount * 5);
        if (this.lockDurationMinutes !== vote.suggestedMinutes) {
            this.bot.sendChat(`⏱️ Lock time vote result: ${this.lockDurationMinutes} minutes.`);
        }

        this.finalizeEndGameLocks(vote.winners);
    }

    // Actually applies the end-game locks at the current lockDurationMinutes
    // (already settled by applyEndGameLocks/finalizeEndGameLockVote above).
    private finalizeEndGameLocks(winners?: Player[]): void {
        const boundPlayers = [...this.players.values()].filter(p => p.isFullyBound);
        const lockEndTime = Date.now() + (this.lockDurationMinutes * 60 * 1000);

        if (winners && this.toysAllowed) {
            for (const winner of winners) {
                this.bot.whisper(winner.memberNumber,
                    "Reminder: you may add toys and touch the other players — but please, no locks on any toys."
                );
            }
        }

        this.bot.sendChat(`🔒 Hold still everyone — applying everyone's end-game locks now, this'll take a few moments!`);

        // Shared stagger counter: every emit in this end-game burst (winners'
        // item removal + each bound player's lock application) gets its own
        // slot on one timeline, so the combined burst stays under the BC
        // server's per-second rate limit.
        let stagger = 0;

        for (const winner of winners ?? []) {
            if (winner.bondageApplied === 0) continue;
            REMOVAL_SLOTS.forEach((group) => {
                const delay = stagger * END_GAME_EMIT_STAGGER_MS;
                setTimeout(() => {
                    this.removeSlotVerified(winner.memberNumber, group);
                }, delay);
                stagger++;
            });
        }

        // Phase 1: apply every player's locks first. Verification for all of
        // them happens afterward in Phase 2, once the apply burst has landed.
        const pendingVerifications: { player: Player; item: BondageItem }[] = [];

        for (const player of boundPlayers) {
            const pool = this.getEligibleOutfits(player.memberNumber);
            if (pool.length === 0 || !player.bondageOutfit || player.bondageOutfit.items.length === 0) {
                if (player.bondageMode === "player-pick") {
                    // Player-pick player bound with nothing applied (e.g. no
                    // consented slots) — nothing to lock, skip them.
                    continue;
                }
                this.bot.sendChat("Sorry, no eligible outfits available — game cannot continue.");
                this.resetGame();
                return;
            }

            for (let i = 0; i < player.bondageApplied; i++) {
                const storedItem = player.bondageOutfit?.items[i];
                if (!storedItem) continue;

                // Prefer whatever the player is actually currently wearing on
                // this slot over the outfit's originally-assigned item/color —
                // if they manually recolored it or swapped it for a different
                // item via BC's own wardrobe UI mid-game, the end-game lock
                // should preserve that instead of silently reverting it back
                // to what the bot first applied.
                const cached = this.itemStateCache.get(`${player.memberNumber}:${storedItem.group}`);
                const item: BondageItem = (cached && cached.Name)
                    ? { group: storedItem.group, name: cached.Name, color: cached.Color, property: cached.Property ?? storedItem.property }
                    : storedItem;

                const delay = stagger * END_GAME_EMIT_STAGGER_MS;
                setTimeout(() => {
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
                }, delay);
                stagger++;

                pendingVerifications.push({ player, item });
            }

            this.bot.sendChat(`🔒 ${player.name} locked for ${this.lockDurationMinutes} minutes!`);

            this.scheduleLockReleaseCheck(player);
        }

        // Phase 2: after a gap, verify every lock that was just applied.
        stagger++; // gap slot between the apply burst and the verify burst

        let lastVerifyDelay = 0;
        for (const { player, item } of pendingVerifications) {
            const delay = stagger * END_GAME_EMIT_STAGGER_MS;
            lastVerifyDelay = delay;
            setTimeout(() => {
                this.verifyEndGameLockApplied(player, item, lockEndTime, 0);
            }, delay);
            stagger++;
        }

        // The "did you receive your bondage and locks correctly?" whisper must
        // wait until every Phase 2 verification has run (each one checks the
        // cache after its own LOCK_VERIFY_DELAY_MS delay) — otherwise players
        // are asked before the bot has finished checking.
        const allVerificationsCompleteDelay = pendingVerifications.length > 0
            ? lastVerifyDelay + LOCK_VERIFY_DELAY_MS
            : 0;

        for (const player of boundPlayers) {
            if (player.bondageApplied === 0) continue; // nothing was locked on them
            this.sendLockVerificationWhisper(player, lockEndTime, allVerificationsCompleteDelay);
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

    // Applies one end-game lock item and starts its verification window.
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

    // BC never echoes the bot's own ChatRoomCharacterItemUpdate back as a
    // ChatRoomSyncItem, so silence during the verification window means the
    // lock was accepted. If the server rejects it, it broadcasts a
    // ChatRoomSyncSingle correcting the character's appearance — caught by
    // onSyncSingle, which calls onResult(true) for this key.
    private verifyEndGameLockApplied(player: Player, item: BondageItem, lockEndTime: number, attempt: number): void {
        const key = `${player.memberNumber}:${item.group}`;

        const existing = this.pendingLockApplyChecks.get(key);
        if (existing) this.pendingLockApplyChecks.delete(key);

        const finish = (rejected: boolean) => {
            if (!this.pendingLockApplyChecks.has(key)) return;
            this.pendingLockApplyChecks.delete(key);

            if (!rejected) {
                log(`Lock verification: ${player.name} (#${player.memberNumber}) ${item.group}/${item.name} confirmed (no rejection received).`);
                return;
            }

            log(`Lock verification: BC rejected lock for ${player.name} (#${player.memberNumber}) on ${item.group}/${item.name} (attempt ${attempt}/${MAX_END_GAME_LOCK_RETRIES}).`);

            if (attempt >= MAX_END_GAME_LOCK_RETRIES) {
                log(`LOCK VERIFY FAILED: giving up on ${player.name} (#${player.memberNumber}) ${item.group}/${item.name} after ${attempt} attempts`);
                this.bot.whisper(player.memberNumber, "⚠️ One or more locks may not have applied correctly — please check your items.");
                return;
            }

            const retry = () => this.applyEndGameLockItem(player, item, lockEndTime, attempt + 1);
            if (this.bot.isReconnecting()) {
                log(`Reconnect in progress — delaying lock retry for ${player.name} (#${player.memberNumber}) ${item.group}/${item.name} until reconnected.`);
                this.bot.onceConnected(retry);
            } else {
                retry();
            }
        };

        this.pendingLockApplyChecks.set(key, { itemName: item.name, onResult: finish });
        setTimeout(() => finish(false), LOCK_VERIFY_DELAY_MS);
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

    // Schedules the "did everything apply correctly?" whisper once all of
    // this end-game burst's Phase 2 verifications have had time to land.
    private sendLockVerificationWhisper(player: Player, lockEndTime: number, allVerificationsCompleteDelay: number): void {
        const memberNumber = player.memberNumber;
        const name = player.name;
        const bondageApplied = player.bondageApplied;
        const bondageOutfit = player.bondageOutfit;
        const lockDurationMinutes = this.lockDurationMinutes;

        const sendDelay = allVerificationsCompleteDelay + 1500;
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
        for (const player of this.players.values()) {
            player.toysConsent = null;
        }
        this.players.clear();
        this.turnOrder = [];
        this.currentTurnIndex = 0;
        this.currentDiceMax = STARTING_DICE_MAX;
        this.lastRollValue = null;
        this.rollStreakCount = 0;
        this.totalRollsThisGame = 0;
        this.safewordMember = null;
        this.bondagePhaseStarted = false;
        this.lockDurationMinutes = DEFAULT_LOCK_MINUTES;
        if (this.pendingLockTimeVote) {
            clearTimeout(this.pendingLockTimeVote.timeout);
            this.pendingLockTimeVote = null;
        }
        this.minPlayers = 2;
        this.maxPlayers = 6;
        this.lobbyOpen = false;
        this.hostMemberNumber = null;
        this.awaitingMinMaxReply = false;
        this.toysAllowed = false;
        this.awaitingToysConsent = false;
        if (this.toysConsentTimer) {
            clearTimeout(this.toysConsentTimer);
            this.toysConsentTimer = null;
        }
        for (const pending of this.pendingLateJoinToysConsent.values()) {
            clearTimeout(pending.timeout);
        }
        this.pendingLateJoinToysConsent.clear();
        for (const timer of this.pendingLateJoinConfirmations.values()) {
            clearTimeout(timer);
        }
        this.pendingLateJoinConfirmations.clear();
        for (const timer of this.pendingLeaveRemovalTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingLeaveRemovalTimers.clear();
        for (const pending of this.pendingLockVerifications.values()) {
            clearTimeout(pending.timeout);
        }
        this.pendingLockVerifications.clear();
        this.pendingLockApplyChecks.clear();
        this.clearCountdown();
        this.clearTurnTimer();
        this.clearSecondChanceTimer();
        this.activeSecondChance = null;
        this.secondChanceQueue = [];
        this.pendingTurnTimerBonusMs = 0;
        if (this.joinPauseTimer) {
            clearTimeout(this.joinPauseTimer);
            this.joinPauseTimer = null;
        }
        this.joinPauseActive.clear();
        this.joinPauseJoined = [];
        this.pendingTurnResume = null;
        this.pendingJoinPauses = [];
        this.pendingYesNoJoin.clear();
        this.cancelPendingBondagePick();
        this.lastRoundLoser = null;
        this.lossSeqCounter = 0;
        this.pickerHistory = [];
        this.gameBondageMode = "outfit";
        this.awaitingBondageMode = false;
        if (this.bondageModeTimer) {
            clearTimeout(this.bondageModeTimer);
            this.bondageModeTimer = null;
        }
        this.awaitingSlotConsent = false;
        if (this.slotConsentTimer) {
            clearTimeout(this.slotConsentTimer);
            this.slotConsentTimer = null;
        }
        this.pendingSlotConsent.clear();
        this.awaitingLateBondageMode.clear();
        for (const timer of this.lateBondageModeTimers.values()) clearTimeout(timer);
        this.lateBondageModeTimers.clear();

        this.isTeamMode = false;
        this.teamSize = 2;
        this.teamRoster = { 1: [], 2: [] };
        this.awaitingTeamSizeReply = false;
        this.clearTeamParityVote();

        this.bot.sendChat(`Game reset! Whisper !join to start a new game. 🎲`);
    }

    // ============================================================
    // GRACEFUL UPDATE / REBOOT
    // ============================================================

    // Posts player_updates.txt to the room if it exists. Called when a lobby
    // first opens so players see what's new before a game starts. The file is
    // NOT consumed — it stays until an admin removes it.
    private announcePlayerUpdates(): void {
        const updatesPath = path.join(__dirname, "..", "player_updates.txt");
        if (!fs.existsSync(updatesPath)) return;
        try {
            const content = fs.readFileSync(updatesPath, "utf8").trim();
            if (content) {
                this.bot.sendChat(content);
            }
        } catch (err) {
            log(`Failed to read player_updates.txt: ${err}`);
        }
    }

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

        try {
            fs.unlinkSync(updatePath);
        } catch (err) {
            log(`Failed to remove pending_update.txt: ${err}`);
        }

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

    private startTurnTimer(ms?: number): void {
        this.clearTurnTimer();
        const player = this.getCurrentPlayer();
        if (!player) return;

        const bonus = this.pendingTurnTimerBonusMs;
        this.pendingTurnTimerBonusMs = 0;
        const timeout = (ms ?? 35000) + bonus; // Default roll-turn window, +5s over the original 30s
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
        if (player.pendingRemovalKick) {
            // Back for their next turn and still no response — remove them.
            this.kickForFailedRemoval(player);
        } else if (player.removalWarned) {
            // Second window (15s) also expired — skip to next player.
            player.removalWarned = false;
            player.pendingRemovalKick = true;
            this.bot.whisper(player.memberNumber,
                `Skipping your turn — open your wardrobe and remove the item or whisper !removed before your next roll.`
            );
            this.advanceTurn();
        } else {
            // First window (20s) expired — send a visible reminder and give 15 more seconds.
            player.removalWarned = true;
            this.bot.sendChat(`⏰ ${player.name}, you still need to remove your item! 15 seconds or your turn is skipped.`);
            this.startTurnTimer(15000);
        }
    }

    private kickForFailedRemoval(player: Player): void {
        this.bot.sendChat(`❌ ${player.name} didn't remove their item and has been removed from the game.`);

        this.secondChanceQueue = this.secondChanceQueue.filter(sc => sc.memberNumber !== player.memberNumber);
        const removedIndex = this.turnOrder.indexOf(player.memberNumber);
        this.players.delete(player.memberNumber);
        this.turnOrder = this.turnOrder.filter(n => n !== player.memberNumber);

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

        if (!this.checkGameEndCondition()) {
            this.resolveCurrentTurn();
        }
    }

    private handleTurnTimeout(player: Player): void {
        // Silent skip: queue a second chance for end-of-round.
        player.missedTurnPending = true;
        this.secondChanceQueue.push({ memberNumber: player.memberNumber, countdown: this.turnOrder.length });
        this.advanceTurn();
    }

    private fireSecondChance(memberNumber: number): void {
        const player = this.players.get(memberNumber);
        if (!player) {
            this.resolveCurrentTurn();
            return;
        }
        this.activeSecondChance = memberNumber;
        this.state = GameState.Rolling;
        this.bot.whisper(memberNumber,
            `⚠️ You missed your turn! This is your second chance — type !roll now (${SECOND_CHANCE_TIMER_MS / 1000}s).`
        );
        this.secondChanceTimer = setTimeout(() => {
            this.handleSecondChanceTimeout(memberNumber);
        }, SECOND_CHANCE_TIMER_MS);
    }

    private handleSecondChanceTimeout(memberNumber: number): void {
        this.secondChanceTimer = null;
        this.activeSecondChance = null;
        const player = this.players.get(memberNumber);
        if (player) {
            player.missedTurnPending = false;
            player.missedSecondChance = true;
        }
        this.resolveCurrentTurn();
    }

    private handleSecondChanceRoll(memberNumber: number, name: string): void {
        this.clearSecondChanceTimer();
        this.activeSecondChance = null;

        const player = this.players.get(memberNumber);
        if (!player) {
            this.resolveCurrentTurn();
            return;
        }
        player.missedTurnPending = false;

        let roll: number;
        if (this.debugNextRoll !== null) {
            roll = this.debugNextRoll;
            this.debugNextRoll = null;
        } else {
            roll = Math.floor(Math.random() * this.currentDiceMax) + 1;
        }
        this.bot.sendChat(`🎲 ${name} catches up on their missed turn — D${this.currentDiceMax}... and gets ${roll}!`);

        const isD100 = this.currentDiceMax === STARTING_DICE_MAX;
        this.emitBonusRollCommentary(roll, this.currentDiceMax);

        if (isD100 && roll === 100) {
            player.freePass = true;
            this.bot.sendChat(`🎟️ ${name} rolled 100 — free pass! They can skip their next required roll.`);
            this.resolveCurrentTurn();
            return;
        }

        if (isD100 && roll === 1) {
            this.handleDoublePenalty(player);
            return;
        }

        if (roll === 1) {
            this.handleLoss(player);
            return;
        }

        this.currentDiceMax = roll;
        this.resolveCurrentTurn();
    }

    private clearSecondChanceTimer(): void {
        if (this.secondChanceTimer) {
            clearTimeout(this.secondChanceTimer);
            this.secondChanceTimer = null;
        }
    }

    // ============================================================
    // MID-GAME JOIN PAUSE
    // ============================================================

    // Called right before the next turn would start. If a mid-game joiner is
    // still waiting to get into rotation, pauses the game for them instead of
    // starting the next turn. Returns true if a pause was started (caller
    // should not proceed); onResume is invoked once the pause ends.
    private maybeStartJoinPause(onResume: () => void): boolean {
        while (this.pendingJoinPauses.length > 0) {
            const joiner = this.pendingJoinPauses.shift()!;
            const player = this.players.get(joiner.memberNumber);
            if (!player || !player.midGameJoin) continue; // already in rotation, or left
            this.beginJoinPause(joiner, onResume);
            return true;
        }
        return false;
    }

    // Starts the single shared pause window. Any other joiners already queued
    // in pendingJoinPauses are pulled into this same window (and share its
    // timer) instead of starting their own pauses later.
    private beginJoinPause(joiner: { memberNumber: number; name: string }, onResume: () => void): void {
        this.clearTurnTimer();
        this.joinPauseActive.clear();
        this.joinPauseJoined = [];
        this.pendingTurnResume = onResume;
        this.state = GameState.PausedForJoin;

        this.joinPauseActive.set(joiner.memberNumber, joiner.name);
        this.bot.sendChat(`⏸️ ${joiner.name} is joining — game paused for up to 60 seconds.`);
        this.sendJoinPauseInstructions(joiner.memberNumber);

        while (this.pendingJoinPauses.length > 0) {
            const extra = this.pendingJoinPauses.shift()!;
            const player = this.players.get(extra.memberNumber);
            if (!player || !player.midGameJoin) continue;
            this.joinPauseActive.set(extra.memberNumber, extra.name);
            this.sendJoinPauseInstructions(extra.memberNumber);
        }

        this.joinPauseTimer = setTimeout(() => this.handleJoinPauseTimeout(), JOIN_PAUSE_TIMEOUT_MS);
    }

    private sendJoinPauseInstructions(memberNumber: number): void {
        this.bot.whisper(memberNumber,
            `⏸️ The game is paused for you to get set up (up to 60 seconds). The dice is currently down to D${this.currentDiceMax}. ` +
            `Finish declaring your outfit (!wearing / !naked) and whisper !ready to join this round's rotation — ` +
            `if the pause ends before you're ready, you'll join the rotation as soon as you are.`
        );
    }

    private handleJoinPauseTimeout(): void {
        if (this.state !== GameState.PausedForJoin) return;
        this.joinPauseTimer = null;
        this.resumeFromJoinPause();
    }

    // Ends the join pause window and resumes the turn it interrupted, announcing
    // which joiners made it into the rotation and which didn't.
    private resumeFromJoinPause(): void {
        if (this.joinPauseTimer) {
            clearTimeout(this.joinPauseTimer);
            this.joinPauseTimer = null;
        }

        const notCompleted = [...this.joinPauseActive.values()];
        this.joinPauseActive.clear();

        const joined = this.joinPauseJoined.map(j => j.name);
        this.joinPauseJoined = [];

        this.bot.sendChat(this.buildJoinPauseResumeMessage(joined, notCompleted));

        const resume = this.pendingTurnResume;
        this.pendingTurnResume = null;
        if (resume) resume();
    }

    private buildJoinPauseResumeMessage(joined: string[], notCompleted: string[]): string {
        const joinedList = this.formatNameList(joined);
        const notCompletedList = this.formatNameList(notCompleted);

        if (joined.length > 0 && notCompleted.length === 0) {
            return `Game resuming — ${joinedList} ${joined.length === 1 ? "has" : "have"} joined the rotation!`;
        }
        if (joined.length > 0 && notCompleted.length > 0) {
            return `Game resuming — ${joinedList} joined, ${notCompletedList} did not complete in time and will be able to join next round.`;
        }
        if (notCompleted.length > 0) {
            return `Game resuming — ${notCompletedList} did not complete in time and will be able to join next round.`;
        }
        return `Game resuming.`;
    }

    // Joins names as "A", "A and B", or "A, B and C".
    private formatNameList(names: string[]): string {
        if (names.length <= 1) return names[0] ?? "";
        return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
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

    // "[Team 1] " prefix for chat announcements in team mode; empty string otherwise.
    private teamLabel(player: Player): string {
        if (!this.isTeamMode || player.teamId === null) return "";
        return `[Team ${player.teamId}] `;
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