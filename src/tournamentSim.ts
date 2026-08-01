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

// ---- main ----------------------------------------------------------------

function main(): void {
    console.log("=== StripDiceBot tournament simulation ===");

    testDurations();
    testMatchResolution();
    testPunishment();

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
