import { BCConnection } from "./connection";
import { log } from "./logger";
import * as fs from "fs";
import * as path from "path";

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
// BONDAGE ITEMS - fixed list Option A
// Add more items here as we confirm asset names
// ============================================================
const BONDAGE_ITEMS = [
    {
        group: "ItemFeet",
        name: "HighStyleSteelAnkleCuffs",
        color: "#A23939",
        property: {
            TypeRecord: { typed: 2 },
            Difficulty: 0,
            Effect: ["Slow"]
        }
    },
    {
        group: "ItemNeck",
        name: "SlenderSteelCollar",
        color: "#FFFFFF",
        property: {
            Difficulty: 0,
            Effect: []
        }
    },
    {
        group: "ItemTorso",
        name: "ExtremeCorset",
        color: "#FFFFFF",
        property: {
            Difficulty: 0,
            Effect: []
        }
    },
    {
        group: "ItemArms",
        name: "HighStyleSteelCuffs",
        color: ["#FFFFFF", "#FFFFFF"],
        property: {
            TypeRecord: { typed: 1 },
            Difficulty: 0,
            Effect: ["Block", "BlockWardrobe"],
            SetPose: ["BackBoxTie"],
            AllowActivePose: ["BackBoxTie"]
        }
    },
    {
        group: "ItemNeckRestraints",
        name: "CollarChainLong",
        color: "#FFFFFF",
        property: {
            Difficulty: 0,
            Effect: []
        }
    },
    // TODO: Add armbinder once asset name confirmed
    // TODO: Add gag once asset name confirmed (known issues)
];

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
    private lastClothing: Map<number, string[]> = new Map();
    private gamePassword: string = "";
    private isFirstRoll: boolean = true;    // Track if this is the very first roll
    private safewordMember: number | null = null;

    constructor(bot: BCConnection) {
        this.bot = bot;
    }

    // ============================================================
    // PUBLIC - room events
    // ============================================================

    public onMemberJoin(memberNumber: number, name: string): void {
        this.roomMembers.add(memberNumber);
        this.nameCache.set(memberNumber, name);
        if (memberNumber === this.bot.getMemberNumber()) return;
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
            }
        }
    }

    // ============================================================
    // PUBLIC - command handlers
    // ============================================================

    public handleWhisper(memberNumber: number, name: string, message: string): void {
        const msg = message.trim().toLowerCase();

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
        if (msg === "!safeword") {
            this.handleSafeword(memberNumber, name);
            return;
        }
        if (msg === "!help") {
            this.handleHelp(memberNumber);
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
    }

    // ============================================================
    // COMMAND HANDLERS
    // ============================================================

    private handleJoin(memberNumber: number, name: string): void {
        if (this.state !== GameState.Idle && this.state !== GameState.Registration && this.state !== GameState.Countdown) {
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
        };
        this.players.set(memberNumber, player);
        this.state = GameState.Registration;

        this.bot.sendChat(`${name} has joined the game! (${this.players.size} player${this.players.size > 1 ? "s" : ""} ready)`);

        const last = this.lastClothing.get(memberNumber);
        if (last && last.length > 0) {
            this.bot.whisper(memberNumber,
                `Welcome back to Strip Dice! 🎲\n` +
                `Last time you wore: ${last.join(", ")}\n` +
                `Whisper !same to use the same outfit, or:\n` +
                `!wearing [items] to declare a new outfit\n` +
                `!naked if you have nothing on\n` +
                `Then whisper !ready when done.`
            );
        } else {
            this.bot.whisper(memberNumber,
                `Welcome to Strip Dice! 🎲\n` +
                `Please whisper what clothing you are wearing:\n` +
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

        this.checkAllJoined();
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
        player.ready = false;
        this.bot.whisper(memberNumber,
            `Got it! Your clothing list in order: ${player.clothing.join(", ")}.\n` +
            `Whisper !ready when done, or !wearing again to change.`
        );
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
        this.bot.whisper(memberNumber, "You're ready! Waiting for other players...");
        this.bot.sendChat(`${player.name} is ready!`);
        this.checkAllReady();
    }

    private handleLockTime(memberNumber: number, message: string): void {
        if (memberNumber !== 208543 && memberNumber !== this.bot.getMemberNumber()) {
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
        this.bot.whisper(memberNumber, "Thank you for your feedback! 💬 We read everything and really appreciate it.");
    }

    private handleHelp(memberNumber: number): void {
        this.bot.whisper(memberNumber,
            `=== Strip Dice Commands ===\n` +
            `!join - Join the game\n` +
            `!wearing [items] - Declare your clothing\n` +
            `  Valid items: shoes socks top bottom bra panties\n` +
            `!naked - Declare you have no clothing on\n` +
            `!same - Reuse your outfit from last game\n` +
            `!ready - Confirm you are ready to play\n` +
            `!start - Start the game early\n` +
            `!cancel - Cancel the countdown\n` +
            `!roll - Roll the dice on your turn (in room chat)\n` +
            `!removed - Confirm you removed a clothing item (in room chat)\n` +
            `!locktime [mins] - Set end game lock duration (admin only)\n` +
            `!safeword - Emergency: remove all restraints immediately\n` +
            `!feedback [text] - Send feedback to the developers\n` +
            `!help - Show this message`
        );
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
        this.bot.sendChat(`🎲 ${player.name}'s turn! Roll a D${this.currentDiceMax} by typing !roll`);
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
        const item = BONDAGE_ITEMS[player.bondageApplied];

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

            player.bondageApplied++;

            if (player.bondageApplied >= BONDAGE_ITEMS.length) {
                player.isFullyBound = true;
                this.turnOrder = this.turnOrder.filter(n => n !== player.memberNumber);
                this.bot.sendChat(`🔒 ${player.name} is fully bound and out of the game!`);
                this.checkGameEndCondition();
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

    private checkGameEndCondition(): void {
        const activePlayers = [...this.players.values()].filter(p => !p.isFullyBound);

        if (activePlayers.length === 0) {
            this.endGame();
        } else if (activePlayers.length === 1 && this.players.size > 1) {
            const winner = activePlayers[0];
            this.bot.sendChat(`🏆 ${winner.name} wins! Everyone else is bound!`);
            this.applyEndGameLocks();
        }
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
                const item = BONDAGE_ITEMS[i];
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
                }, i * 300);
            }

            this.bot.sendChat(`🔒 ${player.name} locked for ${this.lockDurationMinutes} minutes!`);
        }

        setTimeout(() => {
            this.resetGame();
        }, 5000);
    }

    private resetGame(): void {
        this.state = GameState.Idle;
        this.players.clear();
        this.turnOrder = [];
        this.currentTurnIndex = 0;
        this.currentDiceMax = 100;
        this.isFirstRoll = true;
        this.safewordMember = null;
        this.clearCountdown();
        this.clearTurnTimer();
        this.bot.sendChat(`Game reset! Whisper !join to start a new game. 🎲`);
    }

    private removeAllItems(memberNumber: number): void {
        const slotsToRemove = [
            "ItemFeet",
            "ItemHands",
            "ItemNeck",
            "ItemNeckRestraints",
            "ItemArms",
            "ItemMouth",
            "ItemHead",
            "ItemLegs",
            "ItemTorso",
        ];

        slotsToRemove.forEach((group, index) => {
            setTimeout(() => {
                this.bot.removeItem(memberNumber, group);
            }, index * 200);
        });
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
            // TODO: If timeoutCount >= 3, consider removing player from room
            this.advanceTurn();
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
        return this.players.get(memberNumber)?.name ?? this.nameCache.get(memberNumber) ?? `Player #${memberNumber}`;
    }

    private shuffleArray(array: any[]): void {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }
}