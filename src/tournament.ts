// ============================================================
// TOURNAMENT MANAGER - owns tournament.json, the !tournament
// command surface, the admin setup interview, and registration.
//
// Bracket maths lives in tournamentLogic.ts (pure, simulated by
// tournamentSim.ts). This file is the stateful, BC-facing half:
// persistence, messaging, and the command handlers. Anything it
// needs from the game goes through GameHost — never import game.ts.
// ============================================================
import { log, logError, logGameEvent } from "./logger";
import { GameHost } from "./host";
import {
    TournamentConfig, TournamentGameContext, TournamentMatch, TournamentPlayer, TournamentState,
} from "./types";
import {
    activePlayers, applyResult, evaluateField, findPlayer, isActive, matchFor,
    pairRound, punishRemaining, punishmentForLoss, rankPlayers, recordPairing, resolveMatch,
} from "./tournamentLogic";
import { formatDuration, formatLocalTime, generatePassword, parseDuration, parseWhen } from "./util";
import {
    TOURNAMENT_DEFAULT_CLOTHING, TOURNAMENT_DEFAULT_GAMES_PER_MATCH,
    TOURNAMENT_DEFAULT_GRACE_ROUNDS, TOURNAMENT_DEFAULT_MIN_PLAYERS,
    TOURNAMENT_ENTRY_STATUS_COOLDOWN_MS, TOURNAMENT_FRIEND_WAIT_MS, TOURNAMENT_RESUME_GRACE_MS,
    TOURNAMENT_SERVE_PROMPT_MS,
    TOURNAMENT_NEXT_GAME_PROMPT_MS, TOURNAMENT_SETUP_TIMEOUT_MS, TOURNAMENT_TICK_MS,
} from "./constants";

// One question in the admin setup interview. `apply` stores the parsed answer;
// returning a string instead means "rejected, show this and ask again".
interface SetupStep {
    key: string;
    prompt: string;
    apply: (draft: Partial<TournamentConfig>, answer: string, now: number) => string | null;
}

const SETUP_STEPS: SetupStep[] = [
    {
        key: "registrationOpensAt",
        prompt: "1/8 — When does registration open?\nAnswer with `now`, a delay like `3 days`, or a date like `2026-08-10`.",
        apply: (draft, answer, now) => {
            const when = parseWhen(answer, now);
            if (when === null) return "I couldn't read that as a time.";
            draft.registrationOpensAt = new Date(when).toISOString();
            return null;
        },
    },
    {
        key: "signUpLength",
        prompt: "2/8 — How long is the sign-up window?\ne.g. `1 week`, `2 days`, `2 hours` (short values are fine for a test run).",
        apply: (draft, answer, _now) => {
            const length = parseDuration(answer);
            if (length === null) return "I couldn't read that as a length of time.";
            const opens = Date.parse(draft.registrationOpensAt!);
            draft.signUpDeadline = new Date(opens + length).toISOString();
            return null;
        },
    },
    {
        key: "firstRoundStart",
        prompt: "3/8 — When does Round 1 begin?\n`now`, a delay like `1 hour`, or a date. It can't be before sign-ups close.",
        apply: (draft, answer, now) => {
            const when = parseWhen(answer, now);
            if (when === null) return "I couldn't read that as a time.";
            const deadline = Date.parse(draft.signUpDeadline!);
            if (when < deadline) {
                return `That's before sign-ups close (${formatLocalTime(new Date(deadline).toISOString())}).`;
            }
            draft.firstRoundStart = new Date(when).toISOString();
            return null;
        },
    },
    {
        key: "roundLength",
        prompt: "4/8 — How long is each round?\ne.g. `48 hours`, `3 days`, or `1 hour` for testing.",
        apply: (draft, answer) => {
            const length = parseDuration(answer);
            if (length === null) return "I couldn't read that as a length of time.";
            draft.roundLengthMs = length;
            return null;
        },
    },
    {
        key: "firstLossPunish",
        prompt: "5/8 — How long bound and claimable for a FIRST loss?\ne.g. `15 minutes`, or `0` for none.",
        apply: (draft, answer) => {
            if (answer.trim() === "0" || answer.trim().toLowerCase() === "none") {
                draft.firstLossPunishMs = 0;
                return null;
            }
            const length = parseDuration(answer);
            if (length === null) return "I couldn't read that as a length of time.";
            draft.firstLossPunishMs = length;
            return null;
        },
    },
    {
        key: "eliminationPunish",
        prompt: "6/8 — How long bound and claimable when ELIMINATED (2nd loss)?\ne.g. `1 hour`, or `0` for none.",
        apply: (draft, answer) => {
            if (answer.trim() === "0" || answer.trim().toLowerCase() === "none") {
                draft.eliminationPunishMs = 0;
                return null;
            }
            const length = parseDuration(answer);
            if (length === null) return "I couldn't read that as a length of time.";
            draft.eliminationPunishMs = length;
            return null;
        },
    },
    {
        key: "graceRounds",
        prompt: "7/8 — How many opening rounds are grace rounds (losing costs nothing)?\n" +
            "`1` is the usual answer. `0` means punishment applies from Round 1.",
        apply: (draft, answer) => {
            const n = parseInt(answer.trim(), 10);
            if (isNaN(n) || n < 0) return "Please answer with a whole number (0 or more).";
            draft.graceRounds = n;
            return null;
        },
    },
    {
        key: "allowsWithdrawal",
        prompt: "8/8 — Can players withdraw between rounds? (yes / no)",
        apply: (draft, answer) => {
            const a = answer.trim().toLowerCase();
            if (a === "yes" || a === "y") { draft.allowsWithdrawal = true; return null; }
            if (a === "no" || a === "n") { draft.allowsWithdrawal = false; return null; }
            return "Please answer yes or no.";
        },
    },
];

export class TournamentManager {
    private state: TournamentState | null = null;

    // Players who ran !tournament register but aren't mutually friended yet.
    // Registration finishes the moment the friend link completes (see
    // onFriendAdded). In-memory only: if the bot restarts mid-handshake they
    // simply run !tournament register again.
    private pendingFriendRegistration: Map<number, { name: string; timeout: NodeJS.Timeout }> = new Map();

    // Players asked "ready to serve?" on entering the room, awaiting a yes/no.
    private pendingServePrompt: Map<number, NodeJS.Timeout> = new Map();

    // Players asked "ready for your next game?" after finishing one, awaiting
    // a yes/no. In-memory: missing it just means using !tournament play.
    private pendingNextGamePrompt: Map<number, NodeJS.Timeout> = new Map();

    // When each player was last sent their round status on entering the room,
    // so someone whose connection is flapping doesn't get whispered every time.
    // In-memory only — a restart just means one extra status whisper.
    private lastStatusOnEntry: Map<number, number> = new Map();

    // Admin partway through !tournament setup. Only one at a time.
    private setup: {
        adminMemberNumber: number;
        stepIndex: number;
        draft: Partial<TournamentConfig>;
        awaitingConfirm: boolean;
        timeout: NodeJS.Timeout;
    } | null = null;

    constructor(private readonly host: GameHost) {
        this.state = host.storage.loadTournament();
        if (this.state) {
            log(`Tournament loaded: status=${this.state.status}, round=${this.state.currentRound}, players=${this.state.players.length}`);
        }

        // Advancement used to happen ONLY on room activity — a member joining
        // or a tournament game ending. With everyone already sitting in the
        // room and nobody coming or going, a deadline could pass and nothing
        // would fire, including the very first "start Round 1" transition.
        // A plain timer makes the schedule actually time-driven; checkSchedule
        // returns immediately when there's nothing to do, so the cost is nil.
        setInterval(() => {
            try {
                this.checkSchedule();
            } catch (err) {
                logError(`Tournament tick failed: ${err}`);
            }
        }, TOURNAMENT_TICK_MS);
    }

    // ---- queries used by game.ts dispatch ---------------------------------

    public isSettingUp(memberNumber: number): boolean {
        return this.setup?.adminMemberNumber === memberNumber;
    }

    public hasTournament(): boolean {
        return this.state !== null && this.state.status !== "cancelled" && this.state.status !== "complete";
    }

    // Punishment time a player still owes. Drives the BD lockout, so it is
    // safe to call for anyone, tournament participant or not.
    public punishMsFor(memberNumber: number, now: number = Date.now()): number {
        const player = this.state ? findPlayer(this.state, memberNumber) : undefined;
        return player ? punishRemaining(player, now) : 0;
    }

    private save(): void {
        if (this.state) this.host.storage.saveTournament(this.state);
    }

    // ---- messaging --------------------------------------------------------

    // Whisper if they're in the room, otherwise beep. Both are best-effort:
    // whispers need presence, beeps need them to be online AND mutually
    // friended. Nothing may depend on either landing — every notification is
    // recoverable with !tournament, and re-sent when they next enter the room.
    private notify(memberNumber: number, text: string): void {
        if (this.host.isInRoom(memberNumber)) {
            this.host.sendLongWhisper(memberNumber, text);
            return;
        }
        if (this.host.bot.isFriend(memberNumber)) {
            this.host.bot.beep(memberNumber, text.split("\n")[0]);
        }
    }

    private notifyAll(text: string, filter?: (p: TournamentPlayer) => boolean): void {
        if (!this.state) return;
        for (const player of this.state.players) {
            if (filter && !filter(player)) continue;
            this.notify(player.memberNumber, text);
        }
    }

    // ---- setup interview ---------------------------------------------------

    public handleSetup(memberNumber: number): void {
        if (!this.host.requireAdmin(memberNumber)) return;

        if (this.hasTournament()) {
            this.host.bot.whisper(memberNumber,
                `A tournament already exists (status: ${this.state!.status}). ` +
                `Use !tournament cancel first if you want to replace it.`);
            return;
        }
        if (this.setup) {
            this.host.bot.whisper(memberNumber, "A tournament setup is already in progress.");
            return;
        }

        this.setup = {
            adminMemberNumber: memberNumber,
            stepIndex: 0,
            draft: {},
            awaitingConfirm: false,
            timeout: this.newSetupTimeout(memberNumber),
        };

        this.host.sendLongWhisper(memberNumber,
            "🏆 Tournament setup — I'll ask 7 questions. Whisper `cancel` at any point to stop.\n" +
            "Durations accept things like `90 minutes`, `1 hour`, `48 hours`, `3 days`, `1 week` " +
            "(a bare number means minutes).\n\n" +
            SETUP_STEPS[0].prompt);
    }

    private newSetupTimeout(memberNumber: number): NodeJS.Timeout {
        return setTimeout(() => {
            this.setup = null;
            this.host.bot.whisper(memberNumber, "Tournament setup timed out — nothing was created.");
        }, TOURNAMENT_SETUP_TIMEOUT_MS);
    }

    private refreshSetupTimeout(): void {
        if (!this.setup) return;
        clearTimeout(this.setup.timeout);
        this.setup.timeout = this.newSetupTimeout(this.setup.adminMemberNumber);
    }

    // Consumes a whisper as a setup answer. Returns true if it was consumed.
    public handleSetupAnswer(memberNumber: number, message: string): boolean {
        if (!this.setup || this.setup.adminMemberNumber !== memberNumber) return false;

        const answer = message.trim();
        if (answer.toLowerCase() === "cancel") {
            clearTimeout(this.setup.timeout);
            this.setup = null;
            this.host.bot.whisper(memberNumber, "Tournament setup cancelled — nothing was created.");
            return true;
        }

        this.refreshSetupTimeout();

        if (this.setup.awaitingConfirm) {
            const a = answer.toLowerCase();
            if (a === "yes" || a === "y") {
                this.createFromDraft(memberNumber);
                return true;
            }
            if (a === "no" || a === "n") {
                clearTimeout(this.setup.timeout);
                this.setup = null;
                this.host.bot.whisper(memberNumber, "Discarded — no tournament created. Run !tournament setup to start over.");
                return true;
            }
            this.host.bot.whisper(memberNumber, "Please answer yes or no.");
            return true;
        }

        const step = SETUP_STEPS[this.setup.stepIndex];
        const error = step.apply(this.setup.draft, answer, Date.now());
        if (error) {
            this.host.bot.whisper(memberNumber, `${error}\n\n${step.prompt}`);
            return true;
        }

        this.setup.stepIndex++;
        if (this.setup.stepIndex < SETUP_STEPS.length) {
            this.host.sendLongWhisper(memberNumber, SETUP_STEPS[this.setup.stepIndex].prompt);
            return true;
        }

        this.setup.awaitingConfirm = true;
        this.host.sendLongWhisper(memberNumber, this.summariseDraft(this.setup.draft) + "\n\nCreate this tournament? (yes / no)");
        return true;
    }

    private summariseDraft(draft: Partial<TournamentConfig>): string {
        const when = (iso?: string) => iso ? formatLocalTime(iso) : "—";
        const punish = (ms?: number) => (ms && ms > 0) ? formatDuration(ms) : "none";
        return "🏆 Tournament summary\n" +
            `Registration opens: ${when(draft.registrationOpensAt)}\n` +
            `Sign-ups close: ${when(draft.signUpDeadline)}\n` +
            `Round 1 begins: ${when(draft.firstRoundStart)}\n` +
            `Round length: ${formatDuration(draft.roundLengthMs ?? 0)}\n` +
            `First loss: ${punish(draft.firstLossPunishMs)} bound & claimable\n` +
            `Elimination: ${punish(draft.eliminationPunishMs)} bound & claimable\n` +
            `Grace rounds: ${draft.graceRounds === 0 ? "none — punishment from Round 1" : `${draft.graceRounds} (no punishment)`}\n` +
            `Withdrawals: ${draft.allowsWithdrawal ? "allowed between rounds" : "not allowed"}\n` +
            `Format: best of ${TOURNAMENT_DEFAULT_GAMES_PER_MATCH} Survive games, ` +
            `${TOURNAMENT_DEFAULT_CLOTHING} clothing items\n` +
            `Target field: ${TOURNAMENT_DEFAULT_MIN_PLAYERS} players (advisory — a smaller field still runs)`;
    }

    private createFromDraft(adminMemberNumber: number): void {
        if (!this.setup) return;
        const draft = this.setup.draft;
        clearTimeout(this.setup.timeout);
        this.setup = null;

        const config: TournamentConfig = {
            registrationOpensAt: draft.registrationOpensAt!,
            signUpDeadline: draft.signUpDeadline!,
            firstRoundStart: draft.firstRoundStart!,
            roundLengthMs: draft.roundLengthMs!,
            gamesPerMatch: TOURNAMENT_DEFAULT_GAMES_PER_MATCH,
            clothingCount: TOURNAMENT_DEFAULT_CLOTHING,
            // Advisory only: below this the bot warns but still runs, so a
            // two-player rehearsal works without special-casing anything.
            minPlayers: TOURNAMENT_DEFAULT_MIN_PLAYERS,
            graceRounds: draft.graceRounds!,
            firstLossPunishMs: draft.firstLossPunishMs!,
            eliminationPunishMs: draft.eliminationPunishMs!,
            allowsWithdrawal: draft.allowsWithdrawal!,
        };

        this.state = {
            status: "registration",
            createdBy: adminMemberNumber,
            config,
            currentRound: 0,
            roundDeadline: null,
            players: [],
            matches: [],
            champion: null,
            runnerUp: null,
            frozenReason: null,
        };
        this.save();

        logGameEvent(`[TOURNAMENT] created by #${adminMemberNumber}: ` +
            `reg ${config.registrationOpensAt} → ${config.signUpDeadline}, ` +
            `round1 ${config.firstRoundStart}, round ${formatDuration(config.roundLengthMs)}`);

        this.host.bot.whisper(adminMemberNumber, "🏆 Tournament created. Registration details announced to the room.");
        this.announceRegistrationOpen();
    }

    private announceRegistrationOpen(): void {
        if (!this.state) return;
        const opens = Date.parse(this.state.config.registrationOpensAt);
        const closes = Date.parse(this.state.config.signUpDeadline);
        const now = Date.now();

        if (now < opens) {
            this.host.bot.sendChat(
                `🏆 A StripDice Solo Tournament is coming! Registration opens in ${formatDuration(opens - now)}. ` +
                `Whisper !tournament for details.`);
            return;
        }

        this.host.bot.sendChat(
            `🏆 StripDice Solo Tournament — registration is OPEN! Whisper !tournament register to sign up. ` +
            `Sign-ups close in ${formatDuration(Math.max(0, closes - now))}. Whisper !tournament rules for how it works.`);
    }

    // ---- registration -------------------------------------------------------

    public handleRegister(memberNumber: number, name: string): void {
        if (!this.state) {
            this.host.bot.whisper(memberNumber, "There's no tournament right now. I'll announce it in the room when one is set up.");
            return;
        }

        const now = Date.now();
        const opens = Date.parse(this.state.config.registrationOpensAt);
        const closes = Date.parse(this.state.config.signUpDeadline);

        if (now < opens) {
            this.host.bot.whisper(memberNumber,
                `Registration hasn't opened yet — it opens in ${formatDuration(opens - now)}.`);
            return;
        }
        if (this.state.status !== "registration" || now > closes) {
            this.host.bot.whisper(memberNumber, "Registration for this tournament has closed.");
            return;
        }
        if (findPlayer(this.state, memberNumber)) {
            this.host.bot.whisper(memberNumber,
                `You're already registered! ${this.state.players.length} player(s) signed up so far. ` +
                `Whisper !tournament any time for status.`);
            return;
        }

        // Friending is required, not just encouraged: rounds run for hours or
        // days and a player who can't be beeped will simply miss theirs. BC's
        // friend list is mutual, so the bot cannot do this unilaterally — the
        // player adds the bot, BC sends a hidden ChatRoomFriendRequestAdd,
        // the bot adds back, and onFriendAdded() finishes the registration.
        if (!this.host.bot.isFriend(memberNumber)) {
            const existing = this.pendingFriendRegistration.get(memberNumber);
            if (existing) clearTimeout(existing.timeout);

            const timeout = setTimeout(() => {
                this.pendingFriendRegistration.delete(memberNumber);
                this.host.bot.whisper(memberNumber,
                    "Your tournament registration timed out waiting for the friend request. " +
                    "Whisper !tournament register again whenever you're ready.");
            }, TOURNAMENT_FRIEND_WAIT_MS);

            this.pendingFriendRegistration.set(memberNumber, { name, timeout });
            this.host.sendLongWhisper(memberNumber,
                "🏆 Almost there — one step first.\n" +
                "Tournament rounds run over hours or days, so I need to be able to reach you when " +
                "your round starts. That needs us to be friends in BC (it only works both ways).\n\n" +
                "Add me from your friend list now — I'll add you back automatically and finish your " +
                "registration straight away. If your client doesn't send it, whisper !friend instead.\n" +
                `I'll wait ${formatDuration(TOURNAMENT_FRIEND_WAIT_MS)}.`);
            return;
        }

        this.completeRegistration(memberNumber, name);
    }

    // Called by game.ts when a friend link completes (either the player added
    // the bot and it added back, or they used !friend). Finishes any
    // registration that was waiting on it.
    public onFriendAdded(memberNumber: number, name: string): void {
        const pending = this.pendingFriendRegistration.get(memberNumber);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingFriendRegistration.delete(memberNumber);

        if (!this.state || this.state.status !== "registration") {
            this.host.bot.whisper(memberNumber,
                "Thanks for the friend request! Registration has closed since you started, so I couldn't sign you up.");
            return;
        }
        if (findPlayer(this.state, memberNumber)) return;

        this.host.bot.whisper(memberNumber, "✅ Friends — finishing your tournament registration now.");
        this.completeRegistration(memberNumber, pending.name || name);
    }

    private completeRegistration(memberNumber: number, name: string): void {
        if (!this.state) return;
        const closes = Date.parse(this.state.config.signUpDeadline);
        const now = Date.now();

        this.state.players.push({
            memberNumber,
            name,
            wins: 0, losses: 0, byesUsed: 0,
            eliminated: false, withdrew: false,
            opponents: [],
            punishMsRemaining: 0,
            serving: false,
            servingSince: null,
            disconnectedAt: null,
            lockPassword: null,
            claimedBy: null,
            claimedByName: null,
        });
        this.save();
        logGameEvent(`[TOURNAMENT] ${name} (#${memberNumber}) registered (${this.state.players.length} total)`);

        this.host.sendLongWhisper(memberNumber,
            `🏆 You're registered for the tournament! (${this.state.players.length} signed up)\n` +
            `Sign-ups close in ${formatDuration(Math.max(0, closes - now))}, and Round 1 begins ` +
            `${formatLocalTime(this.state.config.firstRoundStart)}.\n` +
            `We're friends, so I'll beep you when your round starts — though beeps only reach you if ` +
            `you're online, so check !tournament if you've been away.\n` +
            `Whisper !tournament rules for the full format, or !tournament any time for status.`);

        this.host.bot.sendChat(`🏆 ${name} has registered for the tournament! (${this.state.players.length} signed up)`);
    }

    public handleWithdraw(memberNumber: number): void {
        if (!this.state || !this.hasTournament()) {
            this.host.bot.whisper(memberNumber, "There's no tournament running.");
            return;
        }
        const player = findPlayer(this.state, memberNumber);
        if (!player) {
            this.host.bot.whisper(memberNumber, "You're not registered for this tournament.");
            return;
        }
        if (player.withdrew) {
            this.host.bot.whisper(memberNumber, "You've already withdrawn.");
            return;
        }

        // Before round 1 it's just un-registering — no record, no penalty.
        if (this.state.status === "registration") {
            this.state.players = this.state.players.filter(p => p.memberNumber !== memberNumber);
            this.save();
            this.host.bot.whisper(memberNumber, "You've been removed from the tournament. Whisper !tournament register to sign up again.");
            return;
        }

        if (!this.state.config.allowsWithdrawal) {
            this.host.bot.whisper(memberNumber, "This tournament doesn't allow withdrawals once it's underway.");
            return;
        }

        const match = matchFor(this.state, memberNumber, this.state.currentRound);
        const played = match
            ? (match.playerA === memberNumber ? match.gamesA.length : match.gamesB.length)
            : 0;
        if (match && played > 0 && match.result === null) {
            this.host.bot.whisper(memberNumber,
                "You've already started this round's match — you can withdraw once the round finishes.");
            return;
        }

        player.withdrew = true;
        this.save();
        logGameEvent(`[TOURNAMENT] ${player.name} (#${memberNumber}) withdrew in round ${this.state.currentRound}`);
        this.host.bot.whisper(memberNumber, "You've withdrawn from the tournament. Any punishment time you already owe still stands.");
        this.host.bot.sendChat(`🏆 ${player.name} has withdrawn from the tournament.`);
    }

    // ---- scheduling ---------------------------------------------------------

    // Called on room activity (joins, game ends) rather than from a timer:
    // there is no external scheduler, so the tournament advances whenever
    // something happens. A dead-quiet room means rounds sit until someone
    // shows up, which is fine — nobody is waiting on them in an empty room.
    public checkSchedule(now: number = Date.now()): void {
        if (!this.state) return;
        // Sentences complete on their own schedule, independent of whether the
        // tournament itself is paused — nobody stays bound because an admin
        // froze the bracket.
        this.checkServingCompletions(now);
        if (this.state.status === "paused" || this.state.status === "frozen") return;

        if (this.state.status === "registration") {
            const closes = Date.parse(this.state.config.signUpDeadline);
            const starts = Date.parse(this.state.config.firstRoundStart);
            if (now >= closes && now >= starts) this.beginTournament(now);
            return;
        }

        if (this.state.status !== "active" || !this.state.roundDeadline) return;
        if (now >= Date.parse(this.state.roundDeadline)) this.finalizeRound(now);
    }

    private beginTournament(now: number): void {
        if (!this.state) return;

        const field = this.state.players.length;
        if (field < 2) {
            this.state.status = "cancelled";
            this.save();
            this.host.bot.sendChat(
                `🏆 The tournament has been called off — only ${field} player${field === 1 ? "" : "s"} registered.`);
            logGameEvent(`[TOURNAMENT] auto-cancelled: only ${field} registered`);
            return;
        }

        // minPlayers is advisory: a short field still runs (so a rehearsal
        // with 2-3 people works), it just gets called out.
        if (field < this.state.config.minPlayers) {
            this.host.bot.sendChat(
                `🏆 Starting with ${field} players (below the usual ${this.state.config.minPlayers}) — let's go anyway!`);
        }

        this.state.status = "active";
        this.save();
        this.startRound(1, now);
    }

    private startRound(round: number, now: number): void {
        if (!this.state) return;

        const matches = pairRound(this.state, round);
        if (matches.length === 0) {
            this.freeze("no matches could be paired for the next round");
            return;
        }

        for (const match of matches) {
            recordPairing(this.state, match);
            this.state.matches.push(match);
            // A bye resolves the moment it's created — there's nothing to play.
            if (match.playerB === null) {
                const result = resolveMatch(match, this.state.config.gamesPerMatch, true)!;
                match.result = result;
                const player = findPlayer(this.state, match.playerA);
                if (player) player.byesUsed++;
                applyResult(this.state, match, result);
            }
        }

        this.state.currentRound = round;
        this.state.roundDeadline = new Date(now + this.state.config.roundLengthMs).toISOString();
        this.save();

        const graceNote = round <= this.state.config.graceRounds
            ? " This is a grace round — losing costs nothing."
            : "";
        this.host.bot.sendChat(
            `🏆 Tournament Round ${round} begins! ${formatDuration(this.state.config.roundLengthMs)} to play ` +
            `your ${this.state.config.gamesPerMatch} games. Whisper !tournament play to start.${graceNote}`);

        logGameEvent(`[TOURNAMENT] round ${round} started with ${matches.length} match(es), ` +
            `deadline ${this.state.roundDeadline}`);

        for (const match of matches) {
            if (match.playerB === null) {
                this.notify(match.playerA,
                    `🎟️ Round ${round}: you have a BYE — an automatic win, nothing to play.`);
                continue;
            }
            const aName = this.nameOf(match.playerA);
            const bName = this.nameOf(match.playerB);
            this.notify(match.playerA,
                `🏆 Round ${round}: you're up against ${bName}. ` +
                `Whisper !tournament play to start game 1 of ${this.state.config.gamesPerMatch}.`);
            this.notify(match.playerB,
                `🏆 Round ${round}: you're up against ${aName}. ` +
                `Whisper !tournament play to start game 1 of ${this.state.config.gamesPerMatch}.`);
        }
    }

    // Round deadline passed: force-resolve everything outstanding (unplayed
    // games score as losses), apply punishment, then advance or finish.
    private finalizeRound(now: number): void {
        if (!this.state) return;
        const round = this.state.currentRound;

        for (const match of this.state.matches.filter(m => m.round === round && m.result === null)) {
            const result = resolveMatch(match, this.state.config.gamesPerMatch, true);
            if (!result) {
                // Dead heat on points, rolls AND time — no rule can call it.
                this.freeze(`match ${match.id} is tied on every tiebreaker and needs a ruling`);
                return;
            }
            match.result = result;
            const eliminated = applyResult(this.state, match, result);

            const winnerName = result.winner !== null ? this.nameOf(result.winner) : null;
            const loserName = result.loser !== null ? this.nameOf(result.loser) : null;
            this.host.storage.appendTournamentLog(
                `[${new Date(now).toISOString()}] round ${round} ${match.id} RESOLVED-AT-DEADLINE ` +
                `winner=${winnerName ?? "none"} loser=${loserName ?? "none"} by=${result.decidedBy}`);

            if (result.decidedBy === "double-forfeit") {
                this.host.bot.sendChat(`🏆 Round ${round}: neither ${this.nameOf(match.playerA)} nor ` +
                    `${this.nameOf(match.playerB!)} played — both take a loss.`);
            } else if (winnerName && loserName) {
                this.host.bot.sendChat(`🏆 Round ${round}: ${winnerName} beats ${loserName} (time ran out).`);
            }
            for (const mn of eliminated) {
                this.host.bot.sendChat(`🏆 ${this.nameOf(mn)} has been eliminated from the tournament.`);
            }
        }

        this.applyRoundPunishments(round);
        this.save();

        const field = evaluateField(this.state);
        switch (field.kind) {
            case "decided":
                this.completeTournament(field.champion, field.runnerUp);
                return;
            case "empty":
                // Everyone left standing forfeited — no champion to crown, and
                // no rule DW wants applied automatically. Freeze for a ruling.
                this.freeze("the last active players all forfeited, so there's no winner to declare");
                return;
            case "final":
                this.host.bot.sendChat(
                    `🏆 Down to two — ${this.nameOf(field.players[0])} vs ${this.nameOf(field.players[1])} in the GRAND FINAL!`);
                this.startRound(round + 1, now);
                return;
            default:
                this.startRound(round + 1, now);
        }
    }

    // Credits punishment time for losses taken this round. Actually binding
    // the player (bondage + claimable) happens when they next present
    // themselves to serve it — see the serving commands.
    private applyRoundPunishments(round: number): void {
        if (!this.state) return;
        if (round <= this.state.config.graceRounds) return;

        for (const match of this.state.matches.filter(m => m.round === round)) {
            const losers: number[] = [];
            if (match.result?.decidedBy === "double-forfeit") {
                losers.push(match.playerA);
                if (match.playerB !== null) losers.push(match.playerB);
            } else if (match.result?.loser != null) {
                losers.push(match.result.loser);
            }

            for (const mn of losers) {
                const player = findPlayer(this.state, mn);
                if (!player) continue;
                const ms = punishmentForLoss(this.state, player.losses, round);
                if (ms <= 0) continue;
                player.punishMsRemaining += ms;

                const owed = `⛓️ That loss costs you ${formatDuration(ms)} bound and claimable in the room. ` +
                    `You owe ${formatDuration(player.punishMsRemaining)} in total, and you can't play ` +
                    `your next match until it's served.`;

                // In the room: tell them and immediately offer to start, so
                // there's no gap where they know they owe time but not how to
                // begin. Away: beep the result and set expectations, since a
                // beep is all we can reach them with and they'll be prompted
                // properly by onEnterRoom when they next walk in.
                if (this.host.isInRoom(mn)) {
                    this.host.sendLongWhisper(mn, owed);
                    this.promptToServe(mn, player);
                } else if (this.host.bot.isFriend(mn)) {
                    this.host.bot.beep(mn,
                        `Tournament: you lost your Round ${round} match and owe ` +
                        `${formatDuration(player.punishMsRemaining)} bound and claimable. ` +
                        `Come to the room and I'll ask if you're ready to serve it.`);
                }
            }
        }
    }

    private completeTournament(champion: number, runnerUp: number | null): void {
        if (!this.state) return;
        this.state.status = "complete";
        this.state.champion = champion;
        this.state.runnerUp = runnerUp;

        // Champion and runner-up walk away free, whatever they'd racked up.
        for (const mn of [champion, runnerUp]) {
            if (mn === null) continue;
            const player = findPlayer(this.state, mn);
            if (player) {
                player.punishMsRemaining = 0;
                player.serving = false;
                player.servingSince = null;
            }
        }
        this.save();

        logGameEvent(`[TOURNAMENT] complete — champion #${champion}, runner-up ${runnerUp ?? "none"}`);
        this.host.bot.sendChat(
            `🏆🏆 The tournament is over — ${this.nameOf(champion)} is the CHAMPION! ` +
            `${runnerUp !== null ? `${this.nameOf(runnerUp)} takes runner-up. ` : ""}` +
            `Both walk away with no punishment time. Congratulations!`);
        this.notify(champion, "🏆 You won the tournament! Champion — and no punishment time at all. Congratulations!");
        if (runnerUp !== null) this.notify(runnerUp, "🏆 Runner-up! A great run — and you walk away free too.");
    }

    // ---- playing -----------------------------------------------------------

    public handlePlay(memberNumber: number, name: string): void {
        if (!this.state) {
            this.host.bot.whisper(memberNumber, "There's no tournament running.");
            return;
        }
        if (this.state.status === "registration") {
            this.host.bot.whisper(memberNumber,
                `The tournament hasn't started yet — Round 1 begins ${formatLocalTime(this.state.config.firstRoundStart)}.`);
            return;
        }
        if (this.state.status === "paused" || this.state.status === "frozen") {
            this.host.bot.whisper(memberNumber, `The tournament is ${this.state.status} right now — hold tight.`);
            return;
        }
        if (this.state.status !== "active") {
            this.host.bot.whisper(memberNumber, "This tournament isn't running.");
            return;
        }

        const player = findPlayer(this.state, memberNumber);
        if (!player) {
            this.host.bot.whisper(memberNumber, "You're not registered for this tournament.");
            return;
        }
        if (player.withdrew) {
            this.host.bot.whisper(memberNumber, "You've withdrawn from this tournament.");
            return;
        }
        if (player.eliminated) {
            this.host.bot.whisper(memberNumber, `You were eliminated with ${player.wins}W/${player.losses}L — no more games to play.`);
            return;
        }

        // Owing punishment time blocks play. This is the whole point of the
        // "serve it before your next match" rule.
        const owed = punishRemaining(player, Date.now());
        if (owed > 0) {
            this.host.bot.whisper(memberNumber,
                `⛓️ You still owe ${formatDuration(owed)} bound & claimable before you can play again.`);
            return;
        }

        const match = matchFor(this.state, memberNumber, this.state.currentRound);
        if (!match) {
            this.host.bot.whisper(memberNumber, "You don't have a match this round.");
            return;
        }
        if (match.playerB === null) {
            this.host.bot.whisper(memberNumber, "🎟️ You have a bye this round — no games to play. Enjoy the free win!");
            return;
        }
        if (match.result !== null) {
            this.host.bot.whisper(memberNumber, "Your match this round is already decided.");
            return;
        }

        const isA = match.playerA === memberNumber;
        const mine = isA ? match.gamesA : match.gamesB;
        const total = this.state.config.gamesPerMatch;
        if (mine.length >= total) {
            this.host.bot.whisper(memberNumber,
                `You've already played all ${total} of your games this round. Waiting on your opponent / the round to close.`);
            return;
        }

        const opponent = isA ? match.playerB : match.playerA;
        const ctx: TournamentGameContext = {
            round: this.state.currentRound,
            matchId: match.id,
            opponentName: this.nameOf(opponent),
            gameNumber: mine.length + 1,
            totalGames: total,
            requiredClothing: this.state.config.clothingCount,
            allowBondage: false,
        };

        const error = this.host.startTournamentGame(memberNumber, name, ctx);
        if (error) this.host.bot.whisper(memberNumber, error);
    }

    // Called (via GameHost) when a tournament game finishes. Records the score,
    // resolves the match if both players are done, and keeps the room posted.
    public recordGameResult(memberNumber: number, score: number, durationMs: number): void {
        if (!this.state) return;
        const player = findPlayer(this.state, memberNumber);
        if (!player) return;

        const match = matchFor(this.state, memberNumber, this.state.currentRound);
        if (!match || match.result !== null || match.playerB === null) return;

        const isA = match.playerA === memberNumber;
        const mine = isA ? match.gamesA : match.gamesB;
        const total = this.state.config.gamesPerMatch;
        if (mine.length >= total) return; // already complete; ignore a stray report

        mine.push({ score, durationMs, playedAt: new Date().toISOString() });
        this.save();

        this.host.storage.appendTournamentLog(
            `[${new Date().toISOString()}] round ${this.state.currentRound} ${match.id} ` +
            `${player.name}(#${memberNumber}) game ${mine.length}/${total} score=${score} durationMs=${durationMs}`);

        const opponent = isA ? match.playerB : match.playerA;
        const theirs = isA ? match.gamesB : match.gamesA;
        const played = mine.length;

        // Room commentary: where they stand, without leaking anything the
        // opponent hasn't already earned by playing.
        const mineTotal = mine.reduce((s, g) => s + g.score, 0);
        const theirTotal = theirs.reduce((s, g) => s + g.score, 0);
        let standing = "";
        if (theirs.length > 0) {
            standing = mineTotal > theirTotal
                ? ` They're ahead of ${this.nameOf(opponent)} on total rolls (${mineTotal} vs ${theirTotal}).`
                : mineTotal < theirTotal
                ? ` ${this.nameOf(opponent)} still leads on total rolls (${theirTotal} vs ${mineTotal}).`
                : ` That's dead level with ${this.nameOf(opponent)} on ${mineTotal} rolls each!`;
        }

        this.host.bot.sendChat(
            `🏆 ${player.name} survived ${score} roll${score === 1 ? "" : "s"} — ` +
            `game ${played} of ${total} against ${this.nameOf(opponent)} done.${standing}`);

        if (played < total) {
            // A Survive game ends with the player naked, so the next one needs
            // them dressed again. Ask directly rather than leaving them to
            // remember a command while standing there with nothing on.
            this.promptNextGame(memberNumber, player.name, played + 1, total);
        } else {
            this.host.bot.whisper(memberNumber,
                `✅ That's all ${total} of your games for Round ${this.state.currentRound}. ` +
                `Total: ${mineTotal} rolls. I'll let you know how the match went once ${this.nameOf(opponent)} finishes.`);
        }

        this.tryResolveMatch(match);
    }

    // Asks whether they want to go straight into the next game of the match.
    // Answering yes runs the same path as !tournament play, which will offer
    // their remembered outfit — so a full turnaround is two words.
    private promptNextGame(memberNumber: number, name: string, nextGame: number, total: number): void {
        const existing = this.pendingNextGamePrompt.get(memberNumber);
        if (existing) clearTimeout(existing);

        const timeout = setTimeout(() => {
            this.pendingNextGamePrompt.delete(memberNumber);
            this.host.bot.whisper(memberNumber,
                `No rush — whisper !tournament play when you're ready for game ${nextGame} of ${total}.`);
        }, TOURNAMENT_NEXT_GAME_PROMPT_MS);
        this.pendingNextGamePrompt.set(memberNumber, timeout);

        const clothing = this.state?.config.clothingCount ?? 6;
        this.host.sendLongWhisper(memberNumber,
            `${total - nextGame + 1} game${total - nextGame + 1 === 1 ? "" : "s"} left this round.\n` +
            `Get dressed again (${clothing} items) and reply **yes** to start game ${nextGame} of ${total} — ` +
            `or **no** to stop for now and come back with !tournament play.`);
    }

    // Consumes the yes/no answering that prompt. Returns true if handled.
    public tryHandleNextGamePrompt(memberNumber: number, msg: string): boolean {
        const pending = this.pendingNextGamePrompt.get(memberNumber);
        if (!pending) return false;

        const a = msg.trim().toLowerCase();
        if (a !== "yes" && a !== "y" && a !== "no" && a !== "n") return false;

        clearTimeout(pending);
        this.pendingNextGamePrompt.delete(memberNumber);

        if (a === "no" || a === "n") {
            this.host.bot.whisper(memberNumber,
                "No problem — whisper !tournament play whenever you're ready for the next one.");
            return true;
        }

        // Same entry point as the command, so every guard (punishment owed,
        // match already decided, games already played) still applies.
        this.handlePlay(memberNumber, this.host.getPlayerName(memberNumber));
        return true;
    }

    // Resolves a match once both sides have played everything, credits the
    // records, and announces. Rounds closing on the deadline force-resolve
    // elsewhere; this is the "finished early" path.
    private tryResolveMatch(match: TournamentMatch): void {
        if (!this.state || match.result !== null) return;
        const result = resolveMatch(match, this.state.config.gamesPerMatch, false);
        if (!result) return;

        match.result = result;
        const eliminated = applyResult(this.state, match, result);
        this.save();

        const winnerName = result.winner !== null ? this.nameOf(result.winner) : null;
        const loserName = result.loser !== null ? this.nameOf(result.loser) : null;

        this.host.storage.appendTournamentLog(
            `[${new Date().toISOString()}] round ${match.round} ${match.id} RESOLVED ` +
            `winner=${winnerName ?? "none"} loser=${loserName ?? "none"} ` +
            `points=${result.pointsA}-${result.pointsB} by=${result.decidedBy}`);
        logGameEvent(`[TOURNAMENT] ${match.id} resolved: ${winnerName ?? "none"} beat ${loserName ?? "none"} (${result.decidedBy})`);

        if (winnerName && loserName) {
            // The time tiebreaker is deliberately unadvertised — mention it
            // only when it actually decided something, so nobody starts
            // playing against the clock.
            const how = result.decidedBy === "rolls" ? " (decided on total rolls)"
                : result.decidedBy === "time" ? " (points and rolls were tied — decided by total time taken, fastest wins)"
                : result.decidedBy === "forfeit" ? " (by forfeit)"
                : "";
            this.host.bot.sendChat(`🏆 Round ${match.round}: ${winnerName} beats ${loserName}${how}.`);
            this.notify(result.winner!, `🏆 You won your Round ${match.round} match against ${loserName}${how}.`);
            this.notify(result.loser!, `Round ${match.round}: you lost to ${winnerName}${how}.`);
        } else if (result.decidedBy === "double-forfeit") {
            this.host.bot.sendChat(`🏆 Round ${match.round}: neither player showed up — both take a loss.`);
        }

        for (const mn of eliminated) {
            this.host.bot.sendChat(`🏆 ${this.nameOf(mn)} has been eliminated from the tournament.`);
            this.notify(mn, "You've been eliminated from the tournament (2 losses). Thanks for playing!");
        }
    }

    // ---- serving punishment ---------------------------------------------------

    // Called when a member enters the room. Two different things happen
    // depending on whether they were already mid-serve:
    //  - already serving (they're still bound): the clock just resumes, no
    //    questions — they never stopped serving, they only stepped out.
    //  - owing time but not bound: ASK first. Nobody gets tied up for walking
    //    into a room.
    public onEnterRoom(memberNumber: number): void {
        if (!this.state) return;
        const player = findPlayer(this.state, memberNumber);
        if (!player) return;

        if (player.punishMsRemaining > 0) {
            // Still bound: they never stopped serving, they just dropped out.
            // The clock ran the whole time, so there's nothing to restart —
            // just clear the disconnect marker so it isn't retroactively paused.
            if (player.serving) {
                const wasDisconnected = player.disconnectedAt !== null;
                player.disconnectedAt = null;
                this.save();
                this.host.bot.whisper(memberNumber,
                    wasDisconnected
                        ? `⛓️ Welcome back — your punishment clock kept running while you were gone. ` +
                          `${formatDuration(punishRemaining(player, Date.now()))} left.`
                        : `⛓️ ${formatDuration(punishRemaining(player, Date.now()))} left to serve.`);
                return;
            }

            this.promptToServe(memberNumber, player);
            return;
        }

        this.sendRoundStatusOnEntry(memberNumber, player);
    }

    // The format is asynchronous — a player can be paired for hours without
    // ever seeing it happen — so walking into the room is the moment to tell
    // them where they stand. Only for players with nothing to do about
    // punishment (that conversation takes priority and already states the
    // debt), and rate-limited so bouncing in and out isn't a wall of whispers.
    private sendRoundStatusOnEntry(memberNumber: number, player: TournamentPlayer): void {
        if (!this.state || this.state.status !== "active") return;
        if (player.eliminated || player.withdrew) return;

        const now = Date.now();
        const lastSent = this.lastStatusOnEntry.get(memberNumber) ?? 0;
        if (now - lastSent < TOURNAMENT_ENTRY_STATUS_COOLDOWN_MS) return;
        this.lastStatusOnEntry.set(memberNumber, now);

        const lines = [`🏆 Tournament — Round ${this.state.currentRound}`];
        if (this.state.roundDeadline) {
            const left = Date.parse(this.state.roundDeadline) - now;
            if (left > 0) lines.push(`Time left this round: ${formatDuration(left)}`);
        }
        lines.push(this.personalBlock(memberNumber, now));
        this.host.sendLongWhisper(memberNumber, lines.join("\n"));
    }

    private promptToServe(memberNumber: number, player: TournamentPlayer): void {
        const existing = this.pendingServePrompt.get(memberNumber);
        if (existing) clearTimeout(existing);

        const timeout = setTimeout(() => {
            this.pendingServePrompt.delete(memberNumber);
        }, TOURNAMENT_SERVE_PROMPT_MS);
        this.pendingServePrompt.set(memberNumber, timeout);

        this.host.sendLongWhisper(memberNumber,
            `⛓️ You still owe ${formatDuration(player.punishMsRemaining)} bound and claimable ` +
            `from the tournament, and you can't play your next match until it's served.\n` +
            `Ready to start now? Reply **yes**, or whisper !tournament serve whenever you are. ` +
            `You can stop any time with !tournament stop and finish the rest later.`);
    }

    // Consumes a plain yes/no answering the serve prompt. Returns true if it
    // was consumed.
    public tryHandleServePrompt(memberNumber: number, msg: string): boolean {
        const pending = this.pendingServePrompt.get(memberNumber);
        if (!pending) return false;
        if (msg !== "yes" && msg !== "y" && msg !== "no" && msg !== "n") return false;

        clearTimeout(pending);
        this.pendingServePrompt.delete(memberNumber);

        if (msg === "no" || msg === "n") {
            this.host.bot.whisper(memberNumber,
                "No problem — whisper !tournament serve when you're ready. Your time stays owed until then.");
            return true;
        }
        this.handleServe(memberNumber);
        return true;
    }

    public handleServe(memberNumber: number): void {
        if (!this.state) {
            this.host.bot.whisper(memberNumber, "There's no tournament running.");
            return;
        }
        const player = findPlayer(this.state, memberNumber);
        if (!player) {
            this.host.bot.whisper(memberNumber, "You're not in this tournament.");
            return;
        }

        const owed = punishRemaining(player, Date.now());
        if (owed <= 0) {
            this.host.bot.whisper(memberNumber, "You don't owe any punishment time — nothing to serve.");
            return;
        }
        if (player.serving) {
            this.host.bot.whisper(memberNumber,
                `You're already serving — ${formatDuration(owed)} left. Whisper !tournament stop to pause.`);
            return;
        }

        const prompt = this.pendingServePrompt.get(memberNumber);
        if (prompt) { clearTimeout(prompt); this.pendingServePrompt.delete(memberNumber); }

        if (!this.host.isInRoom(memberNumber)) {
            this.host.bot.whisper(memberNumber, "You need to be in the room to serve your time.");
            return;
        }

        player.serving = true;
        player.servingSince = Date.now();
        player.disconnectedAt = null;
        // Fresh password per sentence — handed to whoever claims them, so a
        // claimer can let them out early without the bot's own key ever
        // being shared.
        player.lockPassword = generatePassword();
        player.claimedBy = null;
        player.claimedByName = null;
        this.save();

        logGameEvent(`[TOURNAMENT] ${player.name} (#${memberNumber}) began serving ${formatDuration(owed)}`);
        this.applyPunishmentBondage(memberNumber, player, owed);

        this.host.bot.sendChat(
            `⛓️ ${player.name} is serving tournament punishment — bound and claimable for ` +
            `${formatDuration(owed)}. Tournament players can whisper !claim to take them.`);
        this.host.sendLongWhisper(memberNumber,
            `⛓️ Serving now — ${formatDuration(owed)} to go. The clock only runs while you're here and bound. ` +
            `Whisper !tournament stop to pause and keep the remainder for later.`);
    }

    public handleStop(memberNumber: number): void {
        if (!this.state) {
            this.host.bot.whisper(memberNumber, "There's no tournament running.");
            return;
        }
        const player = findPlayer(this.state, memberNumber);
        if (!player || !player.serving) {
            this.host.bot.whisper(memberNumber, "You're not serving right now.");
            return;
        }

        this.bankServedTime(player);
        this.save();

        const left = player.punishMsRemaining;
        logGameEvent(`[TOURNAMENT] ${player.name} (#${memberNumber}) stopped serving, ${formatDuration(left)} remaining`);
        this.releasePunishmentBondage(memberNumber);

        if (left <= 0) {
            this.host.bot.sendChat(`⛓️ ${player.name} has served their tournament punishment in full and is free.`);
            this.host.bot.whisper(memberNumber, "✅ That's all of it — you're free, and clear to play your next match.");
        } else {
            this.host.bot.sendChat(`⛓️ ${player.name} has paused their punishment — ${formatDuration(left)} still owed.`);
            this.host.bot.whisper(memberNumber,
                `Paused with ${formatDuration(left)} left. Whisper !tournament serve to pick it up again — ` +
                `you can't play your next match until it's done.`);
        }
    }

    // Moves elapsed served time out of the running clock and into the balance.
    // Kept separate so leaving the room, stopping, and finishing all use one
    // path and can't drift apart.
    private bankServedTime(player: TournamentPlayer): void {
        const remaining = punishRemaining(player, Date.now());
        player.punishMsRemaining = Math.max(0, remaining);
        player.serving = false;
        player.servingSince = null;
        player.disconnectedAt = null;
        // No longer bound, so no longer held — a new sentence means a new
        // password and a fresh chance for someone to claim them.
        if (player.claimedBy !== null) {
            this.notify(player.claimedBy, `${player.name} is no longer bound — they're not yours any more.`);
        }
        this.clearClaim(player);
    }

    // Called when a member leaves the room while serving. The clock is NOT
    // stopped here: BC drops people all the time, and a dropped connection
    // shouldn't add to someone's sentence. The time keeps running through the
    // grace window. Only if they fail to come back does the sentence pause,
    // and then retroactively as of this moment (see checkServingCompletions)
    // so a long absence never counts as time served.
    public onLeaveRoom(memberNumber: number): void {
        if (!this.state) return;
        const player = findPlayer(this.state, memberNumber);
        if (!player || !player.serving || player.disconnectedAt !== null) return;

        player.disconnectedAt = Date.now();
        this.save();
        logGameEvent(`[TOURNAMENT] ${player.name} (#${memberNumber}) dropped out mid-serve — ` +
            `clock keeps running for ${formatDuration(TOURNAMENT_RESUME_GRACE_MS)}`);
    }

    // Anyone leaving may have been holding a prisoner; hand them back.
    public onAnyoneLeftRoom(memberNumber: number): void {
        if (!this.state) return;
        this.releaseClaimsBy(memberNumber);
        this.save();
    }

    // Checks every serving player for a completed sentence. Called on the same
    // activity ticks as checkSchedule, since there's no timer loop.
    private checkServingCompletions(now: number): void {
        if (!this.state) return;
        for (const player of this.state.players) {
            if (!player.serving) continue;

            // Sentence finished — free them even if they're not here to see it
            // (and even if the tournament itself is paused or frozen).
            if (punishRemaining(player, now) <= 0) {
                this.bankServedTime(player);
                player.disconnectedAt = null;
                this.releasePunishmentBondage(player.memberNumber);
                logGameEvent(`[TOURNAMENT] ${player.name} (#${player.memberNumber}) completed their punishment`);
                this.host.bot.sendChat(`⛓️ ${player.name} has served their tournament punishment in full and is free.`);
                this.notify(player.memberNumber, "✅ Punishment served — you're free, and clear to play your next match.");
                continue;
            }

            // Dropped out and didn't come back inside the grace window. Pause
            // the sentence retroactively, as of the moment they vanished, so
            // the grace time isn't credited to someone who simply logged off.
            // Done on activity ticks rather than a timer so it still holds
            // across a bot restart.
            if (player.disconnectedAt !== null && now - player.disconnectedAt >= TOURNAMENT_RESUME_GRACE_MS) {
                const servedUntilDisconnect = Math.max(0, player.disconnectedAt - (player.servingSince ?? player.disconnectedAt));
                player.punishMsRemaining = Math.max(0, player.punishMsRemaining - servedUntilDisconnect);
                player.serving = false;
                player.servingSince = null;
                player.disconnectedAt = null;
                this.releasePunishmentBondage(player.memberNumber);
                logGameEvent(`[TOURNAMENT] ${player.name} (#${player.memberNumber}) didn't return within ` +
                    `${formatDuration(TOURNAMENT_RESUME_GRACE_MS)} — sentence paused, ` +
                    `${formatDuration(player.punishMsRemaining)} still owed`);
                this.notify(player.memberNumber,
                    `⛓️ You didn't make it back, so your punishment is paused with ` +
                    `${formatDuration(player.punishMsRemaining)} left. Whisper !tournament serve when you're back.`);
            }
        }
        this.save();
    }

    // Binds the player for their punishment. The exact look is still being
    // decided (see design_tournament.md) — for now this reuses the solo themed
    // bondage machinery via the host so the mechanic is real and testable, and
    // swapping in a dedicated tournament outfit later means changing only this
    // method and its release counterpart.
    private applyPunishmentBondage(memberNumber: number, player: TournamentPlayer, durationMs: number): void {
        this.host.applyTournamentPunishment(memberNumber, durationMs, player.lockPassword ?? generatePassword());
    }

    private releasePunishmentBondage(memberNumber: number): void {
        this.host.releaseTournamentPunishment(memberNumber);
    }

    // True if this member may claim tournament prisoners. DW's call: only
    // other players in the tournament, not the whole room — it keeps the
    // stakes inside the competition.
    public canClaim(memberNumber: number): boolean {
        if (!this.state) return false;
        const player = findPlayer(this.state, memberNumber);
        return !!player && !player.withdrew;
    }

    // Everyone currently serving, for the claim list.
    public servingPlayers(): TournamentPlayer[] {
        if (!this.state) return [];
        return this.state.players.filter(p => p.serving);
    }

    // Prisoners this member could take right now: serving, not already held,
    // not themselves, and actually in the room to be leashed.
    public claimablePrisoners(memberNumber: number): TournamentPlayer[] {
        if (!this.canClaim(memberNumber)) return [];
        return this.servingPlayers().filter(p =>
            p.memberNumber !== memberNumber &&
            p.claimedBy === null &&
            this.host.isInRoom(p.memberNumber));
    }

    // Handles !claim for tournament prisoners. Returns false if this member has
    // nothing to claim, so game.ts can fall through to its own end-game prize
    // handling rather than swallowing the command.
    public tryHandleClaim(memberNumber: number, args: string): boolean {
        if (!this.state || !this.canClaim(memberNumber)) return false;

        const claimer = findPlayer(this.state, memberNumber)!;
        // Someone serving their own sentence isn't in a position to collect.
        if (claimer.serving) {
            this.host.bot.whisper(memberNumber, "You're serving your own punishment right now — no claiming until you're free.");
            return true;
        }

        const available = this.claimablePrisoners(memberNumber);
        const alreadyMine = this.servingPlayers().filter(p => p.claimedBy === memberNumber);

        if (available.length === 0 && alreadyMine.length === 0) return false;

        const trimmed = args.trim();
        if (!trimmed) {
            const lines: string[] = [];
            if (available.length > 0) {
                lines.push("⛓️ Tournament prisoners you can claim:");
                available.forEach((p, i) => {
                    lines.push(`${i + 1}. ${p.name} — ${formatDuration(punishRemaining(p, Date.now()))} left`);
                });
                lines.push(`Whisper !claim 1 to take one. You'll get their lock password and they'll be leashed.`);
            }
            if (alreadyMine.length > 0) {
                lines.push(`Already yours: ${alreadyMine.map(p => p.name).join(", ")}.`);
            }
            this.host.sendLongWhisper(memberNumber, lines.join("\n"));
            return true;
        }

        const index = parseInt(trimmed.split(/\s+/)[0], 10);
        if (isNaN(index) || index < 1 || index > available.length) {
            this.host.bot.whisper(memberNumber,
                available.length > 0
                    ? `Pick a number between 1 and ${available.length} — whisper !claim on its own to see the list.`
                    : "There's nobody available to claim right now.");
            return true;
        }

        const prisoner = available[index - 1];
        const claimerName = this.host.getPlayerName(memberNumber);
        prisoner.claimedBy = memberNumber;
        prisoner.claimedByName = claimerName;
        this.save();

        const lockEndTime = Date.now() + punishRemaining(prisoner, Date.now());
        if (prisoner.lockPassword) {
            this.host.attachTournamentLeash(prisoner.memberNumber, prisoner.lockPassword, lockEndTime);
        }

        logGameEvent(`[TOURNAMENT] ${claimerName} (#${memberNumber}) claimed ${prisoner.name} (#${prisoner.memberNumber})`);
        this.host.storage.appendTournamentLog(
            `[${new Date().toISOString()}] CLAIM ${claimerName}(#${memberNumber}) took ${prisoner.name}(#${prisoner.memberNumber})`);

        this.host.sendLongWhisper(memberNumber,
            `⛓️ You've claimed ${prisoner.name}! They're leashed and yours for the next ` +
            `${formatDuration(punishRemaining(prisoner, Date.now()))}.\n` +
            (prisoner.lockPassword
                ? `Their lock password is: ${prisoner.lockPassword} — use it if you'd like to let them out early, ` +
                  `or leave them to serve it out.\n`
                : "") +
            `Note: releasing their locks doesn't clear their sentence — they still owe the time before they can play again.`);

        this.notify(prisoner.memberNumber,
            `⛓️ ${claimerName} has claimed you. You're theirs while you serve — they have your lock password.`);
        this.host.bot.sendChat(`⛓️ ${claimerName} has claimed ${prisoner.name}.`);
        return true;
    }

    // Drops a claim — on release, on stopping, or when the claimer leaves.
    private clearClaim(player: TournamentPlayer): void {
        player.claimedBy = null;
        player.claimedByName = null;
        player.lockPassword = null;
    }

    // If a claimer walks out, their prisoner goes back on the board rather
    // than staying held by someone who isn't there.
    private releaseClaimsBy(memberNumber: number): void {
        if (!this.state) return;
        for (const prisoner of this.state.players) {
            if (prisoner.claimedBy !== memberNumber) continue;
            const heldBy = prisoner.claimedByName ?? "Their claimer";
            prisoner.claimedBy = null;
            prisoner.claimedByName = null;
            this.notify(prisoner.memberNumber, `${heldBy} has left — you're unclaimed again, though you're still serving.`);
            this.host.bot.sendChat(`⛓️ ${prisoner.name} is unclaimed again — ${heldBy} left the room.`);
        }
    }

    // ---- status / standings --------------------------------------------------

    public handleStatus(memberNumber: number): void {
        if (!this.state) {
            this.host.bot.whisper(memberNumber,
                "No tournament is set up right now. When one is, I'll announce it in the room — " +
                "whisper !tournament rules to read the format in the meantime.");
            return;
        }

        const now = Date.now();
        const lines: string[] = [];

        switch (this.state.status) {
            case "registration": {
                const opens = Date.parse(this.state.config.registrationOpensAt);
                const closes = Date.parse(this.state.config.signUpDeadline);
                if (now < opens) {
                    lines.push(`🏆 Tournament registration opens in ${formatDuration(opens - now)}.`);
                } else {
                    lines.push(`🏆 Registration is OPEN — closes in ${formatDuration(Math.max(0, closes - now))}.`);
                    lines.push(`Whisper !tournament register to sign up.`);
                }
                lines.push(`Signed up (${this.state.players.length}): ${this.state.players.map(p => p.name).join(", ") || "nobody yet"}`);
                lines.push(`Minimum to start: ${this.state.config.minPlayers}`);
                lines.push(`Round 1 begins: ${formatLocalTime(this.state.config.firstRoundStart)}`);
                break;
            }
            case "active": {
                lines.push(`🏆 Tournament — Round ${this.state.currentRound}`);
                if (this.state.roundDeadline) {
                    const left = Date.parse(this.state.roundDeadline) - now;
                    lines.push(left > 0
                        ? `Time left this round: ${formatDuration(left)}`
                        : `This round's deadline has passed — results are being finalised.`);
                }
                lines.push("");
                lines.push(this.standingsBlock());
                lines.push("");
                lines.push(this.personalBlock(memberNumber, now));
                break;
            }
            case "paused":
                lines.push("🏆 The tournament is paused by an admin. Rounds won't advance until it resumes.");
                lines.push(this.standingsBlock());
                break;
            case "frozen":
                lines.push("🏆 The tournament is frozen pending an admin decision.");
                if (this.state.frozenReason) lines.push(`Reason: ${this.state.frozenReason}`);
                lines.push(this.standingsBlock());
                break;
            case "complete": {
                const champ = this.state.champion ? this.nameOf(this.state.champion) : "nobody";
                const runner = this.state.runnerUp ? this.nameOf(this.state.runnerUp) : null;
                lines.push(`🏆 Tournament complete — champion: ${champ}${runner ? `, runner-up: ${runner}` : ""}.`);
                lines.push(this.standingsBlock());
                break;
            }
            default:
                lines.push("🏆 No tournament is currently running.");
        }

        this.host.sendLongWhisper(memberNumber, lines.join("\n"));
    }

    private nameOf(memberNumber: number): string {
        const player = this.state ? findPlayer(this.state, memberNumber) : undefined;
        return player?.name ?? this.host.getPlayerName(memberNumber);
    }

    private standingsBlock(): string {
        if (!this.state) return "";
        const active = rankPlayers(this.state, activePlayers(this.state));
        const out = rankPlayers(this.state, this.state.players.filter(p => p.eliminated && !p.withdrew));
        const withdrew = this.state.players.filter(p => p.withdrew);

        const lines: string[] = ["─ Standings ─"];
        active.forEach((p, i) => {
            const bye = p.byesUsed > 0 ? ` (${p.byesUsed} bye${p.byesUsed === 1 ? "" : "s"})` : "";
            lines.push(`${i + 1}. ${p.name} — ${p.wins}W/${p.losses}L${bye}`);
        });
        if (out.length > 0) {
            lines.push("─ Eliminated ─");
            out.forEach(p => lines.push(`${p.name} — ${p.wins}W/${p.losses}L`));
        }
        if (withdrew.length > 0) {
            lines.push("─ Withdrew ─");
            withdrew.forEach(p => lines.push(`${p.name} — ${p.wins}W/${p.losses}L`));
        }
        return lines.join("\n");
    }

    // The "what do I personally need to do" block — the part most players
    // actually want, so it goes last where it's easiest to find.
    private personalBlock(memberNumber: number, now: number): string {
        if (!this.state) return "";
        const player = findPlayer(this.state, memberNumber);
        if (!player) return "You're not in this tournament — whisper !tournament rules to see how the next one works.";

        const owed = punishRemaining(player, now);
        if (owed > 0) {
            return `⛓️ You still owe ${formatDuration(owed)} bound & claimable before you can play again.`;
        }
        if (player.withdrew) return "You withdrew from this tournament.";
        if (player.eliminated) return `You were eliminated with ${player.wins}W/${player.losses}L. Thanks for playing!`;

        const match = matchFor(this.state, memberNumber, this.state.currentRound);
        if (!match) return "You have no match this round.";
        if (match.playerB === null) return "🎟️ You have a BYE this round — automatic win, nothing to play.";

        const opponent = match.playerA === memberNumber ? match.playerB : match.playerA;
        const mine = match.playerA === memberNumber ? match.gamesA : match.gamesB;
        const left = this.state.config.gamesPerMatch - mine.length;

        if (left <= 0) return `✅ You've played all ${this.state.config.gamesPerMatch} games against ${this.nameOf(opponent)}. Waiting on them / the round to close.`;
        return `🎲 Your opponent: ${this.nameOf(opponent)}. You have ${left} game(s) left to play — whisper !tournament play to start one.`;
    }

    // ---- admin controls -------------------------------------------------------

    // Admin force-advance, mainly for testing. Two meanings depending on where
    // the tournament is:
    //   registration -> start Round 1 NOW, ignoring the sign-up deadline and
    //                   the scheduled first-round time.
    //   active       -> close the current round NOW. Anything unplayed scores
    //                   as a loss, exactly as it would at the real deadline,
    //                   so this is destructive mid-round and says so.
    public handleAdvance(memberNumber: number): void {
        if (!this.host.requireAdmin(memberNumber)) return;
        if (!this.state) {
            this.host.bot.whisper(memberNumber, "There's no tournament to advance.");
            return;
        }
        if (this.state.status === "paused" || this.state.status === "frozen") {
            this.host.bot.whisper(memberNumber,
                `The tournament is ${this.state.status} — whisper !tournament resume first.`);
            return;
        }
        if (this.state.status === "complete" || this.state.status === "cancelled") {
            this.host.bot.whisper(memberNumber, "This tournament is already over.");
            return;
        }

        const now = Date.now();

        if (this.state.status === "registration") {
            const field = this.state.players.length;
            if (field < 2) {
                this.host.bot.whisper(memberNumber,
                    `Only ${field} player${field === 1 ? "" : "s"} registered — you need at least 2 to start. ` +
                    `(Starting now would just auto-cancel it.)`);
                return;
            }
            logGameEvent(`[TOURNAMENT] admin #${memberNumber} force-started the tournament early (${field} players)`);
            this.host.bot.whisper(memberNumber,
                `Starting now with ${field} player(s), ignoring the scheduled start time.`);
            this.host.bot.sendChat("🏆 Registration is closed — the tournament is starting now!");
            this.beginTournament(now);
            return;
        }

        // Active: close the round early.
        const round = this.state.currentRound;
        const outstanding = this.state.matches
            .filter(m => m.round === round && m.result === null && m.playerB !== null).length;
        logGameEvent(`[TOURNAMENT] admin #${memberNumber} force-closed round ${round} (${outstanding} match(es) unresolved)`);
        this.host.bot.whisper(memberNumber,
            outstanding > 0
                ? `Closing Round ${round} now. ${outstanding} match(es) hadn't finished — unplayed games score as losses, same as hitting the deadline.`
                : `Closing Round ${round} now.`);
        this.host.bot.sendChat(`🏆 Round ${round} has been closed early by an admin.`);
        this.finalizeRound(now);
    }

    public handlePause(memberNumber: number): void {
        if (!this.host.requireAdmin(memberNumber)) return;
        if (!this.state || !this.hasTournament()) {
            this.host.bot.whisper(memberNumber, "There's no tournament running.");
            return;
        }
        if (this.state.status === "paused") {
            this.host.bot.whisper(memberNumber, "The tournament is already paused.");
            return;
        }
        this.state.status = "paused";
        this.save();
        logGameEvent(`[TOURNAMENT] paused by #${memberNumber}`);
        this.host.bot.whisper(memberNumber, "Tournament paused — rounds won't advance until !tournament resume.");
        this.host.bot.sendChat("🏆 The tournament has been paused by an admin.");
    }

    public handleResume(memberNumber: number): void {
        if (!this.host.requireAdmin(memberNumber)) return;
        if (!this.state) {
            this.host.bot.whisper(memberNumber, "There's no tournament to resume.");
            return;
        }
        if (this.state.status !== "paused" && this.state.status !== "frozen") {
            this.host.bot.whisper(memberNumber, `The tournament isn't paused (status: ${this.state.status}).`);
            return;
        }
        this.state.status = "active";
        this.state.frozenReason = null;
        this.save();
        logGameEvent(`[TOURNAMENT] resumed by #${memberNumber}`);
        this.host.bot.whisper(memberNumber, "Tournament resumed.");
        this.host.bot.sendChat("🏆 The tournament has resumed.");
    }

    public handleCancel(memberNumber: number): void {
        if (!this.host.requireAdmin(memberNumber)) return;
        if (!this.state) {
            this.host.bot.whisper(memberNumber, "There's no tournament to cancel.");
            return;
        }
        // Free anyone mid-sentence BEFORE the state is dropped. Once it's null
        // nothing can release them — checkServingCompletions early-returns —
        // so they'd sit bound until BC's own timer lock expired, with no word
        // from the bot. Cancelling a tournament must not leave people tied up.
        const freed: string[] = [];
        for (const player of this.state.players) {
            if (!player.serving) continue;
            this.releasePunishmentBondage(player.memberNumber);
            player.serving = false;
            player.servingSince = null;
            player.disconnectedAt = null;
            this.clearClaim(player);
            freed.push(player.name);
            this.notify(player.memberNumber,
                "🏆 The tournament was cancelled — you've been released and you owe nothing further.");
        }
        if (freed.length > 0) {
            logGameEvent(`[TOURNAMENT] cancel released ${freed.length} serving player(s): ${freed.join(", ")}`);
            this.host.bot.sendChat(`⛓️ ${freed.join(", ")} released — the tournament was cancelled.`);
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        this.state.status = "cancelled";
        this.host.storage.archiveTournament(this.state, stamp);
        logGameEvent(`[TOURNAMENT] cancelled by #${memberNumber} (archived as tournament_${stamp}.json)`);
        this.notifyAll("🏆 The tournament has been cancelled by an admin.");
        this.state = null;
        this.host.bot.whisper(memberNumber, `Tournament cancelled and archived as tournament_${stamp}.json.`);
        this.host.bot.sendChat("🏆 The tournament has been cancelled.");
    }

    // Freezes the tournament for an admin ruling. Used when the rules cannot
    // decide an outcome — e.g. the last active players all forfeited, so there
    // is nobody left to crown (see design_tournament.md, Field Collapse).
    public freeze(reason: string): void {
        if (!this.state) return;
        this.state.status = "frozen";
        this.state.frozenReason = reason;
        this.save();
        logGameEvent(`[TOURNAMENT] FROZEN: ${reason}`);
        this.host.bot.sendChat(`🏆 The tournament is frozen pending an admin decision: ${reason}`);
        for (const admin of this.host.getRoomMembers().filter(n => this.host.isAdmin(n))) {
            this.host.bot.whisper(admin, `🏆 Tournament frozen — ${reason}\nUse !tournament resume once you've decided, or !tournament cancel.`);
        }
    }

    // ---- rules text -----------------------------------------------------------

    public handleRules(memberNumber: number): void {
        const c = this.state?.config;
        const roundLen = c ? formatDuration(c.roundLengthMs) : "48 hours";
        const firstLoss = c ? (c.firstLossPunishMs > 0 ? formatDuration(c.firstLossPunishMs) : "none") : "15 minutes";
        const elimination = c ? (c.eliminationPunishMs > 0 ? formatDuration(c.eliminationPunishMs) : "none") : "1 hour";
        const games = c?.gamesPerMatch ?? TOURNAMENT_DEFAULT_GAMES_PER_MATCH;
        const clothing = c?.clothingCount ?? TOURNAMENT_DEFAULT_CLOTHING;
        const grace = c?.graceRounds ?? TOURNAMENT_DEFAULT_GRACE_ROUNDS;

        this.host.sendLongWhisper(memberNumber,
            "🎲 StripDice Solo Tournament — Rules\n\n" +
            "FORMAT\n" +
            "Swiss pairing with double elimination. Each round you're paired against someone with a similar record. " +
            "Lose twice and you're out. The last two players meet in the grand final, so there's always a clear 1st and 2nd.\n\n" +
            "HOW A MATCH WORKS\n" +
            `Each match is ${games} solo Survive games. You don't need to be online at the same time as your opponent — ` +
            `you each play your games whenever you like within the round.\n` +
            `• Clothing: exactly ${clothing} items. I check before each game.\n` +
            "• Score: rolls survived — more is better.\n" +
            "• Win = 1 point, draw = ½ each, loss = 0.\n" +
            "• Most points wins. If that's tied, most total rolls wins.\n\n" +
            "ROUNDS\n" +
            `Each round lasts ${roundLen}. When everyone finishes early, I'll ask if you all want to start the next round straight away.\n\n` +
            "IF YOU DON'T FINISH IN TIME\n" +
            "• You played, they didn't → you win\n" +
            "• Neither played → you both take a loss\n" +
            "• Partly played → finished games count, the rest score as losses\n\n" +
            "PUNISHMENT\n" +
            `Round${grace === 1 ? "" : "s"} 1${grace > 1 ? `–${grace}` : ""} ${grace === 1 ? "is a grace round" : "are grace rounds"} — no punishment.\n` +
            `After that: first loss = ${firstLoss} bound and claimable in the room. ` +
            `Eliminated (2nd loss) = ${elimination}.\n` +
            "Being claimable means anyone in the room can claim you and leash you around for the duration. " +
            "You don't have to serve it all at once — you can stop, leave, and come back to serve the rest. " +
            "You can't play BD while you still owe time. Champion and runner-up serve nothing.\n\n" +
            "COMMANDS\n" +
            "!tournament — standings, your opponent, time left\n" +
            "!tournament register — sign up while registration is open\n" +
            "!tournament play — play one of your games for this round\n" +
            "!tournament withdraw — leave (between rounds, if allowed)");
    }
}
