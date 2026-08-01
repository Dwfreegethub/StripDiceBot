// ============================================================
// SOLO GAME MODE - the whispered single-player race/survive game,
// its daily/all-time records, and the !scores displays. Owns all
// solo state; reaches shared machinery (item application, lock
// verification, storage) only through GameHost.
// ============================================================
import { log, logGameEvent } from "./logger";
import { GameHost } from "./host";
import { BondageItem, SoloGameState, SoloMode, SoloRecordEntry, SoloRecordsData, TournamentGameContext } from "./types";
import {
    ClothingPath, clothingSlotsFor, LOCK_VERIFY_DELAY_MS, MAX_END_GAME_LOCK_RETRIES,
    REMOVAL_SLOT_DELAY_MS, REMOVAL_UNLOCK_GAP_MS,
    SOLO_BASE_PENALTY_MINUTES, SOLO_BONDAGE_DELAY_MS, SOLO_BRACKET_MAX, SOLO_BRACKET_MIN,
    SOLO_DEFAULT_TARGET, SOLO_DICE_MAX, SOLO_INACTIVITY_TIMEOUT_MS, SOLO_REMOVAL_REMINDER_MS,
    TOURNAMENT_RESUME_GRACE_MS,
} from "./constants";
import { formatDuration } from "./util";

// ============================================================
// SOLO THEMED BONDAGE - path-based bondage applied after a solo
// game loss. One item is randomly chosen per stage and then locked
// exactly like the outfit-based penalty. All 9 themes from SSS,
// except Shibari's hogtie stage is omitted (too restrictive post-game).
// ============================================================
interface SoloThemeStage { group: string; items: string[]; typeRecord?: Record<string, number> }
interface SoloTheme { key: string; name: string; stages: SoloThemeStage[] }

const SOLO_THEMES: SoloTheme[] = [
    {
        key: "strict", name: "strict bondage",
        stages: [
            { group: "ItemMouth", items: ["HarnessBallGag", "RingGag", "ClothGag"] },
            { group: "ItemFeet", items: ["LeatherAnkleCuffs", "SteelAnkleCuffs", "HeavyAnkleCuffs"] },
            { group: "ItemLegs", items: ["LegBinder", "HempRope", "LeatherLegCuffs"] },
            { group: "ItemHands", items: ["FullMittens", "PaddedMittens", "LatexBondageMitts"] },
            { group: "ItemHead", items: ["LeatherBlindfold", "PaddedBlindfold", "ClothBlindfold"] },
            { group: "ItemHood", items: ["LeatherHood", "CanvasHood"] },
        ],
    },
    {
        key: "pet", name: "pet play",
        stages: [
            { group: "ItemEars", items: ["CustomizableCatEars", "CustomizableFluffyEars1", "CustomizableCowEars"] },
            { group: "ItemNeckAccessories", items: ["CollarBell", "CollarNameTagPet", "CollarCowBell"] },
            { group: "ItemHands", items: ["PawMittens", "PonyMittensBinder", "FoamMittens"] },
            { group: "ItemMouth", items: ["KittyGag", "MuzzleGag", "KittyMuzzleGag"] },
            { group: "ItemButt", items: ["PuppyTailPlug", "FoxTails", "KittenTail1"] },
        ],
    },
    {
        key: "display", name: "display & chastity",
        stages: [
            { group: "ItemMouth", items: ["RingGag", "FuturisticPanelGag", "ClothGag"] },
            { group: "ItemNipples", items: ["NippleClamp", "ScrewClamps", "Clothespins"] },
            { group: "ItemPelvis", items: ["MetalChastityBelt", "OrnateChastityBelt", "ModularChastityBelt"] },
            { group: "ItemFeet", items: ["SpreaderMetal", "HeavySpreaderMetal"] },
            { group: "ItemDevices", items: ["Pole", "X-Cross", "DisplayCase", "TheDisplayFrame"] },
        ],
    },
    {
        key: "sensory", name: "sensory deprivation",
        stages: [
            { group: "ItemMouth", items: ["PumpGag", "HarnessPanelGag", "FuturisticHarnessPanelGag"] },
            { group: "ItemEars", items: ["HeavyDutyEarPlugs", "HeadphoneEarPlugs"] },
            { group: "ItemHead", items: ["FullBlindfold", "LatexBlindfold", "PaddedBlindfold"] },
            { group: "ItemHands", items: ["FullMittens", "LatexBondageMitts"] },
            { group: "ItemHood", items: ["LeatherHoodSensDep", "SackHood"] },
        ],
    },
    {
        // Hogtie stage intentionally omitted — too restrictive for post-game use.
        key: "shibari", name: "shibari",
        stages: [
            { group: "ItemTorso", items: ["NylonRopeHarness", "HempRopeHarness"] },
            { group: "ItemMouth", items: ["RopeGag", "RopeBallGag"] },
            { group: "ItemLegs", items: ["NylonRope", "HempRope"] },
            { group: "ItemFeet", items: ["NylonRope", "HempRope"] },
        ],
    },
    {
        key: "hightech", name: "high-tech restraints",
        stages: [
            { group: "ItemMouth", items: ["FuturisticPanelGag", "FuturisticHarnessPanelGag", "FuturisticMuzzle", "TechnoGag"] },
            { group: "ItemArms", items: ["FuturisticCuffs", "FuturisticStraitjacket", "FuturisticArmbinder"] },
            { group: "ItemFeet", items: ["FuturisticAnkleCuffs"] },
            { group: "ItemLegs", items: ["FuturisticLegCuffs"] },
            { group: "ItemHood", items: ["TechnoHelmet1", "FuturisticHelmet"] },
        ],
    },
    {
        key: "leather", name: "leather restraints",
        stages: [
            { group: "ItemTorso", items: ["LeatherHarness", "LeatherStrapHarness", "LeatherChestHarness1"] },
            { group: "ItemMouth", items: ["LeatherCorsetCollar"] },
            { group: "ItemArms", items: ["LeatherArmbinder", "LeatherCuffs", "LeatherDeluxeCuffs", "SmoothLeatherArmbinder1"] },
            { group: "ItemFeet", items: ["LeatherAnkleCuffs", "LeatherDeluxeAnkleCuffs"] },
            { group: "ItemLegs", items: ["LeatherLegCuffs", "LeatherDeluxeLegCuffs"] },
            { group: "ItemHands", items: ["LeatherMittens", "PaddedLeatherMittens", "SmoothLeatherMittens1"] },
            { group: "ItemHead", items: ["LeatherBlindfold", "LeatherSlimMask", "LeatherSlimMaskOpenMouth"] },
            { group: "ItemHood", items: ["LeatherHood", "LeatherHoodOpenEyes", "LeatherHoodOpenMouth", "LeatherHoodSealed"] },
        ],
    },
    {
        key: "latex", name: "latex enclosure",
        stages: [
            { group: "ItemTorso", items: ["LatexCorset1", "HeavyLatexCorset", "ClassicLatexCorset"] },
            { group: "ItemMouth", items: ["LatexBallMuzzleGag", "LatexSheathGag", "LatexMuzzleMask", "LatexRespirator"] },
            { group: "ItemArms", items: ["LatexArmbinder", "SeamlessLatexArmbinder", "LatexBoxtieLeotard", "LatexButterflyLeotard"] },
            { group: "ItemHands", items: ["LatexBondageMitts"] },
            { group: "ItemHead", items: ["LatexBlindfold"] },
            { group: "ItemHood", items: ["LatexHoodOpenHair", "CustomLatexHood", "TransparentLatexHood", "RubberMask", "LatexDogHood"] },
        ],
    },
    {
        key: "leather_latex", name: "leather & latex",
        stages: [
            { group: "ItemTorso", items: ["LeatherHarness", "LeatherChestHarness1", "LatexCorset1", "HeavyLatexCorset"] },
            { group: "ItemMouth", items: ["LeatherCorsetCollar", "LatexBallMuzzleGag", "LatexMuzzleMask"] },
            { group: "ItemArms", items: ["LeatherArmbinder", "SmoothLeatherArmbinder1", "LatexArmbinder", "SeamlessLatexArmbinder"] },
            { group: "ItemFeet", items: ["LeatherAnkleCuffs", "LeatherDeluxeAnkleCuffs"] },
            { group: "ItemLegs", items: ["LeatherLegCuffs", "LeatherDeluxeLegCuffs"] },
            { group: "ItemHands", items: ["LeatherMittens", "PaddedLeatherMittens", "LatexBondageMitts"] },
            { group: "ItemHead", items: ["LeatherBlindfold", "LeatherSlimMask", "LatexBlindfold"] },
            { group: "ItemHood", items: ["LeatherHood", "LeatherHoodOpenEyes", "LatexHoodOpenHair", "CustomLatexHood", "TransparentLatexHood"] },
        ],
    },
];

const SOLO_THEME_OFFER_TIMEOUT_MS = 30 * 1000;

export class SoloGameManager {
    private soloGames: Map<number, SoloGameState> = new Map();
    private pendingSoloSetup: Map<number, { mode: SoloMode; name: string; clothingPath: ClothingPath; clothingQuestionIndex: number; pendingClothing: string[]; tournamentCtx: TournamentGameContext | null }> = new Map();
    // Players who finished a solo game and are awaiting a yes/no to the prize question.
    private pendingSoloPrizeQuestion: Map<number, string> = new Map(); // memberNumber → name
    // Players who said yes to the prize question and are now describing what it means to them.
    private pendingSoloPrizeDescription: Map<number, string> = new Map(); // memberNumber → name
    // Players who were offered a themed bondage path after losing and haven't replied yet.
    private pendingThemeOffer: Map<number, { theme: SoloTheme; penaltyMinutes: number; timer: ReturnType<typeof setTimeout> }> = new Map();
    // Tournament games whose player left the room mid-game. Held (not scored,
    // not discarded) until they return or the grace window expires.
    private parkedTournamentGames: Map<number, { solo: SoloGameState; ctx: TournamentGameContext; timer: NodeJS.Timeout }> = new Map();

    constructor(private readonly host: GameHost) {}

    // ---- queries used by game.ts dispatch --------------------------------

    public activeCount(): number {
        return this.soloGames.size;
    }

    public hasGame(memberNumber: number): boolean {
        return this.soloGames.has(memberNumber);
    }

    public hasPendingSetup(memberNumber: number): boolean {
        return this.pendingSoloSetup.has(memberNumber);
    }

    public isAwaitingRemoval(memberNumber: number): boolean {
        return this.soloGames.get(memberNumber)?.awaitingRemoval ?? false;
    }

    public isAwaitingPrizeQuestion(memberNumber: number): boolean {
        return this.pendingSoloPrizeQuestion.has(memberNumber);
    }

    public isAwaitingPrizeDescription(memberNumber: number): boolean {
        return this.pendingSoloPrizeDescription.has(memberNumber);
    }

    public hasThemeOffer(memberNumber: number): boolean {
        return this.pendingThemeOffer.has(memberNumber);
    }

    // Player typed !yes — apply the offered theme.
    public acceptThemeOffer(memberNumber: number): void {
        const pending = this.pendingThemeOffer.get(memberNumber);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingThemeOffer.delete(memberNumber);
        this.applyThemePenalty(memberNumber, pending.theme, pending.penaltyMinutes);
    }

    // Player typed !no (or timed out) — fall back to a random preset outfit.
    public declineThemeOffer(memberNumber: number): void {
        const pending = this.pendingThemeOffer.get(memberNumber);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingThemeOffer.delete(memberNumber);
        this.host.bot.whisper(memberNumber, "No problem — applying a random preset outfit instead.");
        this.applyPenalty(memberNumber, pending.penaltyMinutes);
    }

    // Player responded yes/no to the post-game prize question.
    public handlePrizeQuestion(memberNumber: number, agreed: boolean): void {
        const name = this.pendingSoloPrizeQuestion.get(memberNumber);
        if (name === undefined) return;
        this.pendingSoloPrizeQuestion.delete(memberNumber);

        if (!agreed) {
            this.host.bot.whisper(memberNumber, "No worries — the option will be there when you're ready. 😈");
            return;
        }

        // Prize system is in development — thank them and let them know it's coming.
        this.host.bot.whisper(memberNumber,
            "🏆 It's coming — someone's going to get to claim you properly soon. " +
            "If you've shared your thoughts via !feedback, we've read every one. Thank you! 💕"
        );
    }

    // Player sent their prize description — log it as feedback.
    public handlePrizeDescription(memberNumber: number, text: string): void {
        const name = this.pendingSoloPrizeDescription.get(memberNumber);
        if (name === undefined) return;
        this.pendingSoloPrizeDescription.delete(memberNumber);

        const feedbackText = `[Solo Prize Vision] ${text}`;
        this.host.feedback.submitDirect(memberNumber, name, feedbackText);
        log(`[SOLO PRIZE VISION] ${name} (#${memberNumber}): ${text}`);
    }

    // ---- game flow --------------------------------------------------------

    public start(memberNumber: number, name: string, mode: SoloMode): void {
        if (this.soloGames.has(memberNumber)) {
            this.host.bot.whisper(memberNumber, "You already have a solo game in progress — !roll to continue.");
            return;
        }
        const clothingPath = this.host.resolveClothingPath(memberNumber);
        this.pendingSoloSetup.set(memberNumber, { mode, name, clothingPath, clothingQuestionIndex: 0, pendingClothing: [], tournamentCtx: null });
        this.host.bot.whisper(memberNumber, "Let's go through your outfit — yes or no for each item.");
        this.askClothingQuestion(memberNumber);
    }

    // Starts a solo game that counts toward a tournament match. Always Survive
    // mode. Returns null on success, or a player-facing reason it can't start.
    // The clothing count is enforced rather than free-form: everyone in a
    // tournament plays the same bracket or the scores aren't comparable.
    public startTournamentGame(memberNumber: number, name: string, ctx: TournamentGameContext): string | null {
        if (this.soloGames.has(memberNumber)) {
            return "You already have a solo game in progress — finish it first (!roll), or whisper !solo_reset to an admin.";
        }
        const clothingPath = this.host.resolveClothingPath(memberNumber);
        this.pendingSoloSetup.set(memberNumber, {
            mode: "survive", name, clothingPath,
            clothingQuestionIndex: 0, pendingClothing: [], tournamentCtx: ctx,
        });
        this.host.sendLongWhisper(memberNumber,
            `🏆 Tournament — Round ${ctx.round}, game ${ctx.gameNumber} of ${ctx.totalGames}` +
            `${ctx.opponentName ? ` vs ${ctx.opponentName}` : ""}.\n` +
            `You need exactly ${ctx.requiredClothing} clothing items for this one. ` +
            `Let's go through your outfit — yes or no for each item.`);
        this.askClothingQuestion(memberNumber);
        return null;
    }

    private askClothingQuestion(memberNumber: number): void {
        const pending = this.pendingSoloSetup.get(memberNumber)!;
        const slots = clothingSlotsFor(pending.clothingPath);
        const idx = pending.clothingQuestionIndex;

        if (idx >= slots.length) {
            const clothing = slots.filter(slot => pending.pendingClothing.includes(slot));

            // Tournament games are a fixed bracket so every score is comparable.
            // Wrong count aborts rather than looping the questions — the player
            // has to actually change clothes, which they can't do mid-Q&A.
            if (pending.tournamentCtx) {
                const required = pending.tournamentCtx.requiredClothing;
                if (clothing.length !== required) {
                    this.pendingSoloSetup.delete(memberNumber);
                    this.host.sendLongWhisper(memberNumber,
                        `⚠️ Tournament games need exactly ${required} clothing items — you declared ${clothing.length}` +
                        `${clothing.length > 0 ? ` (${clothing.join(", ")})` : ""}.\n` +
                        `Adjust what you're wearing, then whisper !tournament play to try again.`);
                    return;
                }
            } else if (clothing.length < SOLO_BRACKET_MIN) {
                this.host.bot.whisper(memberNumber, `You need at least ${SOLO_BRACKET_MIN} items to start — let's try again.`);
                pending.clothingQuestionIndex = 0;
                pending.pendingClothing = [];
                this.askClothingQuestion(memberNumber);
                return;
            }

            this.startGame(memberNumber, pending.mode, pending.name, clothing, pending.tournamentCtx);
            return;
        }

        const prefix = idx === 0
            ? `You're on the ${pending.clothingPath} clothing list (whisper !clothes male or !clothes female, then !solo again, to switch). `
            : "";
        this.host.bot.whisper(memberNumber, `${prefix}Wearing ${slots[idx]}? (yes/no)`);
    }

    public handleClothingAnswer(memberNumber: number, msg: string): void {
        const pending = this.pendingSoloSetup.get(memberNumber)!;
        const slots = clothingSlotsFor(pending.clothingPath);
        const idx = pending.clothingQuestionIndex;
        const item = slots[idx];

        if (msg === "yes" || msg === "y") {
            pending.pendingClothing.push(item);
        }

        pending.clothingQuestionIndex = idx + 1;
        this.askClothingQuestion(memberNumber);
    }

    private startGame(memberNumber: number, mode: SoloMode, name: string, clothing: string[], tournamentCtx: TournamentGameContext | null = null): void {
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
            tournamentCtx,
        };
        this.soloGames.set(memberNumber, solo);
        this.host.saveBotState();

        if (tournamentCtx) {
            logGameEvent(`[TOURNAMENT GAME START] round ${tournamentCtx.round} ${tournamentCtx.matchId} | ` +
                `game ${tournamentCtx.gameNumber}/${tournamentCtx.totalGames} | ` +
                `player: ${name} (#${memberNumber}) vs ${tournamentCtx.opponentName ?? "?"}`);
            this.host.bot.sendChat(
                `🏆 ${name} is playing Round ${tournamentCtx.round} of the tournament` +
                `${tournamentCtx.opponentName ? ` against ${tournamentCtx.opponentName}` : ""} — ` +
                `game ${tournamentCtx.gameNumber} of ${tournamentCtx.totalGames}. Good luck!`);
        } else {
            logGameEvent(`[SOLO START] mode: ${solo.mode} | bracket: ${bracket} | player: ${solo.name} (#${memberNumber})`);
            this.host.bot.sendChat(`🎲 ${name} is playing a solo game — good luck!`);
        }

        const modeLabel = mode === "race" ? "Race to Naked" : "Survive";
        const objective = mode === "race"
            ? "Each roll's result becomes your next roll's max. Hit a 1 and you lose an item — fewest total rolls wins."
            : "Each roll's result becomes your next roll's max. Hit a 1 and you lose an item — most total rolls before you're naked wins.";

        this.host.bot.whisper(memberNumber,
            `🎲 ${modeLabel} — starting with ${bracket} item${bracket === 1 ? "" : "s"}: ${clothing.join(", ")}.\n` +
            `${objective}\n` +
            `This is just between us.`
        );
        this.host.bot.whisper(memberNumber, `${solo.name}, you're at ${solo.currentMax} — !roll.`);
        this.startInactivityTimer(memberNumber);
    }

    public handleRoll(memberNumber: number): void {
        const solo = this.soloGames.get(memberNumber);
        if (!solo) return;

        this.clearInactivityTimer(solo);

        if (solo.awaitingRemoval) {
            const lostItem = solo.clothingLost[solo.clothingLost.length - 1];
            this.host.bot.whisper(memberNumber, `⏸️ Remove your ${lostItem}.`);
            this.startInactivityTimer(memberNumber);
            return;
        }

        let roll: number;
        const debugRoll = this.host.consumeDebugRoll();
        if (debugRoll !== null) {
            roll = debugRoll;
        } else {
            roll = Math.floor(Math.random() * solo.currentMax) + 1;
        }
        solo.totalRolls++;
        solo.rollsThisItem++;

        if (roll === 1) {
            const lostItem = solo.clothingRemaining.shift()!;
            solo.clothingLost.push(lostItem);

            this.host.bot.whisper(memberNumber,
                `You rolled a 1 — lost your ${lostItem}! (${solo.rollsThisItem} roll${solo.rollsThisItem === 1 ? "" : "s"} for that item, ${solo.totalRolls} total)`
            );

            solo.awaitingRemoval = true;
            this.host.bot.whisper(memberNumber, `Remove your ${lostItem}.`);
            this.startInactivityTimer(memberNumber);
            return;
        }

        solo.currentMax = roll;
        this.host.bot.whisper(memberNumber, `You are now at ${roll} — !roll again.`);
        this.startInactivityTimer(memberNumber);
    }

    // Called once the player confirms (whispered !removed, or closed their
    // Wardrobe) that the item they just lost is off.
    public handleRemoved(memberNumber: number): void {
        const solo = this.soloGames.get(memberNumber);
        if (!solo || !solo.awaitingRemoval) return;

        this.clearInactivityTimer(solo);
        solo.awaitingRemoval = false;

        if (solo.clothingRemaining.length === 0) {
            this.finishGame(memberNumber);
            return;
        }

        solo.currentMax = SOLO_DICE_MAX;
        solo.rollsThisItem = 0;
        this.host.bot.whisper(memberNumber, `${solo.clothingRemaining.length} item${solo.clothingRemaining.length === 1 ? "" : "s"} left: ${solo.clothingRemaining.join(", ")}.`);
        this.host.bot.whisper(memberNumber, `${solo.name}, you're at ${solo.currentMax} — !roll.`);
        this.startInactivityTimer(memberNumber);
    }

    // Soft nudge if the player goes quiet after a prompt. Does not end the
    // game; resets whenever the player acts. While awaiting a clothing
    // removal, we wait for the Wardrobe-close event (handleWardrobe) rather
    // than rushing the player, only mentioning !removed as a fallback if
    // SOLO_REMOVAL_REMINDER_MS passes with no Wardrobe activity — then keeps
    // re-reminding every interval until they act.
    private startInactivityTimer(memberNumber: number): void {
        const solo = this.soloGames.get(memberNumber);
        if (!solo) return;

        this.clearInactivityTimer(solo);
        if (solo.awaitingRemoval) {
            solo.inactivityTimer = setTimeout(() => {
                solo.inactivityTimer = null;
                const lostItem = solo.clothingLost[solo.clothingLost.length - 1];
                this.host.bot.whisper(memberNumber, `Remove your ${lostItem} or type !removed if you have already removed them to continue.`);
                this.startInactivityTimer(memberNumber);
            }, SOLO_REMOVAL_REMINDER_MS);
        } else {
            solo.inactivityTimer = setTimeout(() => {
                solo.inactivityTimer = null;
                this.host.bot.whisper(memberNumber, "Whenever you're ready — type !roll to continue.");
            }, SOLO_INACTIVITY_TIMEOUT_MS);
        }
    }

    private clearInactivityTimer(solo: SoloGameState): void {
        if (solo.inactivityTimer) {
            clearTimeout(solo.inactivityTimer);
            solo.inactivityTimer = null;
        }
    }

    // Returns true if `score` beats `current` (or the hardcoded default target
    // if no record exists yet). For "race", fewer rolls is better; for
    // "survive", more rolls is better.
    private isRecordBeat(mode: SoloMode, score: number, current: SoloRecordEntry | undefined): boolean {
        const target = current ? current.rolls : SOLO_DEFAULT_TARGET;
        return mode === "race" ? score < target : score > target;
    }

    private finishGame(memberNumber: number): void {
        const solo = this.soloGames.get(memberNumber);
        if (!solo) return;
        this.clearInactivityTimer(solo);
        this.soloGames.delete(memberNumber);
        this.host.saveBotState();

        // Tournament games are scored, not judged: no daily/all-time records,
        // no attempts ladder, no penalty bondage. The only consequence is the
        // match result, which the tournament manager works out from the score.
        if (solo.tournamentCtx) {
            this.finishTournamentGame(memberNumber, solo, solo.tournamentCtx);
            return;
        }

        const records = this.host.storage.loadSoloRecords();
        const bracketKey = String(solo.bracket);
        const modeLabel = solo.mode === "race" ? "Race to Naked" : "Survive";
        const dailyRecord = records.daily[solo.mode][bracketKey];
        const allTimeRecord = records.allTime[solo.mode][bracketKey];
        const score = solo.totalRolls;
        const endTime = new Date().toISOString();
        const players = [`${solo.name}(#${memberNumber})`];

        this.host.bot.whisper(memberNumber, `🎉 You're naked! Final score: ${score} roll${score === 1 ? "" : "s"}.`);
        this.host.feedback.maybeSuggestFeedback(memberNumber);
        this.askSoloPrizeQuestion(memberNumber, solo.name);

        const entry: SoloRecordEntry = { memberNumber, name: solo.name, rolls: score };

        // No all-time record yet for this mode/bracket: this run sets it (and
        // the daily record) penalty-free — the first player to finish in a
        // bracket always gets a free run, since there's no record to beat.
        if (!allTimeRecord) {
            records.daily[solo.mode][bracketKey] = entry;
            records.allTime[solo.mode][bracketKey] = entry;
            this.host.bot.whisper(memberNumber, `🏆 You set the all-time record for ${modeLabel} (${solo.bracket}-item bracket) — ${score} rolls! No penalty for being first.`);

            logGameEvent(`[SOLO END] mode: ${solo.mode} | bracket: ${solo.bracket} | player: ${solo.name} | score: ${score} rolls | outcome: record-beaten`);
            this.host.storage.appendGameLog({
                type: "solo", mode: solo.mode, startTime: solo.startTime, endTime,
                players, outcome: "record-beaten", score,
            });

            this.host.storage.incrementGameCount("solo_strip");
            this.host.removeAllItems(memberNumber);
            this.host.storage.saveSoloRecords(records);
            return;
        }

        if (this.isRecordBeat(solo.mode, score, allTimeRecord)) {
            records.daily[solo.mode][bracketKey] = entry;
            records.allTime[solo.mode][bracketKey] = entry;
            this.host.bot.sendChat(`🎲 ${solo.name} set a new daily record for ${modeLabel} (${solo.bracket}-item bracket) — ${score} rolls!`);
            this.host.bot.sendChat(`🏆 That's also a new ALL-TIME record for ${modeLabel} (${solo.bracket}-item bracket)!`);

            logGameEvent(`[SOLO END] mode: ${solo.mode} | bracket: ${solo.bracket} | player: ${solo.name} | score: ${score} rolls | outcome: record-beaten`);
            this.host.storage.appendGameLog({
                type: "solo", mode: solo.mode, startTime: solo.startTime, endTime,
                players, outcome: "record-beaten", score,
            });

            this.host.storage.incrementGameCount("solo_strip");
            this.host.removeAllItems(memberNumber);
            this.host.storage.saveSoloRecords(records);
            return;
        }

        // All-time record stands, but no daily record yet today (or this run
        // beats today's daily record): set/keep the daily record, no penalty.
        if (!dailyRecord || this.isRecordBeat(solo.mode, score, dailyRecord)) {
            records.daily[solo.mode][bracketKey] = entry;
            this.host.bot.sendChat(`🎲 ${solo.name} set a new daily record for ${modeLabel} (${solo.bracket}-item bracket) — ${score} rolls!`);

            logGameEvent(`[SOLO END] mode: ${solo.mode} | bracket: ${solo.bracket} | player: ${solo.name} | score: ${score} rolls | outcome: record-beaten`);
            this.host.storage.appendGameLog({
                type: "solo", mode: solo.mode, startTime: solo.startTime, endTime,
                players, outcome: "record-beaten", score,
            });

            this.host.storage.incrementGameCount("solo_strip");
            this.host.removeAllItems(memberNumber);
            this.host.storage.saveSoloRecords(records);
            return;
        }

        const recordRolls = dailyRecord.rolls;
        this.host.bot.whisper(memberNumber, `You didn't beat the record (${recordRolls} rolls). Better luck next time!`);

        const attemptsToday = records.attempts[solo.mode][bracketKey]?.[String(memberNumber)] ?? 0;
        const penaltyMinutes = SOLO_BASE_PENALTY_MINUTES + attemptsToday * 2;
        setTimeout(() => {
            this.offerThemeBondage(memberNumber, penaltyMinutes);
        }, SOLO_BONDAGE_DELAY_MS);

        logGameEvent(`[SOLO END] mode: ${solo.mode} | bracket: ${solo.bracket} | player: ${solo.name} | score: ${score} rolls | outcome: loss | penalty: ${penaltyMinutes}min`);
        this.host.storage.appendGameLog({
            type: "solo", mode: solo.mode, startTime: solo.startTime, endTime,
            players, outcome: "loss", score, penaltyMin: penaltyMinutes,
        });

        this.host.storage.incrementGameCount("solo_bondage");
        if (!records.attempts[solo.mode][bracketKey]) records.attempts[solo.mode][bracketKey] = {};
        records.attempts[solo.mode][bracketKey][String(memberNumber)] = attemptsToday + 1;
        this.host.storage.saveSoloRecords(records);
    }

    // Applies a random themed bondage set, locked for `minutes`, as tournament
    // punishment. Exposed so the tournament manager can reuse the machinery
    // without owning any bondage code. Deliberately reuses the solo themes
    // until a dedicated tournament look is decided — swap the theme choice
    // here and nothing else changes.
    public applyTournamentBondage(memberNumber: number, minutes: number): void {
        const theme = SOLO_THEMES[Math.floor(Math.random() * SOLO_THEMES.length)];
        log(`Tournament punishment for #${memberNumber}: ${theme.name}, ${minutes} min`);
        this.applyThemePenalty(memberNumber, theme, minutes);
    }

    // ---- parked tournament games (left the room mid-game) ------------------

    // Holds an in-progress tournament game while its player is out of the
    // room. Nothing is scored yet — that only happens if they come back.
    private parkTournamentGame(memberNumber: number, solo: SoloGameState, ctx: TournamentGameContext): void {
        const existing = this.parkedTournamentGames.get(memberNumber);
        if (existing) clearTimeout(existing.timer);

        const timer = setTimeout(() => {
            this.parkedTournamentGames.delete(memberNumber);
            logGameEvent(`[TOURNAMENT GAME VOID] round ${ctx.round} ${ctx.matchId} | ` +
                `game ${ctx.gameNumber}/${ctx.totalGames} | player: ${solo.name} (#${memberNumber}) | ` +
                `did not return within ${formatDuration(TOURNAMENT_RESUME_GRACE_MS)} — game discarded, no score`);
            this.host.storage.appendGameLog({
                type: "solo", mode: solo.mode, startTime: solo.startTime, endTime: new Date().toISOString(),
                players: [`${solo.name}(#${memberNumber})`], outcome: "tournament-void",
            });
            // Best-effort heads-up; they're out of the room by definition.
            if (this.host.bot.isFriend(memberNumber)) {
                this.host.bot.beep(memberNumber,
                    `Your tournament game was cancelled — you didn't get back in time. Whisper !tournament play to start it again.`);
            }
        }, TOURNAMENT_RESUME_GRACE_MS);

        this.parkedTournamentGames.set(memberNumber, { solo, ctx, timer });
        logGameEvent(`[TOURNAMENT GAME PARKED] round ${ctx.round} ${ctx.matchId} | ` +
            `game ${ctx.gameNumber}/${ctx.totalGames} | player: ${solo.name} (#${memberNumber}) | ` +
            `${solo.totalRolls} rolls so far | ${formatDuration(TOURNAMENT_RESUME_GRACE_MS)} to return`);
    }

    // Called when a member enters the room. Restores a parked tournament game
    // if they made it back in time. Returns true if one was resumed.
    public resumeParkedGame(memberNumber: number): boolean {
        const parked = this.parkedTournamentGames.get(memberNumber);
        if (!parked) return false;

        clearTimeout(parked.timer);
        this.parkedTournamentGames.delete(memberNumber);

        const { solo, ctx } = parked;
        this.soloGames.set(memberNumber, solo);
        this.host.saveBotState();

        logGameEvent(`[TOURNAMENT GAME RESUMED] round ${ctx.round} ${ctx.matchId} | ` +
            `game ${ctx.gameNumber}/${ctx.totalGames} | player: ${solo.name} (#${memberNumber}) | ` +
            `${solo.totalRolls} rolls so far`);

        const next = solo.awaitingRemoval
            ? `You still need to remove your ${solo.clothingLost[solo.clothingLost.length - 1]} — then !roll.`
            : `You're at ${solo.currentMax} — !roll when ready.`;
        this.host.sendLongWhisper(memberNumber,
            `🏆 Welcome back — your tournament game is still going (Round ${ctx.round}, ` +
            `game ${ctx.gameNumber} of ${ctx.totalGames}, ${solo.totalRolls} rolls so far).\n${next}`);
        this.startInactivityTimer(memberNumber);
        return true;
    }

    // True if this member has a tournament game waiting for them to return.
    public hasParkedGame(memberNumber: number): boolean {
        return this.parkedTournamentGames.has(memberNumber);
    }

    // Ends a tournament game: report the score and get out of the way. No
    // records, no attempts, no bondage — a match is three of these back to
    // back, so applying the usual solo penalty after each would leave a player
    // locked three times over before their match even resolved. If bondage is
    // ever wanted here (as a way to add rolls), flip ctx.allowBondage and
    // branch below; the suppression is deliberately in one place.
    private finishTournamentGame(memberNumber: number, solo: SoloGameState, ctx: TournamentGameContext): void {
        const score = solo.totalRolls;
        const durationMs = Math.max(0, Date.now() - Date.parse(solo.startTime));

        logGameEvent(`[TOURNAMENT GAME END] round ${ctx.round} ${ctx.matchId} | ` +
            `game ${ctx.gameNumber}/${ctx.totalGames} | player: ${solo.name} (#${memberNumber}) | ` +
            `score: ${score} rolls | duration: ${Math.round(durationMs / 1000)}s`);

        this.host.storage.appendGameLog({
            type: "solo", mode: solo.mode, startTime: solo.startTime, endTime: new Date().toISOString(),
            players: [`${solo.name}(#${memberNumber})`], outcome: "tournament", score,
        });

        this.host.bot.whisper(memberNumber,
            `🏆 Game ${ctx.gameNumber} of ${ctx.totalGames} complete — you survived ${score} roll${score === 1 ? "" : "s"}.`);

        if (ctx.allowBondage) {
            // Not used yet — see the comment above. Kept as an explicit branch
            // so enabling it later is a one-line change rather than a rewrite.
            const attemptsToday = 0;
            setTimeout(() => this.offerThemeBondage(memberNumber, SOLO_BASE_PENALTY_MINUTES + attemptsToday), SOLO_BONDAGE_DELAY_MS);
        } else {
            // Clear whatever they stripped out of, same as a record-beating
            // solo run — the tournament's own punishment is applied separately.
            this.host.removeAllItems(memberNumber);
        }

        // Hand the score to the tournament manager, which decides whether the
        // match is now resolvable and announces standings.
        this.host.reportTournamentGame(memberNumber, score, durationMs);
    }

    // Applies a random eligible bondage outfit (or just its first `itemCap`
    // items, for partial bondage when a player leaves mid-run) locked for
    // `penaltyMinutes`.
    private applyPenalty(memberNumber: number, penaltyMinutes: number, itemCap?: number): void {
        const pool = this.host.getEligibleOutfits(memberNumber);
        if (pool.length === 0) return;

        const outfit = pool[Math.floor(Math.random() * pool.length)];
        const items = itemCap !== undefined ? outfit.items.slice(0, itemCap) : outfit.items;
        if (items.length === 0) return;

        const lockEndTime = Date.now() + penaltyMinutes * 60 * 1000;
        const name = this.host.getNameFor(memberNumber) ?? `#${memberNumber}`;

        items.forEach((item, i) => {
            setTimeout(() => {
                this.host.bot.applyItem(memberNumber, item.group, item.name, item.color, item.property);

                setTimeout(() => {
                    this.host.bot.applyItem(
                        memberNumber,
                        item.group,
                        item.name,
                        item.color,
                        this.host.buildLockedItemProperty(item, {
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
                this.verifyLockApplied(memberNumber, name, item, lockEndTime, penaltyMinutes, 0);
            }, verifyDelay);
        });

        // The "penalty applied" whisper waits until the full verify pass
        // (including any retries' own verify windows) has had time to land.
        const allVerificationsCompleteDelay = lastVerifyDelay + LOCK_VERIFY_DELAY_MS;
        setTimeout(() => {
            this.host.bot.whisper(memberNumber, `⛓️ Bondage penalty applied — locked for ${penaltyMinutes} minutes.`);
        }, allVerificationsCompleteDelay);
    }

    // Assembles BondageItem[] from a SoloTheme (one random item per stage) and
    // applies them with the same spaced lock+verify machinery as applyPenalty.
    private applyThemePenalty(memberNumber: number, theme: SoloTheme, penaltyMinutes: number): void {
        const items: BondageItem[] = theme.stages.map(stage => {
            const name = stage.items[Math.floor(Math.random() * stage.items.length)];
            const property = stage.typeRecord ? { TypeRecord: stage.typeRecord } : {};
            return { group: stage.group, name, color: "Default", property };
        });

        const lockEndTime = Date.now() + penaltyMinutes * 60 * 1000;
        const playerName = this.host.getNameFor(memberNumber) ?? `#${memberNumber}`;

        items.forEach((item, i) => {
            setTimeout(() => {
                this.host.bot.applyItem(memberNumber, item.group, item.name, item.color, item.property);
                setTimeout(() => {
                    this.host.bot.applyItem(
                        memberNumber, item.group, item.name, item.color,
                        this.host.buildLockedItemProperty(item, {
                            hint: `Released in ${penaltyMinutes} minutes`,
                            removeItem: true,
                            showTimer: true,
                            removeTimer: lockEndTime
                        })
                    );
                }, REMOVAL_UNLOCK_GAP_MS);
            }, i * REMOVAL_SLOT_DELAY_MS);
        });

        const phase1Done = (items.length - 1) * REMOVAL_SLOT_DELAY_MS + REMOVAL_UNLOCK_GAP_MS;
        let lastVerifyDelay = 0;
        items.forEach((item, i) => {
            const verifyDelay = phase1Done + i * REMOVAL_SLOT_DELAY_MS;
            lastVerifyDelay = verifyDelay;
            setTimeout(() => {
                this.verifyLockApplied(memberNumber, playerName, item, lockEndTime, penaltyMinutes, 0);
            }, verifyDelay);
        });

        const allVerifyDone = lastVerifyDelay + LOCK_VERIFY_DELAY_MS;
        setTimeout(() => {
            this.host.bot.whisper(memberNumber, `⛓️ ${theme.name} bondage applied — locked for ${penaltyMinutes} minutes.`);
        }, allVerifyDone);
    }

    // 50/50 roll: offer themed bondage or fall straight through to applyPenalty.
    // Called at game end (full loss only). The mid-game partial removal path always
    // uses applyPenalty directly so itemCap logic is preserved there.
    private offerThemeBondage(memberNumber: number, penaltyMinutes: number): void {
        if (Math.random() < 0.5) {
            // Outfit path — no offer, just apply immediately.
            this.applyPenalty(memberNumber, penaltyMinutes);
            return;
        }

        const theme = SOLO_THEMES[Math.floor(Math.random() * SOLO_THEMES.length)];
        const timer = setTimeout(() => {
            if (!this.pendingThemeOffer.has(memberNumber)) return;
            this.pendingThemeOffer.delete(memberNumber);
            this.host.bot.whisper(memberNumber, "No response — applying a random preset outfit.");
            this.applyPenalty(memberNumber, penaltyMinutes);
        }, SOLO_THEME_OFFER_TIMEOUT_MS);

        this.pendingThemeOffer.set(memberNumber, { theme, penaltyMinutes, timer });
        this.host.bot.whisper(memberNumber,
            `⛓️ You lost! I'm going to put you in ${theme.name} bondage. ` +
            `Say yes to accept or no for a random preset instead. (30s — !yes/!no also work)`
        );
    }

    // Re-applies one solo penalty lock item and starts its verification window.
    private applyLockItem(memberNumber: number, name: string, item: BondageItem, lockEndTime: number, penaltyMinutes: number, attempt: number): void {
        this.host.bot.applyItem(
            memberNumber,
            item.group,
            item.name,
            item.color,
            this.host.buildLockedItemProperty(item, {
                hint: `Released in ${penaltyMinutes} minutes`,
                removeItem: true,
                showTimer: true,
                removeTimer: lockEndTime
            })
        );
        this.verifyLockApplied(memberNumber, name, item, lockEndTime, penaltyMinutes, attempt);
    }

    // Same silence=success / ChatRoomSyncSingle=rejection model as
    // verifyEndGameLockApplied(), applied to solo penalty locks.
    private verifyLockApplied(memberNumber: number, name: string, item: BondageItem, lockEndTime: number, penaltyMinutes: number, attempt: number): void {
        const key = `${memberNumber}:${item.group}`;

        const existing = this.host.pendingLockApplyChecks.get(key);
        if (existing) this.host.pendingLockApplyChecks.delete(key);

        const finish = (rejected: boolean) => {
            if (!this.host.pendingLockApplyChecks.has(key)) return;
            this.host.pendingLockApplyChecks.delete(key);

            if (!rejected) {
                log(`Solo lock verification: ${name} (#${memberNumber}) ${item.group}/${item.name} confirmed (no rejection received).`);
                return;
            }

            log(`Solo lock verification: BC rejected lock for ${name} (#${memberNumber}) on ${item.group}/${item.name} (attempt ${attempt}/${MAX_END_GAME_LOCK_RETRIES}).`);

            if (attempt >= MAX_END_GAME_LOCK_RETRIES) {
                log(`SOLO LOCK VERIFY FAILED: giving up on ${name} (#${memberNumber}) ${item.group}/${item.name} after ${attempt} attempts`);
                this.host.bot.whisper(memberNumber, "⚠️ One or more locks may not have applied correctly — please check your items.");
                return;
            }

            const retry = () => this.applyLockItem(memberNumber, name, item, lockEndTime, penaltyMinutes, attempt + 1);
            if (this.host.bot.isReconnecting()) {
                log(`Reconnect in progress — delaying solo lock retry for ${name} (#${memberNumber}) ${item.group}/${item.name} until reconnected.`);
                this.host.bot.onceConnected(retry);
            } else {
                retry();
            }
        };

        this.host.pendingLockApplyChecks.set(key, { itemName: item.name, onResult: finish });
        setTimeout(() => finish(false), LOCK_VERIFY_DELAY_MS);
    }

    // Called when a player leaves the room mid-run. Discards their solo game
    // state, applying partial bondage (one item per clothing item already
    // lost) if they'd made any progress.
    public cleanupOnLeave(memberNumber: number): void {
        this.pendingSoloSetup.delete(memberNumber);
        this.pendingSoloPrizeQuestion.delete(memberNumber);
        this.pendingSoloPrizeDescription.delete(memberNumber);

        const solo = this.soloGames.get(memberNumber);
        if (!solo) return;
        this.clearInactivityTimer(solo);
        this.soloGames.delete(memberNumber);
        this.host.saveBotState();

        // A tournament game isn't scored or thrown away the instant someone
        // drops out of the room — BC disconnects are ordinary. The game is
        // parked: come back inside the grace window and it resumes exactly
        // where it was; miss the window and it's discarded with no score, and
        // has to be replayed from scratch. That keeps a disconnect from being
        // punished while still costing a rage-quitter their whole run.
        if (solo.tournamentCtx) {
            this.parkTournamentGame(memberNumber, solo, solo.tournamentCtx);
            return;
        }

        logGameEvent(`[SOLO END] mode: ${solo.mode} | bracket: ${solo.bracket} | player: ${solo.name} | outcome: abandoned`);
        this.host.storage.appendGameLog({
            type: "solo", mode: solo.mode, startTime: solo.startTime, endTime: new Date().toISOString(),
            players: [`${solo.name}(#${memberNumber})`], outcome: "abandoned",
        });

        const clothingRemoved = solo.clothingLost.length;
        if (clothingRemoved <= 0) return;

        const records = this.host.storage.loadSoloRecords();
        const bracketKey = String(solo.bracket);
        const attemptsToday = records.attempts[solo.mode][bracketKey]?.[String(memberNumber)] ?? 0;
        const penaltyMinutes = SOLO_BASE_PENALTY_MINUTES + attemptsToday * 2;

        this.applyPenalty(memberNumber, penaltyMinutes, clothingRemoved);

        if (!records.attempts[solo.mode][bracketKey]) records.attempts[solo.mode][bracketKey] = {};
        records.attempts[solo.mode][bracketKey][String(memberNumber)] = attemptsToday + 1;
        this.host.storage.saveSoloRecords(records);
    }

    // Admin command: !solo_reset [player name]. With no name, lists all
    // active solo games. With a name, discards that player's solo game with
    // no penalty (e.g. to clear a stuck/buggy run).
    public handleReset(memberNumber: number, message: string): void {
        if (!this.host.requireAdmin(memberNumber)) return;

        const requested = message.trim().slice("!solo_reset".length).trim();

        if (!requested) {
            if (this.soloGames.size === 0) {
                this.host.bot.whisper(memberNumber, "No solo games are currently active.");
                return;
            }
            const lines = [...this.soloGames.values()].map(solo => {
                const modeLabel = solo.mode === "race" ? "Race to Naked" : "Survive";
                return `${solo.name} (#${solo.memberNumber}) - ${modeLabel}, ${solo.bracket}-item bracket, ${solo.clothingLost.length}/${solo.bracket} lost, ${solo.totalRolls} rolls so far`;
            });
            this.host.sendLongWhisper(memberNumber, `=== Active Solo Games ===\n${lines.join("\n")}\nUsage: !solo_reset [player name] to reset one.`);
            return;
        }

        const target = [...this.soloGames.values()].find(s => s.name.toLowerCase().includes(requested.toLowerCase()));
        if (!target) {
            this.host.bot.whisper(memberNumber, `No active solo game found matching "${requested}".`);
            return;
        }

        this.clearInactivityTimer(target);
        this.soloGames.delete(target.memberNumber);
        this.pendingSoloSetup.delete(target.memberNumber);
        this.host.saveBotState();

        logGameEvent(`[SOLO END] mode: ${target.mode} | bracket: ${target.bracket} | player: ${target.name} | outcome: admin-reset`);
        this.host.storage.appendGameLog({
            type: "solo", mode: target.mode, startTime: target.startTime, endTime: new Date().toISOString(),
            players: [`${target.name}(#${target.memberNumber})`], outcome: "admin-reset",
        });

        this.host.bot.whisper(memberNumber, `Solo game for ${target.name} has been reset.`);
        this.host.bot.whisper(target.memberNumber, "An admin reset your solo game — !solo race or !solo survive to start a new one.");
    }

    // Asks the player if they'd like to be a prize — solo prize system design
    // is not yet decided, so we collect their vision as feedback.
    private askSoloPrizeQuestion(memberNumber: number, name: string): void {
        this.pendingSoloPrizeQuestion.set(memberNumber, name);
        this.host.bot.whisper(memberNumber,
            "🏆 Quick question: after a solo loss, would you want to be left as a prize — " +
            "bound and available for whoever in the room wants to claim you? (yes/no)"
        );
    }

    // ---- scores & leaderboards ---------------------------------------------

    private formatScoreLine(records: SoloRecordsData, mode: SoloMode, bracket: number): string {
        const bracketKey = String(bracket);
        const daily = records.daily[mode][bracketKey];
        const allTime = records.allTime[mode][bracketKey];
        const dailyStr = daily ? `${daily.name} ${daily.rolls} rolls` : "—";
        const allTimeStr = allTime ? `${allTime.name} ${allTime.rolls} rolls` : "—";
        return `${bracket} items: ${dailyStr} | ${allTimeStr}`;
    }

    public handleScores(memberNumber: number, filter?: SoloMode): void {
        const records = this.host.storage.loadSoloRecords();
        const lines: string[] = [];

        if (!filter || filter === "race") {
            lines.push("🎲 Race to Naked (daily | all-time)");
            for (let b = SOLO_BRACKET_MIN; b <= SOLO_BRACKET_MAX; b++) {
                lines.push(this.formatScoreLine(records, "race", b));
            }
        }
        if (!filter || filter === "survive") {
            lines.push("🧦 Survive (daily | all-time)");
            for (let b = SOLO_BRACKET_MIN; b <= SOLO_BRACKET_MAX; b++) {
                lines.push(this.formatScoreLine(records, "survive", b));
            }
        }
        lines.push("Type !scores me for your personal stats.");

        this.host.sendLongWhisper(memberNumber, lines.join("\n"));
    }

    public handleScoresMe(memberNumber: number): void {
        const records = this.host.storage.loadSoloRecords();
        const name = this.host.getPlayerName(memberNumber);
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
                    const penaltyMinutes = SOLO_BASE_PENALTY_MINUTES + attempts * 2;
                    lines.push(`  Attempts today: ${attempts} (next penalty if you don't beat the record: ${penaltyMinutes} min)`);
                }
            }
        }

        if (lines.length === 1) lines.push("No personal records yet — try !solo race or !solo survive!");

        this.host.sendLongWhisper(memberNumber, lines.join("\n"));
    }
}
