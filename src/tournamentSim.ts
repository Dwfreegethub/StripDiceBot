// ============================================================
// TOURNAMENT SIMULATOR - dev harness, never run by the bot.
//
// A tournament takes days to run, so the bracket logic cannot be
// validated by playing one. This drives tournamentLogic.ts through
// thousands of synthetic tournaments — random scores, no-shows,
// double forfeits, withdrawals, exact ties — and asserts the
// invariants that must hold every round.
//
//   npm run build && node build/tournamentSim.js
//
// Exits non-zero if any invariant breaks, so it can gate a commit.
// ============================================================
import {
    TournamentConfig, TournamentGameResult, TournamentMatch,
    TournamentPlayer, TournamentState,
} from "./types";
import {
    activePlayers, applyResult, evaluateField, isActive, pairRound,
    punishmentForLoss, recordPairing, resolveMatch,
} from "./tournamentLogic";
import { formatDuration, parseDuration, parseWhen } from "./util";
import { TournamentManager } from "./tournament";

const GAMES_PER_MATCH = 3;

function makeConfig(): TournamentConfig {
    return {
        registrationOpensAt: "2026-08-01T00:00:00.000Z",
        signUpDeadline: "2026-08-08T00:00:00.000Z",
        firstRoundStart: "2026-08-08T00:00:00.000Z",
        roundLengthMs: 48 * 60 * 60 * 1000,
        gamesPerMatch: GAMES_PER_MATCH,
        clothingCount: 6,
        minPlayers: 6,
        graceRounds: 1,
        firstLossPunishMs: 15 * 60 * 1000,
        eliminationPunishMs: 60 * 60 * 1000,
        allowsWithdrawal: true,
    };
}

function makePlayer(memberNumber: number): TournamentPlayer {
    return {
        memberNumber,
        name: `Player${memberNumber}`,
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
    };
}

function makeState(playerCount: number): TournamentState {
    return {
        status: "active",
        createdBy: 1,
        config: makeConfig(),
        currentRound: 0,
        roundDeadline: null,
        players: Array.from({ length: playerCount }, (_, i) => makePlayer(1000 + i)),
        matches: [],
        champion: null,
        runnerUp: null,
        frozenReason: null,
    };
}

// ---- failure tracking --------------------------------------------------

let failures = 0;
function check(condition: boolean, label: string, detail?: string): void {
    if (!condition) {
        failures++;
        console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    }
}

// ---- synthetic game play -----------------------------------------------

// Survive scores cluster in the low tens; a tight spread makes exact ties
// (and therefore the tiebreaker paths) actually occur during the sim.
function randomGame(rng: () => number): TournamentGameResult {
    return {
        score: 5 + Math.floor(rng() * 20),
        durationMs: (3 + Math.floor(rng() * 20)) * 60 * 1000,
        playedAt: "2026-08-08T12:00:00.000Z",
    };
}

// Mulberry32 — small seeded PRNG so a failing run can be reproduced exactly.
function seededRng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Plays out one match. `behaviour` decides whether each side shows up, so
// forfeits and double no-shows get exercised alongside normal play.
function playMatch(match: TournamentMatch, rng: () => number): void {
    if (match.playerB === null) return; // bye — no games

    const roll = rng();
    const bothPlay = roll > 0.18;
    const aPlays = bothPlay || roll > 0.09;
    const bPlays = bothPlay || roll <= 0.06;

    const fill = (games: TournamentGameResult[], play: boolean) => {
        if (!play) return;
        // Occasionally leave a match part-played, to exercise "unplayed games
        // score as losses" against a full opponent.
        const count = rng() < 0.1 ? 1 + Math.floor(rng() * GAMES_PER_MATCH) : GAMES_PER_MATCH;
        for (let i = 0; i < count; i++) games.push(randomGame(rng));
    };

    fill(match.gamesA, aPlays);
    fill(match.gamesB, bPlays);
}

// ---- one full tournament ------------------------------------------------

interface SimOutcome {
    rounds: number;
    champion: number | null;
    runnerUp: number | null;
    byes: number;
    doubleForfeits: number;
    decidedByTime: number;
    unresolvable: number;
}

function runTournament(playerCount: number, seed: number, allowWithdrawals: boolean): SimOutcome {
    const rng = seededRng(seed);
    const state = makeState(playerCount);
    const outcome: SimOutcome = {
        rounds: 0, champion: null, runnerUp: null,
        byes: 0, doubleForfeits: 0, decidedByTime: 0, unresolvable: 0,
    };

    const MAX_ROUNDS = 40; // termination guard; a real tournament ends far sooner

    for (let round = 1; round <= MAX_ROUNDS; round++) {
        const field = evaluateField(state);
        if (field.kind === "decided") {
            outcome.champion = field.champion;
            outcome.runnerUp = field.runnerUp;
            break;
        }
        if (field.kind === "empty") break;

        state.currentRound = round;
        const matches = pairRound(state, round);

        // ---- pairing invariants ----
        const activeBefore = activePlayers(state).map(p => p.memberNumber);
        const seen = new Map<number, number>();
        let byesThisRound = 0;

        for (const match of matches) {
            seen.set(match.playerA, (seen.get(match.playerA) ?? 0) + 1);
            if (match.playerB === null) byesThisRound++;
            else seen.set(match.playerB, (seen.get(match.playerB) ?? 0) + 1);
        }

        check(byesThisRound <= 1, "at most one bye per round",
            `round ${round} had ${byesThisRound} (seed ${seed}, ${playerCount}p)`);

        for (const mn of activeBefore) {
            check(seen.get(mn) === 1, "every active player appears exactly once",
                `#${mn} appeared ${seen.get(mn) ?? 0}x in round ${round} (seed ${seed})`);
        }
        for (const mn of seen.keys()) {
            check(activeBefore.includes(mn), "only active players are paired",
                `#${mn} was paired but is not active (seed ${seed})`);
        }
        for (const match of matches) {
            check(match.playerA !== match.playerB, "nobody is paired against themselves",
                `#${match.playerA} in ${match.id} (seed ${seed})`);
        }

        outcome.byes += byesThisRound;

        // ---- play and resolve ----
        for (const match of matches) {
            recordPairing(state, match);
            playMatch(match, rng);
            state.matches.push(match);

            const result = resolveMatch(match, GAMES_PER_MATCH, true);
            if (result === null) {
                // Points, rolls and time all identical — the admin-review path.
                outcome.unresolvable++;
                continue;
            }
            match.result = result;
            if (result.decidedBy === "double-forfeit") outcome.doubleForfeits++;
            if (result.decidedBy === "time") outcome.decidedByTime++;
            if (result.decidedBy === "bye") {
                const player = state.players.find(p => p.memberNumber === match.playerA);
                if (player) player.byesUsed++;
            }

            applyResult(state, match, result);
        }

        // ---- record invariants ----
        for (const player of state.players) {
            check(player.losses <= 2 || player.eliminated,
                "a player past 2 losses is eliminated",
                `#${player.memberNumber} has ${player.losses} losses, eliminated=${player.eliminated} (seed ${seed})`);
            check(!(isActive(player) && player.losses >= 2),
                "no active player has 2+ losses",
                `#${player.memberNumber} (seed ${seed})`);
        }

        // Optional withdrawal between rounds, to exercise field collapse.
        if (allowWithdrawals && rng() < 0.05) {
            const candidates = activePlayers(state);
            if (candidates.length > 2) {
                candidates[Math.floor(rng() * candidates.length)].withdrew = true;
            }
        }

        outcome.rounds = round;

        const after = evaluateField(state);
        if (after.kind === "decided") {
            outcome.champion = after.champion;
            outcome.runnerUp = after.runnerUp;
            break;
        }
        if (after.kind === "empty") break;
    }

    check(outcome.rounds < MAX_ROUNDS, "tournament terminates",
        `${playerCount}p seed ${seed} still running after ${MAX_ROUNDS} rounds`);

    return outcome;
}

// ---- duration parser checks ---------------------------------------------

function testDurations(): void {
    console.log("\nDuration parsing");
    const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

    const cases: [string, number | null][] = [
        ["1 hour", HOUR],
        ["48 hours", 48 * HOUR],
        ["3 days", 3 * DAY],
        ["1 week", 7 * DAY],
        ["90 minutes", 90 * MIN],
        ["15", 15 * MIN],              // bare number = minutes
        ["36h", 36 * HOUR],
        ["2d", 2 * DAY],
        ["90m", 90 * MIN],
        ["1 day 12 hours", DAY + 12 * HOUR],
        ["2 days from now", 2 * DAY],  // "from now" ignored
        ["1 hr", HOUR],
        ["45 mins", 45 * MIN],
        ["", null],
        ["soon", null],
        ["3 fortnights", null],        // unknown unit rejected, not guessed
    ];

    for (const [input, expected] of cases) {
        const actual = parseDuration(input);
        check(actual === expected, `parseDuration("${input}")`,
            `expected ${expected}, got ${actual}`);
    }

    // parseWhen: durations are relative, ISO dates absolute, "now" is now.
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    check(parseWhen("now", base) === base, 'parseWhen("now")');
    check(parseWhen("3 days", base) === base + 3 * DAY, 'parseWhen("3 days")');
    check(parseWhen("2026-08-10", base) === Date.parse("2026-08-10T00:00:00.000Z"), 'parseWhen("2026-08-10")');
    check(parseWhen("garbage", base) === null, 'parseWhen("garbage")');

    check(formatDuration(HOUR) === "1 hour", "formatDuration(1h)", formatDuration(HOUR));
    check(formatDuration(15 * MIN) === "15 minutes", "formatDuration(15m)", formatDuration(15 * MIN));
    check(formatDuration(DAY + 3 * HOUR) === "1 day 3 hours", "formatDuration(1d3h)", formatDuration(DAY + 3 * HOUR));
    console.log(`  ${cases.length + 7} assertions`);
}

// ---- match resolution checks --------------------------------------------

function testMatchResolution(): void {
    console.log("\nMatch resolution");

    const game = (score: number, minutes: number): TournamentGameResult =>
        ({ score, durationMs: minutes * 60 * 1000, playedAt: "2026-08-08T12:00:00.000Z" });

    const match = (gamesA: TournamentGameResult[], gamesB: TournamentGameResult[]): TournamentMatch =>
        ({ id: "t", round: 2, playerA: 1, playerB: 2, gamesA, gamesB,
           result: null, disputed: false, disputeReason: null, adminResolution: null });

    // Clear win on points.
    let r = resolveMatch(match([game(20, 5), game(20, 5), game(20, 5)],
                               [game(10, 5), game(10, 5), game(10, 5)]), 3, true)!;
    check(r.winner === 1 && r.decidedBy === "points", "higher scores win on points", r?.decidedBy);

    // Points tied 1.5-1.5, total rolls decide.
    r = resolveMatch(match([game(30, 5), game(1, 5), game(10, 5)],
                           [game(1, 5), game(30, 5), game(11, 5)]), 3, true)!;
    check(r.decidedBy === "points" || r.decidedBy === "rolls", "split match resolves", r?.decidedBy);

    // Identical scores every game → points tie AND rolls tie → time decides.
    r = resolveMatch(match([game(10, 4), game(20, 4), game(30, 4)],
                           [game(10, 9), game(20, 9), game(30, 9)]), 3, true)!;
    check(r.decidedBy === "time" && r.winner === 1, "fastest wins the hidden tiebreaker", r?.decidedBy);

    // Dead heat on everything → unresolvable, goes to admin.
    const dead = resolveMatch(match([game(10, 5), game(20, 5), game(30, 5)],
                                    [game(10, 5), game(20, 5), game(30, 5)]), 3, true);
    check(dead === null, "total dead heat returns null for admin review");

    // One side never played → forfeit.
    r = resolveMatch(match([game(10, 5), game(10, 5), game(10, 5)], []), 3, true)!;
    check(r.winner === 1 && r.decidedBy === "forfeit", "no-show opponent forfeits", r?.decidedBy);

    // Neither played → double forfeit, both lose.
    r = resolveMatch(match([], []), 3, true)!;
    check(r.decidedBy === "double-forfeit", "double no-show is a double forfeit", r?.decidedBy);

    const state = makeState(2);
    const m = match([], []);
    m.playerA = state.players[0].memberNumber;
    m.playerB = state.players[1].memberNumber;
    applyResult(state, m, r);
    check(state.players[0].losses === 1 && state.players[1].losses === 1,
        "double forfeit credits a loss to BOTH players",
        `${state.players[0].losses}/${state.players[1].losses}`);

    // Partly played vs fully played.
    r = resolveMatch(match([game(50, 5)], [game(10, 5), game(10, 5), game(10, 5)]), 3, true)!;
    check(r.winner === 2, "unplayed games score as losses", `winner ${r?.winner}`);

    // Bye.
    const byeMatch = match([], []);
    byeMatch.playerB = null;
    r = resolveMatch(byeMatch, 3, true)!;
    check(r.winner === 1 && r.decidedBy === "bye", "bye is an automatic win", r?.decidedBy);

    // Incomplete match, round still open → not resolved yet.
    check(resolveMatch(match([game(10, 5)], []), 3, false) === null,
        "incomplete match stays unresolved while the round is open");

    console.log("  11 assertions");
}

// ---- punishment checks ---------------------------------------------------

function testPunishment(): void {
    console.log("\nPunishment scaling");
    const state = makeState(6);

    check(punishmentForLoss(state, 1, 1) === 0, "round 1 is a grace round (first loss)");
    check(punishmentForLoss(state, 2, 1) === 0, "round 1 is a grace round (elimination)");
    check(punishmentForLoss(state, 1, 2) === state.config.firstLossPunishMs,
        "first loss from round 2 costs the configured first-loss time");
    check(punishmentForLoss(state, 2, 3) === state.config.eliminationPunishMs,
        "an eliminating loss costs the configured elimination time");

    // Grace rounds are configurable, including "no grace at all".
    state.config.graceRounds = 0;
    check(punishmentForLoss(state, 1, 1) === state.config.firstLossPunishMs,
        "graceRounds=0 punishes from round 1");
    console.log("  5 assertions");
}

// ---- setup interview + registration -------------------------------------

// Minimal stand-in for GameHost so the manager can be driven without a bot,
// a room, or touching tournament.json. Records everything it was told to say
// so the interview's behaviour can be asserted.
function makeStubHost(adminNumbers: number[], friends: Set<number> = new Set()) {
    const said: string[] = [];
    let saved: TournamentState | null = null;

    const host: any = {
        bot: {
            whisper: (_mn: number, text: string) => said.push(text),
            sendChat: (text: string) => said.push(`[chat] ${text}`),
            beep: (_mn: number, text: string) => said.push(`[beep] ${text}`),
            // Empty `friends` means "friends with everyone" so existing tests
            // keep their old behaviour; pass a set to exercise the friend gate.
            isFriend: (mn: number) => friends.size === 0 || friends.has(mn),
            getMemberNumber: () => 1,
        },
        storage: {
            loadTournament: () => saved,
            saveTournament: (s: TournamentState) => { saved = s; },
            archiveTournament: () => { saved = null; },
            appendTournamentLog: () => { /* no-op */ },
        },
        sendLongWhisper: (_mn: number, text: string) => said.push(text),
        isAdmin: (mn: number) => adminNumbers.includes(mn),
        requireAdmin: (mn: number) => adminNumbers.includes(mn),
        isInRoom: () => true,
        getRoomMembers: () => adminNumbers,
        getPlayerName: (mn: number) => `Player${mn}`,
        getNameFor: (mn: number) => `Player${mn}`,
    };

    return { host, said, getSaved: () => saved };
}

function testSetupInterview(): void {
    console.log("\nSetup interview & registration");
    const ADMIN = 999;
    const { host, said, getSaved } = makeStubHost([ADMIN]);
    const manager = new TournamentManager(host);

    manager.handleSetup(ADMIN);
    check(manager.isSettingUp(ADMIN), "setup starts for the admin");
    check(!manager.isSettingUp(1234), "setup is scoped to the admin who started it");

    // A non-admin cannot start one.
    const { host: host2 } = makeStubHost([ADMIN]);
    const manager2 = new TournamentManager(host2);
    manager2.handleSetup(1234);
    check(!manager2.isSettingUp(1234), "non-admins cannot start setup");

    // Walk the interview with short, test-run style values.
    // Order: reg opens, sign-up length, round 1 start, round length,
    //        first-loss punish, elimination punish, grace rounds, withdrawals.
    const answers = ["now", "2 hours", "2 hours", "1 hour", "5 minutes", "15 minutes", "0", "yes"];
    for (const answer of answers) {
        const consumed = manager.handleSetupAnswer(ADMIN, answer);
        check(consumed, `answer "${answer}" consumed`);
    }
    check(getSaved() === null, "nothing is saved until the summary is confirmed");

    // Confirm.
    manager.handleSetupAnswer(ADMIN, "yes");
    const state = getSaved();
    check(state !== null, "confirming creates the tournament");
    check(state?.status === "registration", "new tournament opens in registration", state?.status);
    check(state?.config.roundLengthMs === 60 * 60 * 1000, "1-hour rounds stored exactly",
        String(state?.config.roundLengthMs));
    check(state?.config.firstLossPunishMs === 5 * 60 * 1000, "5-minute first-loss punishment stored",
        String(state?.config.firstLossPunishMs));
    check(state?.config.eliminationPunishMs === 15 * 60 * 1000, "15-minute elimination punishment stored",
        String(state?.config.eliminationPunishMs));
    check(state?.config.allowsWithdrawal === true, "withdrawal answer stored");
    check(state?.config.graceRounds === 0, "grace rounds configurable to zero",
        String(state?.config.graceRounds));
    check(!manager.isSettingUp(ADMIN), "setup ends after creation");

    // Bad input is rejected and re-asked rather than guessed at.
    const { host: host3, getSaved: getSaved3 } = makeStubHost([ADMIN]);
    const manager3 = new TournamentManager(host3);
    manager3.handleSetup(ADMIN);
    manager3.handleSetupAnswer(ADMIN, "sometime next week-ish");
    check(manager3.isSettingUp(ADMIN), "unparseable answer keeps the interview open");
    manager3.handleSetupAnswer(ADMIN, "cancel");
    check(!manager3.isSettingUp(ADMIN), "'cancel' aborts the interview");
    check(getSaved3() === null, "cancelling creates nothing");

    // Registration.
    said.length = 0;
    manager.handleRegister(101, "Alice");
    manager.handleRegister(102, "Bella");
    manager.handleRegister(101, "Alice");  // duplicate
    const registered = getSaved()!.players;
    check(registered.length === 2, "duplicate registration is ignored", `${registered.length} players`);
    check(registered[0].punishMsRemaining === 0 && registered[0].serving === false,
        "new registrants start with no punishment owed");

    // Withdrawing during registration removes them outright.
    manager.handleWithdraw(102);
    check(getSaved()!.players.length === 1, "withdrawing during registration un-registers",
        `${getSaved()!.players.length} players`);

    check(manager.punishMsFor(101) === 0, "no punishment owed before playing");

    // ---- friend-gated registration ----
    // Registration must not complete until the mutual friend link exists,
    // because rounds run for hours and an unreachable player misses theirs.
    const friends = new Set<number>([ADMIN]);
    const { host: fHost, getSaved: fSaved } = makeStubHost([ADMIN], friends);
    const fManager = new TournamentManager(fHost);
    fManager.handleSetup(ADMIN);
    for (const answer of ["now", "2 hours", "2 hours", "1 hour", "5 minutes", "15 minutes", "1", "yes"]) {
        fManager.handleSetupAnswer(ADMIN, answer);
    }
    fManager.handleSetupAnswer(ADMIN, "yes");

    fManager.handleRegister(201, "Cara");
    check(fSaved()!.players.length === 0, "registration is held until the friend link exists",
        `${fSaved()!.players.length} players`);

    // Player adds the bot; the bot adds back and the registration completes.
    friends.add(201);
    fManager.onFriendAdded(201, "Cara");
    check(fSaved()!.players.length === 1, "friending completes the pending registration",
        `${fSaved()!.players.length} players`);
    check(fSaved()!.players[0].name === "Cara", "the pending registrant's name is kept");

    // A friend event for someone who never registered must do nothing.
    friends.add(202);
    fManager.onFriendAdded(202, "Dana");
    check(fSaved()!.players.length === 1, "friending alone does not register anyone",
        `${fSaved()!.players.length} players`);

    // Already-friended players skip the handshake entirely.
    friends.add(203);
    fManager.handleRegister(203, "Elle");
    check(fSaved()!.players.length === 2, "already-friended players register immediately",
        `${fSaved()!.players.length} players`);

    console.log("  30 assertions");
}

// ---- end-to-end through the real manager --------------------------------

// Drives TournamentManager the way the bot does — setup, register, schedule
// tick, !tournament play, score reports — so the wiring between the manager,
// the solo bridge and the bracket logic is exercised, not just the maths.
function testEndToEnd(): void {
    console.log("\nEnd-to-end tournament");
    const ADMIN = 999;
    const { host, getSaved, said } = makeStubHost([ADMIN]);

    // Capture what the manager asks the solo game to start, and let the test
    // "play" it by feeding a score straight back.
    let lastCtx: any = null;
    let startCalls = 0;
    host.startTournamentGame = (_mn: number, _name: string, ctx: any) => {
        lastCtx = ctx; startCalls++; return null;
    };
    host.reportTournamentGame = () => { /* the test calls recordGameResult itself */ };

    const manager = new TournamentManager(host);
    manager.handleSetup(ADMIN);
    // Registration opens now, closes immediately, round 1 starts immediately,
    // 1-hour rounds, no grace round so punishment is exercised from round 1.
    for (const a of ["now", "1 minute", "1 minute", "1 hour", "5 minutes", "15 minutes", "0", "yes"]) {
        manager.handleSetupAnswer(ADMIN, a);
    }
    manager.handleSetupAnswer(ADMIN, "yes");

    const players = [[301, "Ana"], [302, "Bo"], [303, "Cy"], [304, "Di"]] as [number, string][];
    for (const [mn, name] of players) manager.handleRegister(mn, name);
    check(getSaved()!.players.length === 4, "four players registered");

    // Playing before the round starts must be refused.
    manager.handlePlay(301, "Ana");
    check(startCalls === 0, "cannot play before Round 1 starts", `${startCalls} starts`);

    // Advance past sign-up close + round 1 start.
    const afterStart = Date.now() + 2 * 60 * 1000;
    manager.checkSchedule(afterStart);
    let state = getSaved()!;
    check(state.status === "active", "tournament becomes active", state.status);
    check(state.currentRound === 1, "round 1 started", String(state.currentRound));
    check(state.matches.filter(m => m.round === 1).length === 2, "4 players → 2 matches",
        String(state.matches.filter(m => m.round === 1).length));

    // Someone not registered can't play.
    manager.handlePlay(888, "Nobody");
    check(startCalls === 0, "unregistered player cannot play");

    // A registered player can, and gets the right context.
    manager.handlePlay(301, "Ana");
    check(startCalls === 1, "registered player starts a game");
    check(lastCtx?.requiredClothing === 6, "clothing count comes from config", String(lastCtx?.requiredClothing));
    check(lastCtx?.gameNumber === 1, "first game is game 1", String(lastCtx?.gameNumber));
    check(lastCtx?.allowBondage === false, "bondage suppressed for tournament games");
    check(lastCtx?.totalGames === 3, "three games per match", String(lastCtx?.totalGames));

    // Play out round 1: player A of each match scores well, player B badly.
    for (const match of getSaved()!.matches.filter(m => m.round === 1 && m.playerB !== null)) {
        for (let g = 0; g < 3; g++) manager.recordGameResult(match.playerA, 30, 60_000);
        for (let g = 0; g < 3; g++) manager.recordGameResult(match.playerB!, 10, 60_000);
    }

    state = getSaved()!;
    const r1 = state.matches.filter(m => m.round === 1);
    check(r1.every(m => m.result !== null), "all round 1 matches resolved once both sides finish");
    check(r1.every(m => m.result!.winner === m.playerA), "higher scores won", "unexpected winner");

    // Extra reports after a match is complete must be ignored, not appended.
    const before = r1[0].gamesA.length;
    manager.recordGameResult(r1[0].playerA, 99, 1000);
    check(getSaved()!.matches.filter(m => m.round === 1)[0].gamesA.length === before,
        "scores are ignored once the match is done");

    // Losers should owe punishment (grace rounds are 0 here). Punishment is
    // credited at round finalisation, so tick the deadline first.
    manager.checkSchedule(afterStart + 61 * 60 * 1000);
    state = getSaved()!;
    const losers = r1.map(m => m.result!.loser!).filter(n => n !== null);
    for (const mn of losers) {
        const p = state.players.find(pp => pp.memberNumber === mn)!;
        check(p.punishMsRemaining === 5 * 60 * 1000,
            `loser #${mn} owes the configured first-loss time`, `${p.punishMsRemaining}ms`);
    }
    check(state.currentRound === 2, "round 2 started after the deadline", String(state.currentRound));

    // Owing punishment blocks play.
    startCalls = 0;
    manager.handlePlay(losers[0], "loser");
    check(startCalls === 0, "a player owing punishment time cannot play");
    check(manager.punishMsFor(losers[0]) === 5 * 60 * 1000, "punishMsFor reports the debt");

    // ---- serving the punishment ----
    const convict = losers[0];
    let bound = 0, released = 0;
    host.applyTournamentPunishment = () => { bound++; };
    host.releaseTournamentPunishment = () => { released++; };

    // Entering the room must ASK, never bind unasked.
    manager.onEnterRoom(convict);
    check(bound === 0, "entering the room does not bind anyone automatically", `${bound} binds`);

    // Declining leaves the debt intact.
    manager.tryHandleServePrompt(convict, "no");
    check(bound === 0, "declining the prompt doesn't bind");
    check(manager.punishMsFor(convict) === 5 * 60 * 1000, "declining keeps the full debt");

    // Accepting binds and starts the clock.
    manager.onEnterRoom(convict);
    const accepted = manager.tryHandleServePrompt(convict, "yes");
    check(accepted, "yes is consumed by the serve prompt");
    check(bound === 1, "accepting binds the player", `${bound} binds`);
    check(getSaved()!.players.find(p => p.memberNumber === convict)!.serving === true, "player is marked serving");

    // Stopping banks the remainder and releases.
    manager.handleStop(convict);
    const afterStop = getSaved()!.players.find(p => p.memberNumber === convict)!;
    check(afterStop.serving === false, "stopping clears the serving flag");
    check(released === 1, "stopping releases the bondage", `${released} releases`);
    check(afterStop.punishMsRemaining > 0 && afterStop.punishMsRemaining <= 5 * 60 * 1000,
        "stopping banks the remaining time", `${afterStop.punishMsRemaining}ms`);

    // A short disconnect must NOT pause the sentence — a dropped connection
    // shouldn't add to someone's time.
    manager.handleServe(convict);
    check(getSaved()!.players.find(p => p.memberNumber === convict)!.serving === true, "serve resumes after a stop");
    manager.onLeaveRoom(convict);
    let p = getSaved()!.players.find(pp => pp.memberNumber === convict)!;
    check(p.serving === true, "a disconnect does not stop the clock");
    check(p.disconnectedAt !== null, "the disconnect moment is recorded");

    // Coming back inside the window: clock never paused, marker cleared.
    manager.onEnterRoom(convict);
    p = getSaved()!.players.find(pp => pp.memberNumber === convict)!;
    check(p.serving === true && p.disconnectedAt === null,
        "returning in time resumes seamlessly with the clock still running");

    // Not coming back: the sentence pauses retroactively as of the disconnect,
    // so the grace window can't be farmed by logging off.
    const beforeDebt = manager.punishMsFor(convict);
    manager.onLeaveRoom(convict);
    const disconnectMoment = Date.now();
    manager.checkSchedule(disconnectMoment + 11 * 60 * 1000);
    p = getSaved()!.players.find(pp => pp.memberNumber === convict)!;
    check(p.serving === false, "failing to return pauses the sentence");
    check(p.disconnectedAt === null, "disconnect marker cleared on pause");
    check(p.punishMsRemaining > 0, "time still owed after the pause", `${p.punishMsRemaining}ms`);
    check(p.punishMsRemaining >= beforeDebt - 60 * 1000,
        "the 10 minutes away were NOT credited as time served",
        `owed ${p.punishMsRemaining}ms vs ${beforeDebt}ms before`);

    // Only tournament players may claim.
    check(manager.canClaim(302) === true, "a tournament player can claim");
    check(manager.canClaim(888) === false, "someone outside the tournament cannot claim");

    // ---- claiming a prisoner ----
    let leashed = 0;
    host.attachTournamentLeash = () => { leashed++; };

    manager.handleServe(convict);
    const served = getSaved()!.players.find(p => p.memberNumber === convict)!;
    check(typeof served.lockPassword === "string" && served.lockPassword.length > 0,
        "serving generates a lock password to hand to a claimer");

    // Someone outside the tournament can't claim — tryHandleClaim declines so
    // game.ts falls through to its own end-game prize handling.
    check(manager.tryHandleClaim(888, "") === false, "a non-participant's !claim is not handled here");

    // A prisoner shows up as claimable to another player.
    const claimer = players.find(([mn]) => mn !== convict)![0];
    const listBefore = manager.claimablePrisoners(claimer);
    check(listBefore.some(p => p.memberNumber === convict), "a serving prisoner is claimable");
    check(!listBefore.some(p => p.memberNumber === claimer), "you never appear in your own claim list");

    // Claim them.
    check(manager.tryHandleClaim(claimer, "1") === true, "claiming by index is handled");
    const held = getSaved()!.players.find(p => p.memberNumber === convict)!;
    check(held.claimedBy === claimer, "the prisoner records who holds them", String(held.claimedBy));
    check(leashed === 1, "claiming attaches a leash", `${leashed} leashes`);
    check(manager.claimablePrisoners(claimer).length === 0, "an already-held prisoner drops off the list");

    // A claimer who leaves hands their prisoner back.
    manager.onAnyoneLeftRoom(claimer);
    check(getSaved()!.players.find(p => p.memberNumber === convict)!.claimedBy === null,
        "a departing claimer releases their prisoner");

    // Serving their own sentence blocks claiming.
    check(manager.tryHandleClaim(convict, "") === true, "a serving prisoner's !claim is intercepted");
    check(manager.claimablePrisoners(convict).length === 0, "a serving player is offered nobody");

    // Finishing the sentence clears password and claim together.
    manager.tryHandleClaim(claimer, "1");
    manager.handleStop(convict);
    const freed = getSaved()!.players.find(p => p.memberNumber === convict)!;
    check(freed.claimedBy === null && freed.lockPassword === null,
        "stopping clears both the claim and the password");

    // ---- round status on entry ----
    // Someone with a live match should be told where they stand when they walk
    // in, since an async format means they'd otherwise never see it happen.
    const idle = players.map(([mn]) => mn).find(mn => {
        const p = getSaved()!.players.find(pp => pp.memberNumber === mn)!;
        return !p.eliminated && !p.withdrew && p.punishMsRemaining === 0;
    })!;
    said.length = 0;
    manager.onEnterRoom(idle);
    const gotStatus = said.some(s => s.includes("Tournament — Round"));
    check(gotStatus, "entering the room whispers your round status");

    // Bouncing straight back in must not re-whisper.
    said.length = 0;
    manager.onEnterRoom(idle);
    check(!said.some(s => s.includes("Tournament — Round")),
        "re-entering within the cooldown does not repeat the status");

    // Someone who owes punishment gets the serve prompt instead — that
    // conversation takes priority and already states the debt.
    said.length = 0;
    manager.onEnterRoom(convict);
    check(!said.some(s => s.includes("Tournament — Round")),
        "a player owing punishment gets the serve prompt, not a status dump");

    console.log("  53 assertions");
}

// ---- main ----------------------------------------------------------------

function main(): void {
    console.log("=== StripDiceBot tournament simulation ===");

    testDurations();
    testMatchResolution();
    testPunishment();
    testSetupInterview();
    testEndToEnd();

    console.log("\nFull tournaments");
    const fieldSizes = [2, 3, 4, 5, 6, 7, 8, 11, 16, 23, 32];
    const seedsPerSize = 60;

    let totals = { rounds: 0, byes: 0, doubleForfeits: 0, decidedByTime: 0, unresolvable: 0, champions: 0, runs: 0 };

    for (const size of fieldSizes) {
        for (let seed = 1; seed <= seedsPerSize; seed++) {
            const outcome = runTournament(size, seed * 7919 + size, seed % 3 === 0);
            totals.runs++;
            totals.rounds += outcome.rounds;
            totals.byes += outcome.byes;
            totals.doubleForfeits += outcome.doubleForfeits;
            totals.decidedByTime += outcome.decidedByTime;
            totals.unresolvable += outcome.unresolvable;
            if (outcome.champion !== null) totals.champions++;
        }
    }

    console.log(`  ${totals.runs} tournaments across field sizes ${fieldSizes.join(", ")}`);
    console.log(`  produced a champion: ${totals.champions}/${totals.runs}`);
    console.log(`  average rounds: ${(totals.rounds / totals.runs).toFixed(1)}`);
    console.log(`  byes awarded: ${totals.byes}`);
    console.log(`  double forfeits: ${totals.doubleForfeits}`);
    console.log(`  decided by hidden time tiebreaker: ${totals.decidedByTime}`);
    console.log(`  needed admin review (total dead heat): ${totals.unresolvable}`);

    // A tournament that never crowns anyone means the field emptied — possible
    // with double forfeits, but it should be rare rather than routine.
    const championRate = totals.champions / totals.runs;
    check(championRate > 0.8, "most tournaments produce a champion",
        `only ${(championRate * 100).toFixed(1)}% did`);

    console.log(
        failures === 0
            ? "\nAll invariants held.\n"
            : `\n${failures} FAILURE(S).\n`
    );
    process.exit(failures === 0 ? 0 : 1);
}

main();
