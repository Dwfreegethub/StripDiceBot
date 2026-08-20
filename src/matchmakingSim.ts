// ============================================================
// MATCHMAKING SIMULATOR - dev harness, never run by the bot.
//
// The pool's rules only reveal themselves over hours of real play:
// a 30-minute cooldown, a 3-minute stay window, four strikes before
// a block. That's not something a live game can check, so this
// drives MatchmakingManager against a stub GameHost instead — no
// bot, no room, no registered_players.json.
//
//   npm run sim:mm
//
// Exits non-zero if any assertion fails, so it can gate a commit.
// ============================================================
import { MatchmakingManager } from "./matchmaking";
import { RegisteredPlayer } from "./types";

let failures = 0;
let assertions = 0;
function check(condition: boolean, label: string, detail?: unknown): void {
    assertions++;
    if (!condition) {
        failures++;
        console.error(`  FAIL: ${label}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`);
    }
}

// Minimal stand-in for GameHost. Records every whisper and beep so the
// manager's behaviour can be asserted from the outside, the way a player
// would experience it.
function makeStubHost(opts: {
    admins?: number[];
    friends?: Set<number>;
    online?: number[];
    room?: number[];
} = {}) {
    const admins = opts.admins ?? [];
    const friends = opts.friends ?? new Set<number>();
    const online = opts.online ?? [];
    let room = opts.room ?? [];

    const said: string[] = [];
    const beeps: { to: number; text: string }[] = [];
    let pool: Record<string, RegisteredPlayer> = {};

    const host: any = {
        bot: {
            whisper: (mn: number, text: string) => said.push(`<${mn}> ${text}`),
            sendChat: (text: string) => said.push(`[chat] ${text}`),
            beep: (mn: number, text: string) => beeps.push({ to: mn, text }),
            isFriend: (mn: number) => friends.has(mn),
            getMemberNumber: () => 1,
            queryOnlineFriends: async () => online.map(n => ({ MemberNumber: n, MemberName: `Player${n}` })),
        },
        storage: {
            loadRegisteredPlayers: () => pool,
            saveRegisteredPlayers: (p: Record<string, RegisteredPlayer>) => { pool = p; },
        },
        sendLongWhisper: (mn: number, text: string) => said.push(`<${mn}> ${text}`),
        isAdmin: (mn: number) => admins.includes(mn),
        requireAdmin: (mn: number) => admins.includes(mn),
        isInRoom: (mn: number) => room.includes(mn),
        getRoomMembers: () => room.slice(),
        getPlayerName: (mn: number) => `Player${mn}`,
        getNameFor: (mn: number) => `Player${mn}`,
    };

    return {
        host, said, beeps,
        pool: () => pool,
        setRoom: (r: number[]) => { room = r; },
        heard: (fragment: string) => said.some(s => s.includes(fragment)),
    };
}

// Real BC member numbers are five or six digits; the admin-target resolver
// only treats 3+ digit tokens as numbers, so the fixtures use realistic ones.
const ANN = 100010, BEA = 100020, CYD = 100030, DEE = 100040, ADMIN = 999999;

function testRegistration(): void {
    console.log("\nRegistration");
    const friends = new Set<number>();
    const stub = makeStubHost({ friends, room: [ANN] });
    const m = new MatchmakingManager(stub.host);

    m.handleCommand(ANN, "Ann", " register");
    check(!!stub.pool()[String(ANN)], "register adds a pool entry");
    check(m.isRegistered(ANN), "isRegistered reports the new entry");
    check(stub.heard("friend list"), "an unfriended registrant is asked to friend the bot");

    // The pool must never friend from its own side: everywhere else in the bot
    // isFriend() means "mutual", and tournament registration gates on it.
    check(!friends.has(ANN), "registering does not pre-friend the player");

    friends.add(ANN);
    const before = stub.said.length;
    m.onFriendAdded(ANN);
    check(stub.said.length === before + 1 && stub.said[stub.said.length - 1].includes("matchmaking live"),
        "completing the friend link confirms the pool is live");
    m.onFriendAdded(ANN);
    check(stub.said.length === before + 1, "the confirmation is sent only once");

    m.handleCommand(ANN, "Ann", " pause");
    check(stub.pool()[String(ANN)].paused, "pause sets paused");
    m.handleCommand(ANN, "Ann", " resume");
    check(!stub.pool()[String(ANN)].paused, "resume clears paused");

    m.handleCommand(ANN, "Ann", " pause");
    m.handleCommand(ANN, "Ann", " register");
    check(!stub.pool()[String(ANN)].paused, "re-registering un-pauses");

    m.handleCommand(ANN, "Ann", " unregister");
    check(!stub.pool()[String(ANN)], "unregister removes the entry");
    check(friends.has(ANN), "unregister does NOT unfriend — the friend link is a separate feature");
}

async function testLookingGates(): Promise<void> {
    console.log("\n!looking gates");

    {
        const stub = makeStubHost({ friends: new Set([ANN]), room: [ANN], online: [BEA] });
        const m = new MatchmakingManager(stub.host);
        await m.handleLooking(ANN, "Ann");
        check(stub.beeps.length === 0 && stub.heard("register first"), "unregistered players can't call it");
    }

    {
        const stub = makeStubHost({ friends: new Set([ANN]), room: [], online: [BEA] });
        const m = new MatchmakingManager(stub.host);
        m.handleCommand(ANN, "Ann", " register");
        await m.handleLooking(ANN, "Ann");
        check(stub.beeps.length === 0 && stub.heard("from inside the room"),
            "calling it from outside the room is refused");
    }

    {
        const stub = makeStubHost({ friends: new Set([ANN, BEA]), room: [ANN], online: [BEA] });
        const m = new MatchmakingManager(stub.host);
        m.handleCommand(ANN, "Ann", " register");
        m.handleCommand(ANN, "Ann", " pause");
        await m.handleLooking(ANN, "Ann");
        check(stub.beeps.length === 0 && stub.heard("You're paused"), "a paused player can't call it");
    }

    {
        const stub = makeStubHost({ friends: new Set([ANN]), room: [ANN], online: [] });
        const m = new MatchmakingManager(stub.host);
        m.handleCommand(ANN, "Ann", " register");
        await m.handleLooking(ANN, "Ann");
        check(stub.beeps.length === 0, "nobody online means no beeps");
        check(stub.heard("No registered players are online"), "the seeker is told the pool is empty right now");
        check(stub.pool()[String(ANN)].lookingCooldownUntil !== null,
            "the cooldown still starts — a quiet night is not a free retry loop");
    }
}

async function testBeepsAndRelay(): Promise<void> {
    console.log("\nBeeps, cooldown and the reply relay");
    const stub = makeStubHost({
        friends: new Set([ANN, BEA, CYD, DEE]),
        room: [ANN, DEE],
        online: [BEA, CYD, DEE],
    });
    const m = new MatchmakingManager(stub.host);
    m.handleCommand(ANN, "Ann", " register");
    m.handleCommand(BEA, "Bea", " register");
    m.handleCommand(CYD, "Cyd", " register");
    m.handleCommand(DEE, "Dee", " register");
    m.handleCommand(CYD, "Cyd", " pause");

    await m.handleLooking(ANN, "Ann");
    const targets = stub.beeps.map(b => b.to).sort((a, b) => a - b);
    check(JSON.stringify(targets) === JSON.stringify([BEA, DEE]),
        "beeps reach online, unpaused pool members — not the seeker, not the paused one", targets);
    check(stub.beeps[0].text.includes("Ann is at the Strip Dice room"), "the beep names the seeker");
    check(stub.beeps[0].text.includes("1 other player is already here"),
        "the beep says who is already in the room", stub.beeps[0].text);
    check(stub.pool()[String(ANN)].lookingCooldownUntil! > Date.now(), "the cooldown is stamped");

    const sentSoFar = stub.beeps.length;
    await m.handleLooking(ANN, "Ann");
    check(stub.beeps.length === sentSoFar, "a second call inside the cooldown sends nothing");
    check(stub.heard("try again in"), "the cooldown says how long is left");

    const saidSoFar = stub.said.length;
    check(m.onIncomingBeep(BEA, "Bea", "omw!"), "a reply from someone we beeped is consumed");
    check(stub.said.length === saidSoFar + 1, "exactly one relay message goes out");
    check(stub.said[stub.said.length - 1].includes(`<${ANN}>`) &&
        stub.said[stub.said.length - 1].includes("omw!"),
        "the reply is relayed to the seeker, in the room, as a whisper");

    check(!m.onIncomingBeep(BEA, "Bea", { GGC_BEEP: 1 } as any),
        "addon beeps (object payload) are ignored");
    check(!m.onIncomingBeep(123456, "Stranger", "hello"),
        "a beep from someone outside the call is not a reply");

    // Seeker has wandered off: the relay falls back to a beep.
    stub.setRoom([DEE]);
    const beepsSoFar = stub.beeps.length;
    check(m.onIncomingBeep(DEE, "Dee", "on my way"), "a second reply still relays");
    check(stub.beeps.length === beepsSoFar + 1 && stub.beeps[stub.beeps.length - 1].to === ANN,
        "a seeker who left the room gets the relay as a beep instead");
}

async function testStrikes(): Promise<void> {
    console.log("\nStrikes and blocking");
    const stub = makeStubHost({ friends: new Set([ANN, BEA]), room: [ANN], online: [BEA] });
    const m = new MatchmakingManager(stub.host);
    m.handleCommand(ANN, "Ann", " register");
    m.handleCommand(BEA, "Bea", " register");

    for (let i = 1; i <= 4; i++) {
        stub.pool()[String(ANN)].lookingCooldownUntil = null; // skip the 30-minute wait
        await m.handleLooking(ANN, "Ann");
        m.onLeaveRoom(ANN);
        check(stub.pool()[String(ANN)].earlyLeaveCount === i,
            `leaving right after call ${i} adds a strike`, stub.pool()[String(ANN)].earlyLeaveCount);
    }
    check(stub.pool()[String(ANN)].blocked, "the fourth strike blocks them");
    check(stub.beeps.some(b => b.to === ANN && b.text.includes("removed from Strip Dice matchmaking")),
        "the blocked player is told why");

    stub.pool()[String(ANN)].lookingCooldownUntil = null;
    const sentSoFar = stub.beeps.length;
    await m.handleLooking(ANN, "Ann");
    check(stub.beeps.length === sentSoFar, "a blocked player can't call !looking");
    m.handleCommand(ANN, "Ann", " register");
    check(stub.pool()[String(ANN)].blocked, "a blocked player can't re-register their way out");

    m.onLeaveRoom(ANN);
    check(stub.pool()[String(ANN)].earlyLeaveCount === 4,
        "leaving with no call outstanding costs nothing", stub.pool()[String(ANN)].earlyLeaveCount);
}

async function testAdmin(): Promise<void> {
    console.log("\nAdmin commands and exemptions");

    {
        const stub = makeStubHost({ admins: [ADMIN], friends: new Set([ANN]), room: [ANN] });
        const m = new MatchmakingManager(stub.host);
        m.handleCommand(ANN, "Ann", " register");
        stub.pool()[String(ANN)].earlyLeaveCount = 3;
        stub.pool()[String(ANN)].blocked = true;

        m.handleCommand(ANN, "Ann", " unblock Ann");
        check(stub.pool()[String(ANN)].blocked, "non-admins can't unblock");

        m.handleCommand(ADMIN, "Admin", ` unblock ${ANN}`);
        check(!stub.pool()[String(ANN)].blocked && stub.pool()[String(ANN)].earlyLeaveCount === 0,
            "an admin can unblock by member number, and it clears strikes too");

        stub.pool()[String(ANN)].earlyLeaveCount = 2;
        m.handleCommand(ADMIN, "Admin", " clearstrikes @ann");
        check(stub.pool()[String(ANN)].earlyLeaveCount === 0, "an admin can target by @name, case-insensitively");

        m.handleCommand(ADMIN, "Admin", " clearstrikes nobody");
        check(stub.heard(`No single registered player matches "nobody"`), "an unmatched target is reported");
    }

    {
        const stub = makeStubHost({ admins: [ANN], friends: new Set([ANN, BEA]), room: [ANN], online: [BEA] });
        const m = new MatchmakingManager(stub.host);
        m.handleCommand(ANN, "Ann", " register");
        m.handleCommand(BEA, "Bea", " register");

        await m.handleLooking(ANN, "Ann");
        check(stub.pool()[String(ANN)].lookingCooldownUntil === null, "admins get no cooldown");
        const sentSoFar = stub.beeps.length;
        await m.handleLooking(ANN, "Ann");
        check(stub.beeps.length > sentSoFar, "admins can call back to back");
        m.onLeaveRoom(ANN);
        check(stub.pool()[String(ANN)].earlyLeaveCount === 0, "admins earn no strikes");
    }
}

async function main(): Promise<void> {
    console.log("=== StripDiceBot matchmaking simulation ===");

    testRegistration();
    await testLookingGates();
    await testBeepsAndRelay();
    await testStrikes();
    await testAdmin();

    console.log(`\n  ${assertions} assertions`);
    console.log(failures === 0 ? "\nAll invariants held.\n" : `\n${failures} FAILURE(S).\n`);
    process.exit(failures === 0 ? 0 : 1);
}

void main();
