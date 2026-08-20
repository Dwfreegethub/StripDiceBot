// ============================================================
// MATCHMAKING POOL - an opt-in list of players who agree to be
// beeped when someone is at the room wanting a game, and who can
// beep the pool themselves with !looking.
//
// Ported from WinnersDice (see D:\Games\BC-Bot\WinnersDice\
// design_matchmaking.md for the reasoning behind the strike system,
// the cooldown, and keeping pool membership independent of BC
// friendship). The rules and the stored shape are deliberately
// identical, so a player who learned !wd register over there
// already knows !bd register here.
//
// Two BC facts shape everything below:
//   - Presence is PULL, not push. There is no friend-online event,
//     but AccountQuery { Query: "OnlineFriends" } answers with every
//     online friend, so the pool is filtered against a fresh query
//     at the moment !looking runs rather than tracked live.
//   - A beep only lands if the target is online AND mutually
//     friended. Every beep is best-effort; nothing here depends on
//     one arriving.
// ============================================================
import { GameHost } from "./host";
import { RegisteredPlayer } from "./types";
import {
    LOOKING_COOLDOWN_MS, LOOKING_NO_RESPONSE_MS, LOOKING_RELAY_WINDOW_MS,
    LOOKING_STAY_MS, LOOKING_STRIKE_LIMIT,
} from "./constants";
import { log, logGameEvent } from "./logger";
import { secrets } from "./secrets";

export class MatchmakingManager {
    private pool: Record<string, RegisteredPlayer>;

    // In-flight !looking calls, keyed by seeker. `beeped` is who we beeped on
    // their behalf, so a reply beep can be routed back to the right seeker.
    // `roomAtCall` is who was already here, so the "nobody came" nudge can
    // tell whether anyone actually turned up.
    private activeCalls: Map<number, { beeped: Set<number>; roomAtCall: Set<number>; expiresAt: number }> = new Map();

    // The post-!looking "did they stay?" timer, and the "nobody came" nudge.
    private stayTimers: Map<number, NodeJS.Timeout> = new Map();
    private noResponseTimers: Map<number, NodeJS.Timeout> = new Map();

    // Registered but not yet mutually friended, so the confirmation can be
    // sent the moment the friend link completes. In-memory only: a restart
    // just costs them that one confirmation whisper, not the registration.
    private awaitingFriend: Set<number> = new Set();

    // Seekers with a presence query in flight. The cooldown can only be
    // stamped after the query returns, which leaves a few seconds where a
    // double-sent !looking would beep everyone twice.
    private queryInFlight: Set<number> = new Set();

    constructor(private readonly host: GameHost) {
        this.pool = this.host.storage.loadRegisteredPlayers();
        const count = Object.keys(this.pool).length;
        if (count > 0) log(`Matchmaking pool loaded: ${count} registered player(s).`);
    }

    private save(): void {
        this.host.storage.saveRegisteredPlayers(this.pool);
    }

    private entry(memberNumber: number): RegisteredPlayer | undefined {
        return this.pool[String(memberNumber)];
    }

    // True if this member is in the pool at all (blocked or not). Used by
    // !unfriend to warn that beeps will stop landing.
    public isRegistered(memberNumber: number): boolean {
        return !!this.entry(memberNumber);
    }

    // ---- command router ----------------------------------------------------

    // `args` is whatever followed "!bd". Subcommands rather than top-level
    // commands so the pool doesn't claim half a dozen bare words — the one
    // exception is !looking, which players use constantly.
    public handleCommand(memberNumber: number, name: string, args: string): void {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const sub = (parts[0] ?? "").toLowerCase();
        const rest = parts.slice(1).join(" ");

        switch (sub) {
            case "register": this.handleRegister(memberNumber, name); return;
            case "unregister": this.handleUnregister(memberNumber); return;
            case "pause": this.handlePause(memberNumber); return;
            case "resume": this.handleResume(memberNumber); return;
            case "status": this.handleStatus(memberNumber); return;
            case "pool": void this.handlePool(memberNumber); return;
            case "clearstrikes": this.handleClearStrikes(memberNumber, rest); return;
            case "unblock": this.handleUnblock(memberNumber, rest); return;
            default: this.handleHelp(memberNumber);
        }
    }

    public handleHelp(memberNumber: number): void {
        this.host.sendLongWhisper(memberNumber,
            `=== Matchmaking ===\n` +
            `Nobody in the room? Register once, then beep everyone who's online when you want a game.\n` +
            `!bd register - Join the pool (you'll add me as a friend too)\n` +
            `!bd unregister - Leave the pool\n` +
            `!bd pause / !bd resume - Stop / restart getting beeps (you stay registered)\n` +
            `!bd status - Your current status\n` +
            `!looking - Beep every registered player who's online that you're here for a game` +
            (this.host.isAdmin(memberNumber)
                ? `\n(admin) !bd pool - Everyone registered, and who's online\n` +
                  `(admin) !bd clearstrikes [name|memberNumber] - Reset someone's strikes\n` +
                  `(admin) !bd unblock [name|memberNumber] - Put someone back in the pool`
                : ""));
    }

    // ---- registration ------------------------------------------------------

    public handleRegister(memberNumber: number, name: string): void {
        const key = String(memberNumber);
        const existing = this.pool[key];

        if (existing?.blocked) {
            this.host.bot.whisper(memberNumber,
                "You've been removed from matchmaking. An admin has to whisper !bd unblock before you can rejoin.");
            return;
        }

        if (existing) {
            existing.name = name || existing.name;
            existing.paused = false; // re-registering un-pauses
            this.save();
            this.host.bot.whisper(memberNumber, "You're already registered — welcome back (and un-paused, if you were).");
        } else {
            this.pool[key] = {
                memberNumber,
                name: name || this.host.getPlayerName(memberNumber),
                registeredAt: Date.now(),
                paused: false,
                earlyLeaveCount: 0,
                blocked: false,
                lastLookingAt: null,
                lookingCooldownUntil: null,
            };
            this.save();
            logGameEvent(`[MATCHMAKING] ${name} (#${memberNumber}) registered — pool is now ${Object.keys(this.pool).length}.`);
            this.host.bot.whisper(memberNumber,
                "✅ You're in the matchmaking pool! You'll get a beep when someone's at the room looking for a game, " +
                "and !looking beeps them back when you want one.");
        }

        // Deliberately NOT calling addFriend here. Everywhere else in the bot,
        // isFriend() means "mutually friended" — the player adds the bot, BC
        // sends a hidden ChatRoomFriendRequestAdd, and the bot adds back. If
        // the pool pre-added from this side, isFriend() would start returning
        // true for people who never opted in, and tournament registration
        // (which gates on exactly that) would wave them straight through.
        if (this.host.bot.isFriend(memberNumber)) {
            this.awaitingFriend.delete(memberNumber);
            return;
        }

        this.awaitingFriend.add(memberNumber);
        this.host.sendLongWhisper(memberNumber,
            `One more step: add ${secrets.username} to your BC friend list (or whisper me !friend and I'll walk you through it). ` +
            `Beeps only reach people the bot is friends with, so until that's done I can't include you when someone calls !looking. ` +
            `Whisper !bd status any time to check.`);
    }

    // Called from the game when a friend link completes, so someone who
    // registered first and friended second gets told they're all set.
    public onFriendAdded(memberNumber: number): void {
        if (!this.awaitingFriend.delete(memberNumber)) return;
        if (!this.entry(memberNumber)) return;
        this.host.bot.whisper(memberNumber,
            "🎲 That's matchmaking live — you'll be beeped when someone's at the room looking for a game. " +
            "Whisper !bd pause any time you'd rather not be.");
    }

    public handleUnregister(memberNumber: number): void {
        const key = String(memberNumber);
        if (!this.pool[key]) {
            this.host.bot.whisper(memberNumber, "You're not registered for matchmaking.");
            return;
        }
        delete this.pool[key];
        this.awaitingFriend.delete(memberNumber);
        this.save();
        // Deliberately NOT unfriending: the friend link is also what puts the
        // room name and headcount on their friend list, which they may well
        // still want. !unfriend is the command for that.
        this.host.bot.whisper(memberNumber,
            "You're out of matchmaking — no more game beeps. (I've kept the friend link so you can still see the room " +
            "on your friend list; whisper !unfriend if you want that gone too.) Whisper !bd register to rejoin anytime.");
    }

    public handlePause(memberNumber: number): void {
        const p = this.entry(memberNumber);
        if (!p) { this.host.bot.whisper(memberNumber, "You're not registered — whisper !bd register first."); return; }
        if (p.paused) { this.host.bot.whisper(memberNumber, "You're already paused."); return; }
        p.paused = true;
        this.save();
        this.host.bot.whisper(memberNumber,
            "⏸️ Paused — you stay registered but won't get game beeps. Whisper !bd resume when you're back.");
    }

    public handleResume(memberNumber: number): void {
        const p = this.entry(memberNumber);
        if (!p) { this.host.bot.whisper(memberNumber, "You're not registered — whisper !bd register first."); return; }
        if (!p.paused) { this.host.bot.whisper(memberNumber, "You're already active (not paused)."); return; }
        p.paused = false;
        this.save();
        this.host.bot.whisper(memberNumber, "▶️ Back in the pool — you'll get game beeps again.");
    }

    public handleStatus(memberNumber: number): void {
        const p = this.entry(memberNumber);
        if (!p) {
            this.host.bot.whisper(memberNumber, "You're not registered. Whisper !bd register to join matchmaking.");
            return;
        }
        const state = p.blocked ? "blocked" : (p.paused ? "paused" : "active");
        const friended = this.host.bot.isFriend(memberNumber);
        const now = Date.now();
        const cooldown = !p.blocked && p.lookingCooldownUntil && now < p.lookingCooldownUntil
            ? `\n!looking is available again in ~${Math.max(1, Math.ceil((p.lookingCooldownUntil - now) / 60000))} min.`
            : "";

        this.host.sendLongWhisper(memberNumber,
            `Matchmaking status: ${state}. Strikes: ${p.earlyLeaveCount}/${LOOKING_STRIKE_LIMIT}.\n` +
            (friended
                ? `We're friended, so beeps will reach you whenever you're online.`
                : `⚠️ We aren't friended yet — add ${secrets.username} in BC, or whisper !friend. Until then I can't beep you.`) +
            cooldown);
    }

    // ---- admin -------------------------------------------------------------

    // Pool members may not be in the room, so this searches the pool by member
    // number or a unique name substring rather than the room roster.
    private resolveTarget(token: string): RegisteredPlayer | null {
        const t = token.replace(/^@/, "").trim();
        if (!t) return null;
        if (/^\d{3,}$/.test(t)) return this.pool[t] ?? null;
        const lower = t.toLowerCase();
        const matches = Object.values(this.pool).filter(p => p.name.toLowerCase().includes(lower));
        return matches.length === 1 ? matches[0] : null;
    }

    private async handlePool(memberNumber: number): Promise<void> {
        if (!this.host.requireAdmin(memberNumber)) return;

        const all = Object.values(this.pool);
        if (all.length === 0) {
            this.host.bot.whisper(memberNumber, "Nobody is registered for matchmaking yet.");
            return;
        }

        const online = await this.host.bot.queryOnlineFriends();
        const onlineNumbers = new Set<number>(
            online.map((f: any) => f?.MemberNumber).filter((n: any): n is number => typeof n === "number"));

        const lines = all
            .sort((a, b) => Number(onlineNumbers.has(b.memberNumber)) - Number(onlineNumbers.has(a.memberNumber)))
            .map(p => {
                const on = onlineNumbers.has(p.memberNumber) ? "🟢 online" : "⚪ offline";
                const flags = [
                    p.blocked ? "BLOCKED" : null,
                    p.paused ? "paused" : null,
                    this.host.bot.isFriend(p.memberNumber) ? null : "not friended",
                ].filter(Boolean).join(", ");
                return `${on} — ${p.name} #${p.memberNumber}${flags ? ` (${flags})` : ""}, strikes ${p.earlyLeaveCount}`;
            });

        this.host.sendLongWhisper(memberNumber, `Matchmaking pool (${all.length}):\n` + lines.join("\n"));
    }

    private handleClearStrikes(memberNumber: number, token: string): void {
        if (!this.host.requireAdmin(memberNumber)) return;
        const target = this.resolveTarget(token);
        if (!target) {
            this.host.bot.whisper(memberNumber,
                `No single registered player matches "${token}" — pass a member number or a unique name.`);
            return;
        }
        target.earlyLeaveCount = 0;
        this.save();
        this.host.bot.whisper(memberNumber, `Cleared strikes for ${target.name} (#${target.memberNumber}).`);
    }

    private handleUnblock(memberNumber: number, token: string): void {
        if (!this.host.requireAdmin(memberNumber)) return;
        const target = this.resolveTarget(token);
        if (!target) {
            this.host.bot.whisper(memberNumber,
                `No single registered player matches "${token}" — pass a member number or a unique name.`);
            return;
        }
        target.blocked = false;
        target.earlyLeaveCount = 0;
        this.save();
        this.host.bot.whisper(memberNumber,
            `Unblocked ${target.name} (#${target.memberNumber}) — back in the pool with a clean slate.`);
        this.host.bot.beep(target.memberNumber,
            "You're back in Strip Dice matchmaking — game beeps will reach you again.");
    }

    // ---- !looking ----------------------------------------------------------

    // Beeps every registered, online, non-paused player that the caller is at
    // the room and wants a game. In-room only, 30-minute cooldown, admins
    // exempt from both the cooldown and the strike system.
    public async handleLooking(memberNumber: number, name: string): Promise<void> {
        const p = this.entry(memberNumber);
        if (!p || p.blocked) {
            this.host.bot.whisper(memberNumber, p?.blocked
                ? "You've been removed from matchmaking — an admin needs to !bd unblock you."
                : "You need to register first — whisper !bd register. (It's mutual: you can beep the pool because " +
                  "you're in it too.)");
            return;
        }
        if (p.paused) {
            this.host.bot.whisper(memberNumber, "You're paused. Whisper !bd resume first, then !looking.");
            return;
        }
        if (!this.host.isInRoom(memberNumber)) {
            this.host.bot.whisper(memberNumber,
                `Use !looking from inside the room ("${secrets.roomName}") — there's no point beeping people over ` +
                `if you aren't there when they arrive.`);
            return;
        }

        const now = Date.now();
        const admin = this.host.isAdmin(memberNumber);
        if (!admin && p.lookingCooldownUntil && now < p.lookingCooldownUntil) {
            const mins = Math.max(1, Math.ceil((p.lookingCooldownUntil - now) / 60000));
            this.host.bot.whisper(memberNumber, `You used !looking recently — try again in ~${mins} min.`);
            return;
        }

        // Strike warnings are delivered here, at the start of the next call,
        // rather than at the moment they left — the timing is far less
        // confusing when it's attached to the thing being warned about.
        if (!admin && p.earlyLeaveCount === LOOKING_STRIKE_LIMIT - 2) {
            this.host.bot.whisper(memberNumber,
                "⚠️ Please stay at least 3 minutes after !looking — people need time to see the beep and get here.");
        } else if (!admin && p.earlyLeaveCount >= LOOKING_STRIKE_LIMIT - 1) {
            this.host.bot.whisper(memberNumber,
                "⚠️ Last warning: stay at least 3 minutes after !looking. One more early leave removes you from matchmaking.");
        }

        if (this.queryInFlight.has(memberNumber)) {
            this.host.bot.whisper(memberNumber, "Already checking who's online — hang on a moment.");
            return;
        }

        let onlineList: any[];
        this.queryInFlight.add(memberNumber);
        try {
            onlineList = await this.host.bot.queryOnlineFriends();
        } finally {
            this.queryInFlight.delete(memberNumber);
        }

        const onlineNumbers = new Set<number>(
            onlineList.map((f: any) => f?.MemberNumber).filter((n: any): n is number => typeof n === "number"));

        const recipients = Object.values(this.pool).filter(r =>
            r.memberNumber !== memberNumber && !r.paused && !r.blocked && onlineNumbers.has(r.memberNumber));

        // Drop calls whose relay window has closed, so the map can't grow
        // without bound on a bot that runs for weeks.
        for (const [seeker, call] of this.activeCalls) {
            if (call.expiresAt < now) this.activeCalls.delete(seeker);
        }

        // Record the attempt and start the cooldown whether or not anyone was
        // online — otherwise a quiet night is a free retry loop.
        p.lastLookingAt = now;
        if (!admin) p.lookingCooldownUntil = now + LOOKING_COOLDOWN_MS;
        this.save();

        if (recipients.length === 0) {
            this.host.bot.whisper(memberNumber,
                "No registered players are online right now — nobody to beep. Hang out in the room and try again later, " +
                "or whisper !solo race / !solo survive for a game on your own in the meantime.");
            return;
        }

        const here = this.host.getRoomMembers().filter(n => n !== memberNumber).length;
        const company = here === 0
            ? ""
            : ` ${here} other${here === 1 ? " player is" : " players are"} already here.`;
        const beepMsg = `${name} is at the Strip Dice room looking for a game!${company} Reply to this beep if you're heading over.`;

        const beeped = new Set<number>();
        for (const r of recipients) {
            this.host.bot.beep(r.memberNumber, beepMsg);
            beeped.add(r.memberNumber);
        }
        this.activeCalls.set(memberNumber, {
            beeped,
            roomAtCall: new Set(this.host.getRoomMembers()),
            expiresAt: now + LOOKING_RELAY_WINDOW_MS,
        });
        logGameEvent(`[MATCHMAKING] ${name} (#${memberNumber}) called !looking — beeped ${beeped.size} online player(s).`);

        if (!admin) {
            this.startStayTimer(memberNumber);
            this.startNoResponseTimer(memberNumber);
        }

        this.host.bot.whisper(memberNumber,
            `📣 Beeped ${beeped.size} online player${beeped.size === 1 ? "" : "s"}. If anyone replies I'll pass it along. ` +
            `Give it a few minutes — please stick around, they're coming for you.`);
    }

    // The 3-minute stay window. Reaching the end without leaving is good
    // behaviour and decays one strike, so a single slip doesn't stick forever.
    private startStayTimer(seeker: number): void {
        this.clearStayTimer(seeker);
        this.stayTimers.set(seeker, setTimeout(() => {
            this.stayTimers.delete(seeker);
            const p = this.entry(seeker);
            if (p && p.earlyLeaveCount > 0) {
                p.earlyLeaveCount = Math.max(0, p.earlyLeaveCount - 1);
                this.save();
                log(`[MATCHMAKING] ${p.name} (#${seeker}) stayed after !looking — strike decayed to ${p.earlyLeaveCount}.`);
            }
        }, LOOKING_STAY_MS));
    }

    private clearStayTimer(seeker: number): void {
        const t = this.stayTimers.get(seeker);
        if (t) { clearTimeout(t); this.stayTimers.delete(seeker); }
    }

    private startNoResponseTimer(seeker: number): void {
        this.clearNoResponseTimer(seeker);
        this.noResponseTimers.set(seeker, setTimeout(() => {
            this.noResponseTimers.delete(seeker);
            // Somebody turning up is the whole point — if the room has anyone
            // in it who wasn't there when they called, say nothing.
            const call = this.activeCalls.get(seeker);
            const someoneCame = !call || this.host.getRoomMembers().some(n => n !== seeker && !call.roomAtCall.has(n));
            if (someoneCame) return;
            this.host.bot.whisper(seeker,
                `Looks like nobody's made it over yet — no worries, beeps often take a while to get noticed. ` +
                `You can try !looking again in about 30 minutes, or whisper !solo survive for a game on your own.`);
        }, LOOKING_NO_RESPONSE_MS));
    }

    private clearNoResponseTimer(seeker: number): void {
        const t = this.noResponseTimers.get(seeker);
        if (t) { clearTimeout(t); this.noResponseTimers.delete(seeker); }
    }

    // Called from the game's onMemberLeave. Leaving while the stay timer is
    // still running is an early leave: it wasted everyone's beep. Four of
    // those and they're out of the pool until an admin puts them back.
    public onLeaveRoom(memberNumber: number): void {
        if (!this.stayTimers.has(memberNumber)) return;
        this.clearStayTimer(memberNumber);
        this.clearNoResponseTimer(memberNumber);
        this.activeCalls.delete(memberNumber);

        const p = this.entry(memberNumber);
        if (!p) return;
        p.earlyLeaveCount += 1;
        if (p.earlyLeaveCount >= LOOKING_STRIKE_LIMIT) p.blocked = true;
        this.save();
        logGameEvent(`[MATCHMAKING] Early leave by ${p.name} (#${memberNumber}) after !looking — ` +
            `strikes now ${p.earlyLeaveCount}${p.blocked ? " (BLOCKED)" : ""}.`);

        if (p.blocked) {
            this.host.bot.beep(memberNumber,
                "You've been removed from Strip Dice matchmaking after leaving right after !looking four times. " +
                "An admin can put you back — whisper !bd status for where you stand.");
        }
    }

    // ---- incoming beeps ----------------------------------------------------

    // Relays a pool member's beep-reply back to whoever beeped them. Only
    // plain-text beeps from someone in an active, unexpired call: addon beeps
    // (BeepType "GGC_BEEP" and friends) carry an object Message and are noise.
    // Returns true if the beep was consumed as a reply.
    public onIncomingBeep(from: number, fromName: string, message: unknown): boolean {
        if (typeof from !== "number" || typeof message !== "string") return false;

        const now = Date.now();
        for (const [seeker, call] of this.activeCalls) {
            if (call.expiresAt < now) { this.activeCalls.delete(seeker); continue; }
            if (!call.beeped.has(from)) continue;

            const who = fromName || this.host.getPlayerName(from);
            const text = message.trim()
                ? `💬 ${who} replied to your game call: "${message.trim()}"`
                : `💬 ${who} is on their way!`;
            // Whisper needs them in the room; if they've wandered off, beep.
            if (this.host.isInRoom(seeker)) this.host.bot.whisper(seeker, text);
            else this.host.bot.beep(seeker, text);
            logGameEvent(`[MATCHMAKING] Relayed ${who} (#${from})'s reply to #${seeker}.`);
            return true;
        }
        return false;
    }
}
