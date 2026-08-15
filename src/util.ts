// ============================================================
// PURE HELPERS - small stateless functions with no game logic
// and no file/network I/O. Depends only on types.ts.
// ============================================================
import { SoloRecordsData } from "./types";

// BC sends each character's body/appearance as an array of items keyed by
// "Group". There's no explicit IsMale/BodyType flag, but the "Pronouns"
// group ("HeHim" / "SheHer" / "TheyThem") reflects how the player has set
// up their character and is the closest available signal for tailoring
// outfit selection.
export function extractPronouns(character: any): string | undefined {
    return character?.Appearance?.find((a: any) => a.Group === "Pronouns")?.Name;
}

// Strips owner/lock-specific fields from a decoded appearance item's Property
// so the bot can apply its own lock on top of it.
export function cleanDecodedProperty(property: any): any {
    if (!property) return {};
    const {
        LockedBy, LockMemberNumber, LockMemberName, Password, Hint, LockSet,
        RemoveItem, ShowTimer, EnableRandomInput, MemberNumberList, RemoveTimer,
        ...rest
    } = property;
    if (Array.isArray(rest.Effect)) {
        rest.Effect = rest.Effect.filter((e: string) => e !== "Lock");
    }
    return rest;
}

// A property is worth learning if it selects a mode (TypeRecord) or carries
// active effects — bare default-mode applications teach us nothing.
export function isLearnableProperty(property: any): boolean {
    if (!property || typeof property !== "object") return false;
    if (property.TypeRecord && typeof property.TypeRecord === "object" && Object.keys(property.TypeRecord).length > 0) return true;
    return Array.isArray(property.Effect) && property.Effect.length > 0;
}

// Stable JSON (sorted keys, recursive) so identical configs dedupe regardless
// of key order in the incoming payload.
export function canonicalJson(value: any): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value && typeof value === "object") {
        const keys = Object.keys(value).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export function deepClone<T>(value: T): T {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export function utcDateString(): string {
    return new Date().toISOString().slice(0, 10);
}

export function emptySoloRecordsData(): SoloRecordsData {
    return {
        date: utcDateString(),
        daily: { race: {}, survive: {} },
        allTime: { race: {}, survive: {} },
        attempts: { race: {}, survive: {} },
    };
}

// ============================================================
// DURATION PARSING - plain-language time input for tournament setup.
// Everything time-related in a tournament is admin-configured, so
// short values must work as well as long ones: a full tournament
// gets rehearsed with 1-hour rounds before a real one runs for days.
// ============================================================
const DURATION_UNITS: { pattern: RegExp; ms: number }[] = [
    { pattern: /^(weeks?|wks?|w)$/, ms: 7 * 24 * 60 * 60 * 1000 },
    { pattern: /^(days?|d)$/, ms: 24 * 60 * 60 * 1000 },
    { pattern: /^(hours?|hrs?|h)$/, ms: 60 * 60 * 1000 },
    { pattern: /^(minutes?|mins?|m)$/, ms: 60 * 1000 },
    { pattern: /^(seconds?|secs?|s)$/, ms: 1000 },
];

// Parses "90 minutes", "1 hour", "48 hours", "3 days", "1 week", compact
// forms ("90m", "36h", "2d"), and combinations ("1 day 12 hours"). A trailing
// "from now" is ignored so setup answers can read naturally. Returns
// milliseconds, or null if nothing parseable was found.
export function parseDuration(input: string): number | null {
    if (!input) return null;
    const cleaned = input.toLowerCase().replace(/\bfrom\s+now\b/g, " ").replace(/,/g, " ").trim();
    if (!cleaned) return null;

    // Each match is a number followed by an optional unit word: "1 day", "36h".
    const matches = [...cleaned.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)?/g)];
    if (matches.length === 0) return null;

    let total = 0;
    let matchedAny = false;

    for (const [, rawAmount, rawUnit] of matches) {
        const amount = parseFloat(rawAmount);
        if (!isFinite(amount) || amount < 0) return null;

        // A bare number with no unit is read as minutes — the most common
        // thing an admin means when they type "15" for a punishment length.
        if (!rawUnit) {
            total += amount * 60 * 1000;
            matchedAny = true;
            continue;
        }

        const unit = DURATION_UNITS.find(u => u.pattern.test(rawUnit));
        if (!unit) return null; // unrecognized unit — better to re-ask than guess
        total += amount * unit.ms;
        matchedAny = true;
    }

    if (!matchedAny || total <= 0) return null;
    return Math.round(total);
}

// Renders a duration back as readable text for confirmation screens and
// status whispers ("2 days 3 hours", "45 minutes"). Rounds to whole units
// and shows at most the two largest non-zero ones.
export function formatDuration(ms: number): string {
    if (!isFinite(ms) || ms <= 0) return "0 minutes";

    const units: { label: string; ms: number }[] = [
        { label: "week", ms: 7 * 24 * 60 * 60 * 1000 },
        { label: "day", ms: 24 * 60 * 60 * 1000 },
        { label: "hour", ms: 60 * 60 * 1000 },
        { label: "minute", ms: 60 * 1000 },
        { label: "second", ms: 1000 },
    ];

    const parts: string[] = [];
    let remaining = ms;
    for (const unit of units) {
        const count = Math.floor(remaining / unit.ms);
        if (count > 0) {
            parts.push(`${count} ${unit.label}${count === 1 ? "" : "s"}`);
            remaining -= count * unit.ms;
        }
        if (parts.length === 2) break;
    }

    return parts.length > 0 ? parts.join(" ") : "less than a second";
}

// Parses either a duration ("3 days", meaning 3 days from `from`) or an
// absolute date ("2026-08-10", treated as UTC midnight). "now" resolves to
// `from`. Returns an epoch millisecond timestamp, or null if unparseable.
export function parseWhen(input: string, from: number = Date.now()): number | null {
    if (!input) return null;
    const cleaned = input.trim().toLowerCase();
    if (!cleaned) return null;

    if (cleaned === "now" || cleaned === "immediately") return from;

    const isoDate = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDate) {
        const parsed = Date.parse(`${isoDate[1]}-${isoDate[2]}-${isoDate[3]}T00:00:00Z`);
        return isNaN(parsed) ? null : parsed;
    }

    const duration = parseDuration(cleaned);
    return duration === null ? null : from + duration;
}

// ============================================================
// PASSWORD GENERATOR
// ============================================================
// Word bank, same approach as WD's END_GAME_LOCK_PASSWORD_WORDS (tested
// working there) — letters-only, capped at 8 characters. BC's
// TimerPasswordPadlock appears to reject/silently fail to save a password
// that starts with (or is composed of) digits, or that's longer than 8
// characters, confirmed via live testing. Passwords ARE shown to players
// (the prize winner via !claim), so a real word reads better than a random
// letter string too.
const PASSWORD_WORDS = [
    "OBEDIENT", "NAUGHTY", "COLLARED", "BONDAGE", "SUBSPACE",
    "KITTEN", "BRATTY", "DEVIOUS", "BOUND", "TEASED",
    "PET", "MISTRESS", "HELPLESS", "SQUIRM", "BLINDED",
    "SHACKLED", "WHIMPER", "CAPTIVE", "LEASHED", "EDGED",
    "RESTRAIN", "TETHERED", "DOMINANT", "YEARNING", "KNEELING",
    "CAPTURED", "CUFFED", "GAGGED", "MUZZLED", "SUBMIT",
    "CRAVING", "AROUSED", "TEASING", "OBEYING", "PLAYFUL",
];

export function generatePassword(): string {
    return PASSWORD_WORDS[Math.floor(Math.random() * PASSWORD_WORDS.length)];
}

// Renders an ISO timestamp in US Central, matching the bot's log timestamps
// and what players actually think in. Tournament times used to be shown with
// toUTCString(), which is the same instant but reads hours off from what the
// admin typed and from every other time the bot prints.
export function formatLocalTime(iso: string): string {
    const CENTRAL_OFFSET_MS = 5 * 60 * 60 * 1000;
    const d = new Date(Date.parse(iso) - CENTRAL_OFFSET_MS);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let h = d.getUTCHours();
    const ampm = h >= 12 ? "pm" : "am";
    h = h % 12 || 12;
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}, ${h}:${mm}${ampm} Central`;
}
