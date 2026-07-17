// ============================================================
// SHARED TYPES - interfaces, type aliases, and enums used across
// the game modules. No runtime dependencies (the GameState enum is
// the only value emitted). Keep this file import-free so it can be
// pulled in from anywhere without creating cycles.
// ============================================================

// ============================================================
// BONDAGE OUTFITS
// ============================================================
export interface BondageItem {
    group: string;
    name: string;
    color: string | string[];
    property: any;
}

export interface BondageOutfit {
    name: string;
    items: BondageItem[];
}

// Raw shape of an entry in outfits.json. Either a curated "items" array,
// or a BC appearance share code plus the list of item groups to extract from it.
export interface OutfitDefinition {
    name: string;
    items?: BondageItem[];
    code?: string;
    groups?: string[];
}

// ============================================================
// PLAYER-PICK BONDAGE MODE
// ============================================================
export type BondageMode = "outfit" | "player-pick";

// One in-flight player-pick selection. Only one can be active at a time —
// the game sits in WaitingBondage until it resolves.
export interface PendingBondagePick {
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
// ============================================================
export interface ItemSettingVariant {
    property: any;
    count: number;
}
export type ItemSettingsLibrary = Record<string, ItemSettingVariant[]>; // "Group:ItemName" -> observed configs

// ============================================================
// GAME STATES
// ============================================================
export enum GameState {
    Idle,           // No game running, waiting for players to join
    TeamSetup,      // Team mode lobby: picking team size and !join team1/team2
    Registration,   // Players joining, declaring clothing
    Countdown,      // All players joined, 30 second countdown
    Rolling,        // Active game, waiting for current player to roll
    WaitingRemove,  // Player lost, waiting for !removed
    WaitingBondage, // Player naked, bot applying bondage
    SafewordPause,  // A player called safeword, waiting for !continue or timeout
    Paused,         // Player-requested pause, waiting for anyone to !resume
    PausedForJoin,  // Briefly paused so a mid-game joiner can get into rotation
    GameOver        // All players bound, applying locks
}

// ============================================================
// PLAYER DATA
// ============================================================
export interface Player {
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
    joinedAfterPregameStart: boolean; // Joined during Registration after the original roster's toys/bondage-mode Q&A already began; handled via individual late gates instead of the group flow
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
    prizeConsent: boolean | null; // null = unanswered, true = opted in as a potential prize for the winner
    bondageMode: BondageMode | null; // null = unanswered pre-game mode question; resolved to "player-pick" on timeout
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
export interface PendingLockVerification {
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
export interface PendingLockApplyCheck {
    itemName: string;
    onResult: (rejected: boolean) => void;
}

// ============================================================
// FEEDBACK STATUS TRACKING
// ============================================================
export type FeedbackItemStatus = "pending" | "reviewing" | "testing" | "researching" | "implemented" | "declined" | "partly_implemented";

export interface FeedbackItem {
    timestamp: string;
    text: string;
    status: FeedbackItemStatus;
    // Resolved statuses (implemented/declined/partly_implemented) are only
    // whispered to the submitter once; this flag is set after that whisper
    // so the entry isn't repeated on later joins. Pending entries are never
    // marked shown.
    statusShown?: boolean;
}

export interface FeedbackStatusEntry {
    name: string;
    items: FeedbackItem[];
    // ISO timestamp of the last time this player was sent the bundled
    // "we're reviewing it" ack. A new ack is only sent if a reviewing/pending/
    // researching/testing item with a newer timestamp arrives.
    reviewingAckDate?: string;
}

// ============================================================
// PLAYER TRACKING
// ============================================================
export interface PlayerRecord {
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
export type SoloMode = "race" | "survive";

// Active solo game state, isolated per player. Solo games run alongside an
// active multiplayer game without interference; all interaction is whispered.
export interface SoloGameState {
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
export interface GameLogEntry {
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

export interface SoloRecordEntry {
    memberNumber: number;
    name: string;
    rolls: number;
}

export type SoloBracketRecords = Record<string, SoloRecordEntry>; // bracket -> record
export type SoloAttemptCounts = Record<string, number>;           // memberNumber -> attempts today

export interface SoloRecordsData {
    date: string; // UTC date (YYYY-MM-DD) the daily records/attempts were last reset
    daily: Record<SoloMode, SoloBracketRecords>;
    allTime: Record<SoloMode, SoloBracketRecords>;
    attempts: Record<SoloMode, Record<string, SoloAttemptCounts>>; // bracket -> memberNumber -> count
}

// Player-submitted outfit idea, stored for admin review and possible future
// use as a bondage penalty outfit.
export interface OutfitSuggestion {
    memberNumber: number;
    name: string;
    description: string;
    timestamp: string;
}

// ============================================================
// COMMAND DISPATCH TABLE
// ============================================================
export type CommandHandler = (memberNumber: number, name: string, msg: string, message: string) => void;

export interface CommandDef {
    handler: CommandHandler;
    whisperOnly?: boolean; // Only dispatched from handleWhisper
    chatOnly?: boolean;    // Only dispatched from handleChat
    prefix?: boolean;      // Match if msg starts with the command string, instead of equals
}
