// ============================================================
// TOURNAMENT MANAGER - owns tournament.json, the !tournament
// command surface, the admin setup interview, and registration.
//
// Bracket maths lives in tournamentLogic.ts (pure, simulated by
// tournamentSim.ts). This file is the stateful, BC-facing half:
// persistence, messaging, and the command handlers. Anything it
// needs from the game goes through GameHost — never import game.ts.
// ============================================================
import { log, logGameEvent } from "./logger";
import { GameHost } from "./host";
import {
    TournamentConfig, TournamentPlayer, TournamentState,
} from "./types";
import {
    activePlayers, findPlayer, isActive, matchFor, punishRemaining, rankPlayers,
} from "./tournamentLogic";
import { formatDuration, parseDuration, parseWhen } from "./util";
import {
    TOURNAMENT_DEFAULT_CLOTHING, TOURNAMENT_DEFAULT_GAMES_PER_MATCH,
    TOURNAMENT_DEFAULT_GRACE_ROUNDS, TOURNAMENT_DEFAULT_MIN_PLAYERS,
    TOURNAMENT_FRIEND_WAIT_MS, TOURNAMENT_SETUP_TIMEOUT_MS,
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
                return `That's before sign-ups close (${new Date(deadline).toUTCString()}).`;
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
        const when = (iso?: string) => iso ? new Date(iso).toUTCString() : "—";
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
        });
        this.save();
        logGameEvent(`[TOURNAMENT] ${name} (#${memberNumber}) registered (${this.state.players.length} total)`);

        this.host.sendLongWhisper(memberNumber,
            `🏆 You're registered for the tournament! (${this.state.players.length} signed up)\n` +
            `Sign-ups close in ${formatDuration(Math.max(0, closes - now))}, and Round 1 begins ` +
            `${new Date(this.state.config.firstRoundStart).toUTCString()}.\n` +
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
                lines.push(`Round 1 begins: ${new Date(this.state.config.firstRoundStart).toUTCString()}`);
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
