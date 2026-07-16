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
import { BondageItem, BondageOutfit, PendingLockApplyCheck } from "./types";

export interface GameHost {
    readonly bot: BCConnection;
    readonly storage: BotStorage;

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

    // Resolves (auto-detecting from BC's Pronouns appearance item on first
    // use, sticky afterward, overridable via !clothes) which clothing list
    // a member's !wearing/!solo flow uses. See game.ts's implementation for
    // the full rationale (deliberately ignores body/genital data).
    resolveClothingPath(memberNumber: number): "male" | "female";

    // Cached room-member name, if seen.
    getNameFor(memberNumber: number): string | undefined;
    // Cached name with a "Player #N" fallback.
    getPlayerName(memberNumber: number): string;
    // Exact-then-prefix name match against current room members.
    matchRoomMemberByName(query: string): { memberNumber: number; name: string } | undefined;

    // Sets the feedbackGiven flag on a player's persistent record.
    markFeedbackGiven(memberNumber: number): void;

    // Item machinery shared with the multiplayer game.
    removeAllItems(memberNumber: number, startDelay?: number): void;
    getEligibleOutfits(memberNumber: number): BondageOutfit[];
    buildLockedItemProperty(
        item: BondageItem,
        options: { hint: string; removeItem: boolean; showTimer: boolean; removeTimer: number }
    ): any;
}
