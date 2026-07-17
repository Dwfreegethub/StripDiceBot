// ============================================================
// SOLO GAME MODE - the whispered single-player race/survive game,
// its daily/all-time records, and the !scores displays. Owns all
// solo state; reaches shared machinery (item application, lock
// verification, storage) only through GameHost.
// ============================================================
import { log, logGameEvent } from "./logger";
import { GameHost } from "./host";
import { BondageItem, SoloGameState, SoloMode, SoloRecordEntry, SoloRecordsData } from "./types";
import {
    ClothingPath, clothingSlotsFor, LOCK_VERIFY_DELAY_MS, MAX_END_GAME_LOCK_RETRIES,
    REMOVAL_SLOT_DELAY_MS, REMOVAL_UNLOCK_GAP_MS,
    SOLO_BASE_PENALTY_MINUTES, SOLO_BONDAGE_DELAY_MS, SOLO_BRACKET_MAX, SOLO_BRACKET_MIN,
    SOLO_DEFAULT_TARGET, SOLO_DICE_MAX, SOLO_INACTIVITY_TIMEOUT_MS, SOLO_REMOVAL_REMINDER_MS,
} from "./constants";

export class SoloGameManager {
    private soloGames: Map<number, SoloGameState> = new Map();
    private pendingSoloSetup: Map<number, { mode: SoloMode; name: string; clothingPath: ClothingPath; clothingQuestionIndex: number; pendingClothing: string[] }> = new Map();
    // Players who finished a solo game and are awaiting a yes/no to the prize question.
    private pendingSoloPrizeQuestion: Map<number, string> = new Map(); // memberNumber → name
    // Players who said yes to the prize question and are now describing what it means to them.
    private pendingSoloPrizeDescription: Map<number, string> = new Map(); // memberNumber → name

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

    // Player responded yes/no to the post-game prize question.
    public handlePrizeQuestion(memberNumber: number, agreed: boolean): void {
        const name = this.pendingSoloPrizeQuestion.get(memberNumber);
        if (name === undefined) return;
        this.pendingSoloPrizeQuestion.delete(memberNumber);

        if (!agreed) {
            this.host.bot.whisper(memberNumber, "No problem! The solo prize system is something we're still designing.");
            return;
        }

        // Solo prize not yet implemented — ask them to describe their vision.
        this.pendingSoloPrizeDescription.set(memberNumber, name);
        this.host.bot.whisper(memberNumber,
            "🏆 Love the enthusiasm! The solo prize feature isn't fully built yet — but your idea will help shape it. " +
            "What would being a prize look like to you? Just whisper me a description and I'll pass it along!"
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
        this.pendingSoloSetup.set(memberNumber, { mode, name, clothingPath, clothingQuestionIndex: 0, pendingClothing: [] });
        this.host.bot.whisper(memberNumber, "Let's go through your outfit — yes or no for each item.");
        this.askClothingQuestion(memberNumber);
    }

    private askClothingQuestion(memberNumber: number): void {
        const pending = this.pendingSoloSetup.get(memberNumber)!;
        const slots = clothingSlotsFor(pending.clothingPath);
        const idx = pending.clothingQuestionIndex;

        if (idx >= slots.length) {
            const clothing = slots.filter(slot => pending.pendingClothing.includes(slot));
            if (clothing.length < SOLO_BRACKET_MIN) {
                this.host.bot.whisper(memberNumber, `You need at least ${SOLO_BRACKET_MIN} items to start — let's try again.`);
                pending.clothingQuestionIndex = 0;
                pending.pendingClothing = [];
                this.askClothingQuestion(memberNumber);
                return;
            }
            this.startGame(memberNumber, pending.mode, pending.name, clothing);
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

    private startGame(memberNumber: number, mode: SoloMode, name: string, clothing: string[]): void {
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
        this.host.saveBotState();
        logGameEvent(`[SOLO START] mode: ${solo.mode} | bracket: ${bracket} | player: ${solo.name} (#${memberNumber})`);

        this.host.bot.sendChat(`🎲 ${name} is playing a solo game — good luck!`);

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

        const records = this.host.storage.loadSoloRecords();
        const bracketKey = String(solo.bracket);
        const modeLabel = solo.mode === "race" ? "Race to Naked" : "Survive";
        const dailyRecord = records.daily[solo.mode][bracketKey];
        const allTimeRecord = records.allTime[solo.mode][bracketKey];
        const score = solo.totalRolls;
        const endTime = new Date().toISOString();
        const players = [`${solo.name}(#${memberNumber})`];

        this.host.bot.whisper(memberNumber, `🎉 You're naked! Final score: ${score} roll${score === 1 ? "" : "s"}.`);
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
        const penaltyMinutes = SOLO_BASE_PENALTY_MINUTES + attemptsToday;
        setTimeout(() => {
            this.applyPenalty(memberNumber, penaltyMinutes);
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
        const penaltyMinutes = SOLO_BASE_PENALTY_MINUTES + attemptsToday;

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
            "🏆 Quick question: would you be interested in being a \"prize\" after your solo game — " +
            "available for anyone in the room to claim? (yes/no)"
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
                    const penaltyMinutes = SOLO_BASE_PENALTY_MINUTES + attempts;
                    lines.push(`  Attempts today: ${attempts} (next penalty if you don't beat the record: ${penaltyMinutes} min)`);
                }
            }
        }

        if (lines.length === 1) lines.push("No personal records yet — try !solo race or !solo survive!");

        this.host.sendLongWhisper(memberNumber, lines.join("\n"));
    }
}
