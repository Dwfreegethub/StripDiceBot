import { BCConnection } from "./connection";
import { log } from "./logger";
import * as fs from "fs";
import * as path from "path";
import * as LZString from "lz-string";

// ============================================================
// TEST MODE - set to false for production
// ============================================================
const TEST_MODE = true;
const TEST_PASSWORD = "TEST1234";
const TEST_LOCK_MINUTES = 5;

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
    const filePath = path.join(__dirname, "..", "outfits.json");
    const raw = fs.readFileSync(filePath, "utf8");
    const data: { outfits: OutfitDefinition[] } = JSON.parse(raw);

    return data.outfits.map(def => {
        if (def.code && def.groups) {
            const appearance: any[] = JSON.parse(LZString.decompressFromBase64(def.code));
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
            return { name: def.name, items };
        }
        if (def.items) {
            return { name: def.name, items: def.items };
        }
        throw new Error(`Outfit "${def.name}" has neither "items" nor "code"+"groups"`);
    });
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
    bondageOutfit: BondageItem[] | null; // Outfit assigned once this player starts receiving bondage
}

// ============================================================
// FEEDBACK STATUS TRACKING
// ============================================================
type FeedbackItemStatus = "reviewing" | "testing" | "implemented" | "partly_implemented";

interface FeedbackItem {
    timestamp: string;
    text: string;
    status: FeedbackItemStatus;
}

interface FeedbackStatusEntry {
    name: string;
    items: FeedbackItem[];
}

const FEEDBACK_STATUS_LABELS: Record<FeedbackItemStatus, string> = {
    reviewing: "🔍 Reviewing",
    testing: "🧪 Testing",
    implemented: "✅ Implemented",
    partly_implemented: "🔧 Partly implemented",
};

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
// GAME CLASS
// ============================================================
export class StripDiceGame {
    private bot: BCConnection;
    private state: GameState = GameState.Idle;
    private players: Map<number, Player> = new Map();
    private turnOrder: number[] = [];
    private currentTurnIndex: number = 0;
    private currentDiceMax: number = 100;
    private countdownTimer: NodeJS.Timeout | null = null;
    private turnTimer: NodeJS.Timeout | null = null;
    private lockDurationMinutes: number = TEST_MODE ? TEST_LOCK_MINUTES : 30;
    private roomMembers: Set<number> = new Set();
    private nameCache: Map<number, string> = new Map();
    private pronounsCache: Map<number, string> = new Map();
    private lastClothing: Map<number, string[]> = new Map();
    private gamePassword: string = "";
    private isFirstRoll: boolean = true;    // Track if this is the very first roll
    private safewordMember: number | null = null;
    private allowMidGameJoin: boolean = true;
    private bondagePhaseStarted: boolean = false; // True once the first bondage outfit is assigned this game
    private pendingLockConfirmations: Map<number, { name: string; items: string[] }> = new Map();
    private itemStateCache: Map<string, any> = new Map();
    private lockPermissionWarned: Set<number> = new Set();
    private feedbackStatus: Record<string, FeedbackStatusEntry> = {};
    private feedbackNotified: Set<number> = new Set();
    private readonly feedbackStatusPath = path.join(__dirname, "..", "feedback_status.json");

    constructor(bot: BCConnection) {
        this.bot = bot;
        this.loadFeedbackStatus();
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
        this.notifyFeedbackStatus(memberNumber, name);
    }

    public onMemberLeave(memberNumber: number): void {
        this.roomMembers.delete(memberNumber);
        if (this.state !== GameState.Idle && this.players.has(memberNumber)) {
            const player = this.players.get(memberNumber)!;
            this.bot.sendChat(`${player.name} has left the room and been removed from the game.`);
            this.players.delete(memberNumber);
            this.turnOrder = this.turnOrder.filter(n => n !== memberNumber);
            this.checkGameEndCondition();
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

    public handleWhisper(memberNumber: number, name: string, message: string): void {
        const msg = message.trim().toLowerCase();

        // Guided clothing Q&A takes priority over other commands while active
        const player = this.players.get(memberNumber);
        if (player && player.clothingQuestionIndex !== null && (msg === "yes" || msg === "y" || msg === "no" || msg === "n")) {
            this.handleGuidedAnswer(memberNumber, msg);
            return;
        }

        if (msg === "!roll") {
            this.handleRoll(memberNumber, name);
            return;
        }
        if (msg === "!join") {
            this.handleJoin(memberNumber, name);
            return;
        }
        if (msg === "!start") {
            this.handleStart(memberNumber);
            return;
        }
        if (msg === "!cancel") {
            this.handleCancel(memberNumber);
            return;
        }
        if (msg === "!wearing") {
            this.startGuidedClothing(memberNumber);
            return;
        }
        if (msg.startsWith("!wearing ")) {
            this.handleWearing(memberNumber, message);
            return;
        }
        if (msg === "!naked") {
            this.handleNoWearing(memberNumber);
            return;
        }
        if (msg === "!same") {
            this.handleSame(memberNumber);
            return;
        }
        if (msg === "!ready") {
            this.handleReady(memberNumber);
            return;
        }
        if (msg.startsWith("!locktime ")) {
            this.handleLockTime(memberNumber, message);
            return;
        }
        if (msg.startsWith("!midgamejoin ")) {
            this.handleMidGameJoinToggle(memberNumber, message);
            return;
        }
        if (msg.startsWith("!testoutfit ")) {
            this.handleTestOutfit(memberNumber, message);
            return;
        }
        if (msg.startsWith("!setstatus ")) {
            this.handleSetStatus(memberNumber, message);
            return;
        }
        if (msg === "!feedback list") {
            this.handleFeedbackList(memberNumber);
            return;
        }
        if (msg === "!safeword") {
            this.handleSafeword(memberNumber, name);
            return;
        }
        if (msg === "!reset") {
            this.handleReset(memberNumber);
            return;
        }
        if (msg === "!released" || msg === "!stuck") {
            this.handleLockReleaseConfirmation(memberNumber, msg === "!released");
            return;
        }
        if (msg === "!help") {
            this.handleHelp(memberNumber);
            return;
        }
        if (msg === "!about") {
            this.handleAbout(memberNumber);
            return;
        }
        if (msg.startsWith("!feedback ")) {
            this.handleFeedback(memberNumber, name, message);
            return;
        }
    }

    public handleChat(memberNumber: number, name: string, message: string): void {
        const msg = message.trim().toLowerCase();

        if (msg === "!roll") {
            this.handleRoll(memberNumber, name);
            return;
        }
        if (msg === "!removed") {
            this.handleRemoved(memberNumber, name);
            return;
        }
        if (msg === "!continue") {
            this.handleContinue(memberNumber);
            return;
        }
        if (msg === "!join") {
            this.handleJoin(memberNumber, name);
            return;
        }
        if (msg === "!start") {
            this.handleStart(memberNumber);
            return;
        }
        if (msg === "!cancel") {
            this.handleCancel(memberNumber);
            return;
        }
        if (msg === "!ready") {
            this.handleReady(memberNumber);
            return;
        }
        if (msg === "!naked") {
            this.handleNoWearing(memberNumber);
            return;
        }
        if (msg === "!same") {
            this.handleSame(memberNumber);
            return;
        }
        if (msg === "!released" || msg === "!stuck") {
            this.handleLockReleaseConfirmation(memberNumber, msg === "!released");
            return;
        }
        if (msg === "!help") {
            this.handleHelp(memberNumber);
            return;
        }
        if (msg === "!about") {
            this.handleAbout(memberNumber);
            return;
        }
    }

    // ============================================================
    // COMMAND HANDLERS
    // ============================================================

    private handleJoin(memberNumber: number, name: string): void {
        if (this.state === GameState.Idle && this.checkPendingUpdate()) {
            return;
        }
        if (this.bondagePhaseStarted) {
            this.bot.whisper(memberNumber, "The game is already in the bondage phase. You'll be able to join the next round!");
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
        };
        this.players.set(memberNumber, player);

        if (midGame) {
            this.bot.sendChat(`${name} is joining mid-game! They'll enter the turn rotation once ready.`);
        } else {
            this.state = GameState.Registration;
            this.bot.sendChat(`${name} has joined the game! (${this.players.size} player${this.players.size > 1 ? "s" : ""} ready)`);
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
        if (!this.players.has(memberNumber)) {
            this.bot.whisper(memberNumber, "You haven't joined the game yet! Whisper !join first.");
            return;
        }

        const player = this.players.get(memberNumber)!;
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
        if (!this.players.has(memberNumber)) {
            this.bot.whisper(memberNumber, "You haven't joined the game yet! Whisper !join first.");
            return;
        }
        const player = this.players.get(memberNumber)!;
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
                this.bot.whisper(memberNumber, "Got it — you're starting naked! Whisper !ready when done.");
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
        if (!this.players.has(memberNumber)) {
            this.bot.whisper(memberNumber, "You haven't joined the game yet! Whisper !join first.");
            return;
        }
        const last = this.lastClothing.get(memberNumber);
        if (!last || last.length === 0) {
            this.bot.whisper(memberNumber, "No previous outfit on record. Please use !wearing to declare your clothing.");
            return;
        }
        const player = this.players.get(memberNumber)!;
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
        if (!this.players.has(memberNumber)) {
            this.bot.whisper(memberNumber, "You haven't joined the game yet! Whisper !join first.");
            return;
        }
        const player = this.players.get(memberNumber)!;
        player.clothing = [];
        player.isNaked = true;
        player.ready = false;
        player.clothingQuestionIndex = null;
        this.bot.whisper(memberNumber, "Got it — you're starting naked! Bondage will be applied directly when you lose. Whisper !ready when done.");
    }

    private handleReady(memberNumber: number): void {
        if (!this.players.has(memberNumber)) {
            this.bot.whisper(memberNumber, "You haven't joined the game yet! Whisper !join first.");
            return;
        }
        const player = this.players.get(memberNumber)!;

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
        if (!this.isAdmin(memberNumber)) {
            this.bot.whisper(memberNumber, "Only the game admin can use this command.");
            return;
        }
        if (this.state === GameState.Idle && this.players.size === 0) {
            this.bot.whisper(memberNumber, "No game is currently running.");
            return;
        }

        this.clearCountdown();
        this.clearTurnTimer();

        for (const player of this.players.values()) {
            this.removeAllItems(player.memberNumber);
        }

        this.bot.sendChat(`🛑 The game has been reset by an admin.`);
        this.resetGame();
    }

    private handleTestOutfit(memberNumber: number, message: string): void {
        if (!this.isAdmin(memberNumber)) {
            this.bot.whisper(memberNumber, "Only the game admin can use this command.");
            return;
        }
        const player = this.players.get(memberNumber);
        if (!player) {
            this.bot.whisper(memberNumber, "You haven't joined the game yet! Whisper !join first.");
            return;
        }
        const requested = message.trim().slice("!testoutfit ".length).trim();
        const outfit = BONDAGE_OUTFITS.find(o => o.name.toLowerCase() === requested.toLowerCase());
        if (!outfit) {
            const names = BONDAGE_OUTFITS.map(o => o.name).join(", ");
            this.bot.whisper(memberNumber, `Unknown outfit "${requested}". Available outfits: ${names}`);
            return;
        }
        player.bondageOutfit = outfit.items;
        player.bondageApplied = 0;
        this.bot.whisper(memberNumber, `Your next bondage outfit has been forced to: ${outfit.name}`);
    }

    private handleSetStatus(memberNumber: number, message: string): void {
        if (!this.isAdmin(memberNumber)) {
            this.bot.whisper(memberNumber, "Only the game admin can use this command.");
            return;
        }
        const parts = message.trim().split(/\s+/);
        const playerId = parts[1];
        const status = (parts[2] ?? "").toLowerCase() as FeedbackItemStatus;
        const validStatuses: FeedbackItemStatus[] = ["reviewing", "testing", "implemented", "partly_implemented"];

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
        }
        this.saveFeedbackStatus();
        this.bot.whisper(memberNumber, `Updated ${entry.items.length} feedback item(s) for ${entry.name} (#${playerId}) to "${status}".`);
    }

    private handleSafeword(memberNumber: number, name: string): void {
        this.bot.sendChat(`🔴 SAFEWORD - ${name} has called safeword! Removing all restraints...`);
        this.bot.whisper(memberNumber, "Safeword acknowledged. Removing all restraints now.");
        this.removeAllItems(memberNumber);

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

        this.currentDiceMax = 100;
        this.state = GameState.Rolling;
        // Make sure currentTurnIndex is still valid
        if (this.currentTurnIndex >= this.turnOrder.length) {
            this.currentTurnIndex = 0;
        }
        this.announceCurrentTurn();
        this.startTurnTimer();
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
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] ${name} (#${memberNumber}): ${text}\n`;
        const filePath = path.join(__dirname, "..", "feedback.log");
        fs.appendFileSync(filePath, line, "utf8");
        log(`Feedback from ${name}: ${text}`);

        const key = String(memberNumber);
        const entry = this.feedbackStatus[key] ?? { name, items: [] };
        entry.name = name;
        entry.items.push({ timestamp, text, status: "reviewing" });
        this.feedbackStatus[key] = entry;
        this.saveFeedbackStatus();

        this.bot.whisper(memberNumber, "Thank you for your feedback! 💬 We read everything and really appreciate it.");
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
        fs.writeFileSync(this.feedbackStatusPath, JSON.stringify(this.feedbackStatus, null, 2), "utf8");
    }

    private notifyFeedbackStatus(memberNumber: number, name: string): void {
        if (this.feedbackNotified.has(memberNumber)) return;
        const entry = this.feedbackStatus[String(memberNumber)];
        if (!entry || entry.items.length === 0) return;
        this.feedbackNotified.add(memberNumber);

        const lines = entry.items.map((item, i) =>
            `${i + 1}. "${item.text}" — ${FEEDBACK_STATUS_LABELS[item.status] ?? item.status}`
        );

        this.sendLongWhisper(memberNumber,
            `Hi ${name}! Here's an update on the feedback you've sent us:\n` +
            lines.join("\n") +
            `\n\nThanks for helping us improve the game! 💕`
        );
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

    private handleFeedbackList(memberNumber: number): void {
        if (!this.isAdmin(memberNumber)) {
            this.bot.whisper(memberNumber, "Only the game admin can use this command.");
            return;
        }

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
            `=== Strip Dice Commands ===\n` +
            `!join - Join the game\n` +
            `!wearing - Go through your outfit one item at a time (yes/no)\n` +
            `!wearing [items] - Declare your clothing all at once\n` +
            `  Valid items: shoes socks top bottom bra panties\n` +
            `!naked - Declare you have no clothing on\n` +
            `!same - Reuse your outfit from last game\n` +
            `!ready - Confirm you are ready to play\n` +
            `!start - Start the game early\n` +
            `!cancel - Cancel the countdown\n` +
            `!roll - Roll the dice on your turn (in room chat or whispered to me)\n` +
            `!removed - Confirm you removed a clothing item (in room chat)\n` +
            `!safeword - Emergency: remove all restraints immediately\n` +
            `!released / !stuck - Confirm whether your locks released at the end of the game\n` +
            `!feedback [text] - Send feedback to the developers\n` +
            `!about - About this bot\n` +
            `!help - Show this message`;

        if (this.isAdmin(memberNumber)) {
            text +=
                `\n\n=== Admin Commands ===\n` +
                `!locktime [mins] - Set end game lock duration\n` +
                `!reset - End the current game immediately, remove bondage items from all players, and reset for a new game\n` +
                `!midgamejoin on/off - Allow players to join games already in progress\n` +
                `!testoutfit [name] - Force your next bondage outfit (for testing)\n` +
                `!setstatus [playerID] [status] - Set a player's feedback status (reviewing, testing, implemented, partly_implemented)\n` +
                `!feedback list - View a summary of all tracked feedback`;
        }

        this.bot.whisper(memberNumber, text);
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

        // --------------------------------------------------------
        // TODO: First roll special case
        // If this.isFirstRoll === true AND roll === 1:
        //   - Announce that the first player wins
        //   - All other players must strip and get bound immediately
        //   - Skip normal game flow
        // --------------------------------------------------------
        if (this.isFirstRoll && roll === 1) {
            // Placeholder - just treat as normal loss for now
            log("TODO: First roll = 1 special case triggered");
        }

        this.isFirstRoll = false;

        if (roll === 1) {
            this.handleLoss(currentPlayer);
        } else {
            this.currentDiceMax = roll;
            this.advanceTurn();
        }
    }

    public handleWardrobe(memberNumber: number, name: string): void {
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

        this.bot.sendChat(`✅ ${name} has removed their item. Continuing the game...`);

        // Loser rolls first next round with fresh D100
        this.currentDiceMax = 100;
        this.isFirstRoll = false;
        this.state = GameState.Rolling;
        this.startTurnTimer();
        this.bot.sendChat(`🎲 ${name} rolls first this round! Type !roll (D${this.currentDiceMax})`);
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
        this.isFirstRoll = true;

        // Generate password
        this.gamePassword = TEST_MODE ? TEST_PASSWORD : generatePassword();
        log(`Game password: ${this.gamePassword} (TEST_MODE: ${TEST_MODE})`);

        // Build random turn order
        this.turnOrder = [...this.players.keys()];
        this.shuffleArray(this.turnOrder);
        this.currentTurnIndex = 0;
        this.currentDiceMax = 100;

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
        this.bot.whisper(player.memberNumber, `🎲 It's your turn! Roll a D${this.currentDiceMax} by typing !roll (in chat or whispered to me).`);
    }

    private advanceTurn(): void {
        this.currentTurnIndex = (this.currentTurnIndex + 1) % this.turnOrder.length;
        this.state = GameState.Rolling;
        this.announceCurrentTurn();
        this.startTurnTimer();
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

    private applyNextBondageItem(player: Player): void {
        if (!player.bondageOutfit) {
            const pool = this.getEligibleOutfits(player.memberNumber);
            player.bondageOutfit = pool[Math.floor(Math.random() * pool.length)].items;
            log(`${player.name} assigned bondage outfit: ${this.getBondageOutfitName(player.bondageOutfit)}`);
            this.bondagePhaseStarted = true;
        }

        const item = player.bondageOutfit[player.bondageApplied];

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

        // Apply lock after short delay
        setTimeout(() => {
            this.bot.applyItem(
                player.memberNumber,
                item.group,
                item.name,
                item.color,
                {
                    ...item.property,
                    Effect: [...(item.property.Effect || []), "Lock"],
                    LockedBy: "TimerPasswordPadlock",
                    LockMemberNumber: this.bot.getMemberNumber(),
                    LockMemberName: "GameBot",
                    Password: this.gamePassword,
                    Hint: "Game in progress...",
                    LockSet: true,
                    RemoveItem: false,
                    ShowTimer: false,
                    EnableRandomInput: false,
                    MemberNumberList: [],
                    RemoveTimer: Date.now() + (24 * 60 * 60 * 1000)
                }
            );
            this.verifyLockApplied(player, item.group, item.name);

            player.bondageApplied++;

            if (player.bondageApplied >= player.bondageOutfit!.length) {
                player.isFullyBound = true;
                this.turnOrder = this.turnOrder.filter(n => n !== player.memberNumber);
                this.bot.sendChat(`🔒 ${player.name} is fully bound and out of the game!`);

                if (this.checkGameEndCondition()) return;

                if (this.currentTurnIndex >= this.turnOrder.length) {
                    this.currentTurnIndex = 0;
                }
                this.currentDiceMax = 100;
                this.state = GameState.Rolling;
                this.announceCurrentTurn();
                this.startTurnTimer();
            } else {
                this.bot.sendChat(`✅ ${player.name} has been restrained! Back to the game...`);
                this.currentTurnIndex = this.turnOrder.indexOf(player.memberNumber);
                this.currentDiceMax = 100;
                this.state = GameState.Rolling;
                this.announceCurrentTurn();
                this.startTurnTimer();
            }
        }, 500);
    }

    private checkGameEndCondition(): boolean {
        const activePlayers = [...this.players.values()].filter(p => !p.isFullyBound);

        if (activePlayers.length === 0) {
            this.endGame();
            return true;
        } else if (activePlayers.length === 1 && this.players.size > 1) {
            const winner = activePlayers[0];
            this.bot.sendChat(`🏆 ${winner.name} wins! Everyone else is bound!`);
            if (winner.bondageApplied > 0) {
                this.removeAllItems(winner.memberNumber);
            }
            this.applyEndGameLocks();
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

    private applyEndGameLocks(): void {
        const boundPlayers = [...this.players.values()].filter(p => p.isFullyBound);
        const lockEndTime = Date.now() + (this.lockDurationMinutes * 60 * 1000);

        for (const player of boundPlayers) {
            for (let i = 0; i < player.bondageApplied; i++) {
                const item = player.bondageOutfit?.[i];
                if (!item) continue;

                setTimeout(() => {
                    this.bot.applyItem(
                        player.memberNumber,
                        item.group,
                        item.name,
                        item.color,
                        {
                            ...item.property,
                            Effect: [...(item.property.Effect || []), "Lock"],
                            LockedBy: "TimerPasswordPadlock",
                            LockMemberNumber: this.bot.getMemberNumber(),
                            LockMemberName: "GameBot",
                            Password: this.gamePassword,
                            Hint: `Released in ${this.lockDurationMinutes} minutes`,
                            LockSet: true,
                            RemoveItem: true,
                            ShowTimer: true,
                            EnableRandomInput: false,
                            MemberNumberList: [],
                            RemoveTimer: lockEndTime
                        }
                    );
                    this.verifyLockApplied(player, item.group, item.name);
                }, i * 300);
            }

            this.bot.sendChat(`🔒 ${player.name} locked for ${this.lockDurationMinutes} minutes!`);
            this.scheduleLockReleaseCheck(player);
        }

        setTimeout(() => {
            this.resetGame();
        }, 5000);
    }

    // ============================================================
    // LOCK VERIFICATION
    // ============================================================

    private verifyLockApplied(player: Player, group: string, itemName: string): void {
        setTimeout(() => {
            const current = this.itemStateCache.get(`${player.memberNumber}:${group}`);
            if (!current || current.Name !== itemName) return;

            const isLocked = !!current.Property?.LockedBy;
            if (!isLocked) {
                log(`Lock did not apply for ${player.name} (#${player.memberNumber}) on ${group}/${itemName} — likely missing whitelist permission.`);
                this.notifyLockPermissionIssue(player);
            }
        }, 1000);
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
        const items = (player.bondageOutfit ?? []).slice(0, player.bondageApplied).map(i => i.name);

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
        const timestamp = new Date().toISOString();
        const itemList = pending.items.length > 0 ? pending.items.join(", ") : "(none)";
        const line = `[${timestamp}] ${pending.name} (#${memberNumber}): items=[${itemList}] status=${status}\n`;
        const filePath = path.join(__dirname, "..", "lock_release_log.txt");
        fs.appendFileSync(filePath, line, "utf8");

        if (released) {
            this.bot.whisper(memberNumber, "Great, glad everything came off! Thanks for confirming. 💕");
        } else {
            this.bot.whisper(memberNumber, "Thanks for letting us know — we've logged the stuck item(s) so we can investigate. Sorry about that!");
        }
    }

    private resetGame(): void {
        this.state = GameState.Idle;
        this.players.clear();
        this.turnOrder = [];
        this.currentTurnIndex = 0;
        this.currentDiceMax = 100;
        this.isFirstRoll = true;
        this.safewordMember = null;
        this.bondagePhaseStarted = false;
        this.lockPermissionWarned.clear();
        this.clearCountdown();
        this.clearTurnTimer();

        if (this.checkPendingUpdate()) return;

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

    private removeAllItems(memberNumber: number): void {
        const slotsToRemove = [
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

        slotsToRemove.forEach((group, index) => {
            setTimeout(() => {
                this.removeSlotVerified(memberNumber, group);
            }, index * 200);
        });
    }

    // Removes whatever is in a slot, unlocking it first if needed, then
    // re-checks the cached item state and retries until the slot is clear.
    private removeSlotVerified(memberNumber: number, group: string, attempt: number = 1): void {
        const current = this.itemStateCache.get(`${memberNumber}:${group}`);

        if (current?.Property?.LockedBy) {
            this.bot.applyItem(memberNumber, group, current.Name, current.Color, cleanDecodedProperty(current.Property));
            setTimeout(() => this.bot.removeItem(memberNumber, group), 300);
        } else {
            this.bot.removeItem(memberNumber, group);
        }

        if (attempt >= 5) return;

        setTimeout(() => {
            const after = this.itemStateCache.get(`${memberNumber}:${group}`);
            if (after?.Name) {
                this.removeSlotVerified(memberNumber, group, attempt + 1);
            }
        }, 1000);
    }

    // ============================================================
    // TURN TIMER
    // ============================================================

    private startTurnTimer(ms: number = 30000): void {
        this.clearTurnTimer();
        const player = this.getCurrentPlayer();
        if (!player) return;

        this.turnTimer = setTimeout(() => {
            if (this.state === GameState.WaitingRemove) {
                this.handleRemoveTimeout(player);
            } else {
                this.handleTurnTimeout(player);
            }
        }, ms);
    }

    private clearTurnTimer(): void {
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
            this.turnTimer = null;
        }
    }

    private handleRemoveTimeout(player: Player): void {
        this.bot.whisper(player.memberNumber,
            `If you've already removed your item, whisper !removed to continue the game.`
        );
        this.startTurnTimer(60000);
    }

    private handleTurnTimeout(player: Player): void {
        if (!player.timeoutWarned) {
            player.timeoutWarned = true;
            this.bot.sendChat(`⏰ ${player.name}, it's your turn! Type !roll or you'll be skipped.`);
            this.bot.whisper(player.memberNumber, `It's your turn! Type !roll in the room chat or you'll be skipped.`);
            this.startTurnTimer(30000);
        } else {
            player.timeoutWarned = false;
            player.timeoutCount++;
            this.bot.sendChat(`⏭️ ${player.name} was skipped for inactivity.`);

            if (player.timeoutCount >= 2) {
                this.removeAfkPlayer(player);
            } else {
                this.advanceTurn();
            }
        }
    }

    private removeAfkPlayer(player: Player): void {
        this.bot.whisper(player.memberNumber, "You've been removed from the game for inactivity (skipped your turn twice in a row).");
        this.bot.sendChat(`👋 ${player.name} has been removed from the game for inactivity.`);

        this.players.delete(player.memberNumber);
        this.turnOrder = this.turnOrder.filter(n => n !== player.memberNumber);

        if (this.players.size === 0) {
            this.bot.sendChat(`No players remaining. Resetting.`);
            this.resetGame();
            return;
        }

        if (this.checkGameEndCondition()) return;

        if (this.currentTurnIndex >= this.turnOrder.length) {
            this.currentTurnIndex = 0;
        }
        this.currentDiceMax = 100;
        this.state = GameState.Rolling;
        this.announceCurrentTurn();
        this.startTurnTimer();
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
        return this.players.get(memberNumber)?.name ?? this.nameCache.get(memberNumber) ?? `Player #${memberNumber}`;
    }

    private getBondageOutfitName(items: BondageItem[]): string {
        return BONDAGE_OUTFITS.find(o => o.items === items)?.name ?? "Unknown";
    }

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

    private shuffleArray(array: any[]): void {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }
}