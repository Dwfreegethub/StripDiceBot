// ============================================================
// TOURNAMENT LOGIC - pure functions for Swiss pairing, match
// resolution, standings and field-collapse detection.
//
// Deliberately free of I/O, BC calls, timers and Date.now(): a
// tournament runs for days or weeks, so this logic can never be
// validated by playing one. Keeping it pure lets tournamentSim.ts
// run thousands of tournaments offline in a second. Anything that
// needs the clock, the room, or the bot takes it as a parameter.
//
// Never import connection/game/host from here.
// ============================================================
import {
    TournamentGameResult, TournamentMatch, TournamentMatchResult,
    TournamentPlayer, TournamentState,
} from "./types";

// A player is out once eliminated (2 losses) or withdrawn.
export function isActive(player: TournamentPlayer): boolean {
    return !player.eliminated && !player.withdrew;
}

export function activePlayers(state: TournamentState): TournamentPlayer[] {
    return state.players.filter(isActive);
}

export function findPlayer(state: TournamentState, memberNumber: number): TournamentPlayer | undefined {
    return state.players.find(p => p.memberNumber === memberNumber);
}

// ============================================================
// MATCH RESOLUTION
// ============================================================

// Per-game points: win 1, draw ½, loss 0. A game the opponent played and you
// did not is their win — that is how "unplayed games score as losses" and the
// "you played, they didn't" forfeit rule both fall out of one loop.
function gamePoints(a: TournamentGameResult | undefined, b: TournamentGameResult | undefined): [number, number] {
    if (a && b) {
        if (a.score > b.score) return [1, 0];
        if (b.score > a.score) return [0, 1];
        return [0.5, 0.5];
    }
    if (a && !b) return [1, 0];
    if (!a && b) return [0, 1];
    return [0, 0]; // neither played this game
}

function totalRolls(games: TournamentGameResult[]): number {
    return games.reduce((sum, g) => sum + g.score, 0);
}

// Total elapsed time across a player's games — the hidden tiebreaker, fastest
// wins. A player who played fewer games than required cannot win on time
// (Infinity), otherwise skipping games would look "fast".
function totalTime(games: TournamentGameResult[], gamesPerMatch: number): number {
    if (games.length < gamesPerMatch) return Infinity;
    return games.reduce((sum, g) => sum + g.durationMs, 0);
}

// Resolves a match from whatever games were actually played. Returns null only
// if the match still has games outstanding AND the round is not over — callers
// pass `final: true` once the round deadline passes to force resolution,
// scoring unplayed games as losses.
export function resolveMatch(match: TournamentMatch, gamesPerMatch: number, final: boolean): TournamentMatchResult | null {
    // Bye: automatic win, no games, contributes nothing to tiebreakers.
    if (match.playerB === null) {
        return { winner: match.playerA, loser: null, pointsA: 0, pointsB: 0, decidedBy: "bye" };
    }

    const complete = match.gamesA.length >= gamesPerMatch && match.gamesB.length >= gamesPerMatch;
    if (!complete && !final) return null;

    let pointsA = 0;
    let pointsB = 0;
    for (let i = 0; i < gamesPerMatch; i++) {
        const [a, b] = gamePoints(match.gamesA[i], match.gamesB[i]);
        pointsA += a;
        pointsB += b;
    }

    // Neither player showed up at all — both take a loss.
    if (match.gamesA.length === 0 && match.gamesB.length === 0) {
        return { winner: null, loser: null, pointsA, pointsB, decidedBy: "double-forfeit" };
    }

    // One side played nothing: a forfeit rather than a contest on points.
    const forfeit = match.gamesA.length === 0 || match.gamesB.length === 0;

    if (pointsA !== pointsB) {
        const aWins = pointsA > pointsB;
        return {
            winner: aWins ? match.playerA : match.playerB,
            loser: aWins ? match.playerB : match.playerA,
            pointsA, pointsB,
            decidedBy: forfeit ? "forfeit" : "points",
        };
    }

    // Tiebreaker 1: total rolls survived, higher wins.
    const rollsA = totalRolls(match.gamesA);
    const rollsB = totalRolls(match.gamesB);
    if (rollsA !== rollsB) {
        const aWins = rollsA > rollsB;
        return {
            winner: aWins ? match.playerA : match.playerB,
            loser: aWins ? match.playerB : match.playerA,
            pointsA, pointsB,
            decidedBy: "rolls",
        };
    }

    // Tiebreaker 2 (hidden): total elapsed time, fastest wins.
    const timeA = totalTime(match.gamesA, gamesPerMatch);
    const timeB = totalTime(match.gamesB, gamesPerMatch);
    if (timeA !== timeB) {
        const aWins = timeA < timeB;
        return {
            winner: aWins ? match.playerA : match.playerB,
            loser: aWins ? match.playerB : match.playerA,
            pointsA, pointsB,
            decidedBy: "time",
        };
    }

    // Points, rolls and elapsed time all identical — vanishingly unlikely, and
    // genuinely undecidable by any rule we have. Hand it to the admin rather
    // than flipping a coin behind the players' backs.
    return null;
}

// Applies a resolved result to the players' records. Takes the match as well
// as the result because a double forfeit has no winner or loser to read the
// participants from — both players take a loss and neither is named in the
// result. Returns the member numbers newly eliminated, so callers can announce.
export function applyResult(
    state: TournamentState,
    match: TournamentMatch,
    result: TournamentMatchResult,
    lossesToEliminate: number = 2,
): number[] {
    const credit = (memberNumber: number, won: boolean) => {
        const player = findPlayer(state, memberNumber);
        if (!player) return;
        if (won) player.wins++;
        else player.losses++;
    };

    if (result.decidedBy === "double-forfeit") {
        credit(match.playerA, false);
        if (match.playerB !== null) credit(match.playerB, false);
    } else {
        if (result.winner !== null) credit(result.winner, true);
        if (result.loser !== null) credit(result.loser, false);
    }

    const newlyEliminated: number[] = [];
    for (const player of state.players) {
        if (!player.eliminated && !player.withdrew && player.losses >= lossesToEliminate) {
            player.eliminated = true;
            newlyEliminated.push(player.memberNumber);
        }
    }
    return newlyEliminated;
}

// ============================================================
// STANDINGS
// ============================================================

// Ranking order: most wins, then fewest losses, then most total rolls across
// the tournament (a soft strength signal), then member number for stability.
// Deterministic on purpose — the simulator depends on it.
export function rankPlayers(state: TournamentState, players: TournamentPlayer[]): TournamentPlayer[] {
    const rollTotals = new Map<number, number>();
    for (const player of players) {
        let total = 0;
        for (const match of state.matches) {
            if (match.playerA === player.memberNumber) total += totalRolls(match.gamesA);
            else if (match.playerB === player.memberNumber) total += totalRolls(match.gamesB);
        }
        rollTotals.set(player.memberNumber, total);
    }

    return [...players].sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (a.losses !== b.losses) return a.losses - b.losses;
        const rollDiff = (rollTotals.get(b.memberNumber) ?? 0) - (rollTotals.get(a.memberNumber) ?? 0);
        if (rollDiff !== 0) return rollDiff;
        return a.memberNumber - b.memberNumber;
    });
}

// ============================================================
// SWISS PAIRING
// ============================================================

// Pairs the active field for `round`.
//
// Deviation from the original design doc, deliberate: the doc said an odd
// *record group* gives someone a bye. That would hand out several byes in one
// round (6 players split 3/3 after round 1 = two free wins), so instead the
// field is ranked, players float down between record groups, and a bye is only
// created when the TOTAL active count is odd — standard Swiss behaviour.
//
// Bye recipient follows the doc: highest-ranked player who has not had one yet
// (fewest byes wins the tie), which keeps it deterministic instead of random.
export function pairRound(state: TournamentState, round: number): TournamentMatch[] {
    const active = rankPlayers(state, activePlayers(state));
    if (active.length === 0) return [];

    const matches: TournamentMatch[] = [];
    const pool = [...active];
    let matchIndex = 1;
    const nextId = () => `r${round}-m${matchIndex++}`;

    // Single player left standing — nothing to pair against.
    if (pool.length === 1) {
        matches.push(newMatch(nextId(), round, pool[0].memberNumber, null));
        return matches;
    }

    if (pool.length % 2 === 1) {
        const fewestByes = Math.min(...pool.map(p => p.byesUsed));
        const byeIndex = pool.findIndex(p => p.byesUsed === fewestByes);
        const [byePlayer] = pool.splice(byeIndex, 1);
        matches.push(newMatch(nextId(), round, byePlayer.memberNumber, null));
    }

    // Greedy pairing down the ranked list, preferring opponents this player
    // has not already faced. Falls back to a rematch rather than failing to
    // pair — a small field runs out of fresh opponents quickly.
    while (pool.length >= 2) {
        const player = pool.shift()!;
        let opponentIndex = pool.findIndex(p => !player.opponents.includes(p.memberNumber));
        if (opponentIndex === -1) opponentIndex = 0;
        const [opponent] = pool.splice(opponentIndex, 1);
        matches.push(newMatch(nextId(), round, player.memberNumber, opponent.memberNumber));
    }

    return matches;
}

function newMatch(id: string, round: number, playerA: number, playerB: number | null): TournamentMatch {
    return {
        id, round, playerA, playerB,
        gamesA: [], gamesB: [],
        result: null,
        disputed: false,
        disputeReason: null,
        adminResolution: null,
    };
}

// Records that two players have met, so later rounds can avoid a rematch.
export function recordPairing(state: TournamentState, match: TournamentMatch): void {
    if (match.playerB === null) return;
    const a = findPlayer(state, match.playerA);
    const b = findPlayer(state, match.playerB);
    if (a && !a.opponents.includes(match.playerB)) a.opponents.push(match.playerB);
    if (b && !b.opponents.includes(match.playerA)) b.opponents.push(match.playerA);
}

// ============================================================
// FIELD COLLAPSE / COMPLETION
// ============================================================

export type FieldStatus =
    | { kind: "continue" }
    | { kind: "final"; players: [number, number] }      // exactly 2 left — play the grand final
    | { kind: "decided"; champion: number; runnerUp: number | null } // mathematically over
    | { kind: "empty" };                                 // nobody left at all

// Decides whether the tournament should keep running, force a grand final, or
// award outright. Called after every round is resolved.
export function evaluateField(state: TournamentState): FieldStatus {
    const active = rankPlayers(state, activePlayers(state));

    if (active.length === 0) return { kind: "empty" };

    if (active.length === 1) {
        // Last player standing. Runner-up is the best of those knocked out.
        const eliminated = rankPlayers(state, state.players.filter(p => !isActive(p) && !p.withdrew));
        return {
            kind: "decided",
            champion: active[0].memberNumber,
            runnerUp: eliminated.length > 0 ? eliminated[0].memberNumber : null,
        };
    }

    if (active.length === 2) {
        return { kind: "final", players: [active[0].memberNumber, active[1].memberNumber] };
    }

    return { kind: "continue" };
}

// True once a round's matches all have results.
export function roundComplete(state: TournamentState, round: number): boolean {
    const matches = state.matches.filter(m => m.round === round);
    return matches.length > 0 && matches.every(m => m.result !== null);
}

// Games still owed by a player in the current round.
export function gamesRemaining(match: TournamentMatch, memberNumber: number, gamesPerMatch: number): number {
    if (match.playerB === null) return 0;
    const played = match.playerA === memberNumber ? match.gamesA.length
        : match.playerB === memberNumber ? match.gamesB.length
        : 0;
    return Math.max(0, gamesPerMatch - played);
}

// The player's match for a given round, if any.
export function matchFor(state: TournamentState, memberNumber: number, round: number): TournamentMatch | undefined {
    return state.matches.find(m =>
        m.round === round && (m.playerA === memberNumber || m.playerB === memberNumber));
}

// ============================================================
// PUNISHMENT
// ============================================================

// How much punishment a loss earns. Grace rounds are free for everyone; after
// that a first loss and an eliminating loss carry different weights.
export function punishmentForLoss(state: TournamentState, lossNumber: number, round: number): number {
    if (round <= state.config.graceRounds) return 0;
    if (lossNumber >= 2) return state.config.eliminationPunishMs;
    return state.config.firstLossPunishMs;
}

// Punishment time left for a player, counting any stretch currently being
// served. `now` is passed in so this stays pure and testable.
export function punishRemaining(player: TournamentPlayer, now: number): number {
    if (!player.serving || player.servingSince === null) return player.punishMsRemaining;
    const served = Math.max(0, now - player.servingSince);
    return Math.max(0, player.punishMsRemaining - served);
}
