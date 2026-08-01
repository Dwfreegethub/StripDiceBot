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
