// ============================================================
// GAME HOST CONTRACT - the shared services StripDiceGame exposes
// to subsystem managers (SoloGameManager, FeedbackManager, ...).
//
// This is the pattern for growing the bot without growing game.ts:
// a new subsystem gets its own manager class in its own file, holds
// its own state, and reaches shared machinery ONLY through this
// interface. If a manager needs something new from the game, add it
// here first — that keeps every cross-module dependency visible in
// one place. Never import game.ts from a manager (import cycle).
// ============================================================
import { BCConnection } from "./connection";
import { BotStorage } from "./storage";
import { FeedbackManager } from "./feedback";
import { BondageItem, BondageOutfit, PendingLockApplyCheck, TournamentGameContext } from "./types";

export interface GameHost {
    readonly bot: BCConnection;
    readonly storage: BotStorage;
    readonly feedback: FeedbackManager;

    // Lock-apply verification registry shared by end-game and solo penalty
    // locks: onSyncSingle() resolves entries when BC rejects an item update
    // (silence during the verify window means the lock was accepted).
    readonly pendingLockApplyChecks: Map<string, PendingLockApplyCheck>;

    // Writes bot_state.json with the current multiplayer + solo activity.
    saveBotState(): void;

    // Returns the admin-forced next roll (!debugroll) and clears it, or null.
    consumeDebugRoll(): number | null;

    // Whisper helper that splits long messages so BC doesn't drop them.
    sendLongWhisper(memberNumber: number, text: string, maxLen?: number): void;

    isAdmin(memberNumber: number): boolean;
    // Like isAdmin, but whispers a rejection to non-admins.
    requireAdmin(memberNumber: number): boolean;

    // Whispers every admin currently in the room, skipping `except`. Used to
    // surface things an admin would want to see as they happen (new feedback)
    // rather than only when they go looking for it.
    notifyAdminsInRoom(text: string, except?: number): void;

    // Resolves (auto-detecting from BC's Pronouns appearance item on first
    // use, sticky afterward, overridable via !clothes) which clothing list
    // a member's !wearing/!solo flow uses. See game.ts's implementation for
    // the full rationale (deliberately ignores body/genital data).
    resolveClothingPath(memberNumber: number): "male" | "female";

    // True if this member is currently in the room. Out-of-room delivery is
    // whisper-first for people who are present and beep-fallback for those who
    // aren't — beeps only reach players who are online, so neither path is
    // guaranteed and both are best-effort.
    isInRoom(memberNumber: number): boolean;
    // Everyone currently in the room, bot excluded.
    getRoomMembers(): number[];

    // Cached room-member name, if seen.
    getNameFor(memberNumber: number): string | undefined;
    // Cached name with a "Player #N" fallback.
    getPlayerName(memberNumber: number): string;
    // Exact-then-prefix name match against current room members.
    matchRoomMemberByName(query: string): { memberNumber: number; name: string } | undefined;

    // Sets the feedbackGiven flag on a player's persistent record.
    markFeedbackGiven(memberNumber: number): void;

    // The outfit this member last declared, in any mode. Shared with the
    // multiplayer game's "same outfit as last time?" memory, so a declaration
    // made in one mode carries into the other. In-memory: a restart forgets it.
    getLastClothing(memberNumber: number): string[] | undefined;
    setLastClothing(memberNumber: number, clothing: string[]): void;

    // ---- tournament bridge -------------------------------------------------
    // The tournament and solo managers never import each other; they meet
    // here. The tournament asks the game to start a solo game in tournament
    // mode, and the solo game reports the finished score back the same way.

    // Starts a tournament-mode solo game. Returns null on success, or a
    // player-facing reason it couldn't start (already playing, etc).
    startTournamentGame(memberNumber: number, name: string, ctx: TournamentGameContext): string | null;

    // Reports a finished tournament game. durationMs is wall-clock length,
    // which feeds the hidden time tiebreaker.
    reportTournamentGame(memberNumber: number, score: number, durationMs: number): void;

    // Punishment time this member still owes, in ms. Used to gate BD play.
    tournamentPunishMs(memberNumber: number): number;

    // Binds a player for tournament punishment, locked for `durationMs` under
    // `password` so whoever claims them can let them out early. The look is not
    // final — see design_tournament.md; it currently reuses the themed sets.
    applyTournamentPunishment(memberNumber: number, durationMs: number, password: string): void;
    // Frees a player from tournament punishment early (served in full, or
    // paused via !tournament stop). Also removes the claim leash.
    releaseTournamentPunishment(memberNumber: number): void;
    // Puts a leash (and a collar to hang it from, if they aren't wearing one)
    // on a claimed prisoner, locked to the same password and timer as the rest
    // of their punishment so it all comes off together.
    attachTournamentLeash(memberNumber: number, password: string, lockEndTime: number): void;

    // Item machinery shared with the multiplayer game.
    removeAllItems(memberNumber: number, startDelay?: number): void;
    getEligibleOutfits(memberNumber: number): BondageOutfit[];
    buildLockedItemProperty(
        item: BondageItem,
        options: { hint: string; removeItem: boolean; showTimer: boolean; removeTimer: number; password?: string }
    ): any;
}
