// ============================================================
// GAME CONSTANTS - every tuning knob in one place. Values only;
// no I/O and no game logic. Depends only on types.ts.
// ============================================================
import { FeedbackItemStatus } from "./types";

export const GAME_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// ============================================================
// TEST MODE - set to false for production
// ============================================================
export const TEST_MODE = false;
export const TEST_PASSWORD = "TEST1234";
export const DEFAULT_LOCK_MINUTES = 10;
export const JOIN_CONFIRMATION_WINDOW_MS = 60 * 1000;
export const STARTING_DICE_MAX = 100;

// How long a missed player has to roll during their end-of-round second chance.
export const SECOND_CHANCE_TIMER_MS = 30 * 1000;

// How long a mid-game join pause can run before the game resumes without the
// joining player (they can still join the rotation later via !ready).
export const JOIN_PAUSE_TIMEOUT_MS = 60 * 1000;

// Minimum time a player who left mid-game gets before they're actually
// removed, even if their 2-round skip allowance runs out sooner (e.g. other
// players resolve their turns quickly).
export const MIN_RETURN_WINDOW_MS = 90 * 1000;

// How long players get to answer the pre-game toys consent question (or a
// late joiner has to answer the same question) before being treated as "no".
export const TOYS_CONSENT_TIMEOUT_MS = 60 * 1000;

// How long an admin has to confirm a proxied !feedback (submitted on behalf
// of another room member) before it's auto-cancelled.
export const ADMIN_FEEDBACK_PROXY_TIMEOUT_MS = 60 * 1000;

// ============================================================
// SOLO GAME MODE
// ============================================================
export const SOLO_BRACKET_MIN = 3;
export const SOLO_BRACKET_MAX = 7; // 7 = FEMALE_CLOTHING_SLOTS.length (the longer of the two clothing paths — see below); male path (6 items) just never fills bracket 7
export const SOLO_DEFAULT_TARGET = 8; // Used when no daily record exists yet for a bracket
export const SOLO_BASE_PENALTY_MINUTES = 5;
export const SOLO_DICE_MAX = 100;
export const SOLO_INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000;
// How long to wait for the player to close their Wardrobe (detected via
// handleWardrobe) before nudging them with the !removed fallback.
export const SOLO_REMOVAL_REMINDER_MS = 60 * 1000;
// Brief pause after wardrobe-close before applying the end-of-game bondage penalty.
export const SOLO_BONDAGE_DELAY_MS = 10 * 1000;

// ============================================================
// ITEM REMOVAL - end-of-game bondage cleanup
// ============================================================
export const REMOVAL_SLOTS = [
    "ItemFeet",
    "ItemBoots",
    "ItemLegs",
    "ItemPelvis",
    "ItemBreast",
    "ItemTorso",
    "ItemTorso2",
    "ItemArms",
    "ItemHands",
    "ItemNeck",
    "ItemNeckRestraints",
    "ItemMouth",
    "ItemMouth2",
    "ItemMouth3",
    "ItemHead",
    "ItemHood",
    "ItemNipples",
];
export const REMOVAL_SLOT_DELAY_MS = 1000; // Stagger between each slot's removal attempt
export const REMOVAL_UNLOCK_GAP_MS = 750; // Gap between unlocking an item and removing it
export const REMOVAL_RETRY_DELAY_MS = 1000;
export const MAX_REMOVAL_ATTEMPTS = 5;

// ============================================================
// SAFEWORD / !free - retry logic for removing locked bondage items
// ============================================================
export const SAFEWORD_VERIFY_DELAY_MS = 500; // Delay before checking if a removal landed
export const SAFEWORD_RETRY_DELAYS_MS = [500, 1000, 1500];

// ============================================================
// END-GAME LOCK VERIFICATION - confirm the 10-minute timer refresh landed
// ============================================================
export const LOCK_VERIFY_DELAY_MS = 1500;
export const MAX_END_GAME_LOCK_RETRIES = 2;

// ============================================================
// END-GAME LOCK BURST PACING - every emit in the end-game burst (winner's
// item removal + each bound player's lock application) shares one staggered
// timeline so the combined burst stays well under the BC server's per-second
// rate limit. Baseline ~125ms (~8/sec, 40% of the 20/sec limit) x1.5 safety
// margin.
// ============================================================
export const END_GAME_EMIT_STAGGER_MS = 1000;

// Pause between games so players have time to confirm their end-game locks
// released/applied correctly before the next bondage phase begins.
export const GAME_COOLDOWN_MS = 5 * 60 * 1000;

// ============================================================
// CLOTHING SLOTS - ordered loss sequence
//
// Two parallel slot lists, chosen per-player via ClothingPath (see
// detectClothingPath() in game.ts, driven by the BC Pronouns appearance
// item — HeHim -> male, everything else -> female, the existing default).
// The removal/scoring logic (player.clothing, clothingRemoved, etc.) is
// already fully generic over whatever list a player ends up with, so
// adding the male list required no changes there — only the declaration
// flow (handleWearing/askClothingQuestion in game.ts, and soloGame.ts's
// parallel copy) needed to become path-aware.
// ============================================================
export type ClothingPath = "male" | "female";

export const FEMALE_CLOTHING_SLOTS = ["shoes", "socks", "jacket", "top", "bottom", "bra", "panties"];
export const MALE_CLOTHING_SLOTS = ["shoes", "socks", "jacket", "shirt", "pants", "underwear"];

export function clothingSlotsFor(path: ClothingPath): string[] {
    return path === "male" ? MALE_CLOTHING_SLOTS : FEMALE_CLOTHING_SLOTS;
}

export const FEMALE_CLOTHING_ALIASES: Record<string, string> = {
    // jacket
    "coat": "jacket", "cardigan": "jacket", "blazer": "jacket",
    // top
    "shirt": "top", "tshirt": "top", "t-shirt": "top", "blouse": "top",
    "tank": "top", "tanktop": "top", "tank-top": "top", "sweater": "top",
    "hoodie": "top", "dress": "top", "corset": "top",
    // bottom
    "shorts": "bottom", "pants": "bottom", "jeans": "bottom", "skirt": "bottom",
    "leggings": "bottom", "trousers": "bottom",
    // shoes
    "shoe": "shoes", "heels": "shoes", "boots": "shoes", "sneakers": "shoes",
    "sandals": "shoes", "flats": "shoes",
    // socks
    "sock": "socks", "stockings": "socks", "tights": "socks",
    // bra
    "bikini": "bra", "bralette": "bra",
    // panties
    "underwear": "panties", "thong": "panties", "panty": "panties",
    "knickers": "panties", "briefs": "panties",
};

export const MALE_CLOTHING_ALIASES: Record<string, string> = {
    // jacket
    "coat": "jacket", "cardigan": "jacket", "blazer": "jacket",
    // shirt
    "top": "shirt", "tshirt": "shirt", "t-shirt": "shirt", "tee": "shirt",
    "tank": "shirt", "tanktop": "shirt", "tank-top": "shirt", "sweater": "shirt",
    "hoodie": "shirt", "polo": "shirt",
    // pants
    "bottom": "pants", "shorts": "pants", "jeans": "pants", "trousers": "pants",
    // shoes
    "shoe": "shoes", "boots": "shoes", "sneakers": "shoes", "sandals": "shoes",
    // socks
    "sock": "socks", "stockings": "socks", "tights": "socks",
    // underwear (bra/panties fold into the single male "underwear" slot too,
    // so declaring either still works rather than being silently rejected)
    "boxers": "underwear", "briefs": "underwear", "boxer-briefs": "underwear",
    "trunks": "underwear", "bra": "underwear", "panties": "underwear",
};

export function clothingAliasesFor(path: ClothingPath): Record<string, string> {
    return path === "male" ? MALE_CLOTHING_ALIASES : FEMALE_CLOTHING_ALIASES;
}

// ============================================================
// PLAYER-PICK BONDAGE MODE - a designated picker chooses items
// slot-by-slot from the BC catalog instead of a preset outfit.
// ============================================================

// Picker-facing display names mapped to BC item groups.
export const PICK_SLOTS: { display: string; group: string }[] = [
    { display: "Arms", group: "ItemArms" },
    { display: "Legs", group: "ItemLegs" },
    { display: "Feet", group: "ItemFeet" },
    { display: "Torso", group: "ItemTorso" },
    { display: "Torso (upper)", group: "ItemTorso2" },
    { display: "Hands", group: "ItemHands" },
    { display: "Head", group: "ItemHead" },
    { display: "Hood", group: "ItemHood" },
    { display: "Neck", group: "ItemNeck" },
    { display: "Mouth", group: "ItemMouth" },
    { display: "Boots", group: "ItemBoots" },
    { display: "Nipples", group: "ItemNipples" },
    { display: "Breast", group: "ItemBreast" },
    { display: "Pelvis", group: "ItemPelvis" },
];

// Consent tiers. Tier 1 is on by default; tier 2 requires explicit consent.
// Tier 3 (Vulva, Butt) additionally requires the higher-stakes game mode,
// which is not built yet — the constant exists as a code hook only.
export const TIER1_SLOT_GROUPS = [
    "ItemArms", "ItemLegs", "ItemFeet", "ItemTorso", "ItemTorso2",
    "ItemHands", "ItemHead", "ItemHood", "ItemNeck", "ItemMouth", "ItemBoots",
];
export const TIER2_SLOT_GROUPS = ["ItemNipples", "ItemBreast", "ItemPelvis"];
export const TIER3_SLOT_GROUPS = ["ItemVulva", "ItemButt"]; // code hook — not selectable yet

// ItemMouth2/ItemMouth3 are overflow layers of Mouth: used automatically when
// ItemMouth is already filled, never exposed as separate picker options.
export const MOUTH_OVERFLOW_GROUPS = ["ItemMouth", "ItemMouth2", "ItemMouth3"];

// Consent-answer token -> BC groups it grants. "torso" covers both layers.
export const CONSENT_TOKEN_GROUPS: Record<string, string[]> = {
    arms: ["ItemArms"],
    legs: ["ItemLegs"],
    feet: ["ItemFeet"],
    torso: ["ItemTorso", "ItemTorso2"],
    hands: ["ItemHands"],
    head: ["ItemHead"],
    hood: ["ItemHood"],
    neck: ["ItemNeck"],
    mouth: ["ItemMouth"],
    boots: ["ItemBoots"],
    nipples: ["ItemNipples"],
    breast: ["ItemBreast"],
    breasts: ["ItemBreast"],
    pelvis: ["ItemPelvis"],
};

// Game ends for a player-pick player once this many items are applied.
// 7 = median item count of the outfits in outfits.json (6/8/7/8/6).
export const DEFAULT_BONDAGE_ITEM_LIMIT = 7;
// How many popular items to list per slot (plus one random wildcard).
export const PICK_LIST_TOP_N = 9;
// Minimum distinct areas a player-pick player must consent to (Mouth counts
// as one area even though it holds up to 3 gag layers).
export const MIN_CONSENT_AREAS = 6;
export const BONDAGE_MODE_TIMEOUT_MS = 60 * 1000;   // mode question window; unanswered = outfit
export const PICKER_RESPONSE_TIMEOUT_MS = 60 * 1000; // picker slot/item window; then bot picks randomly
export const VETO_TIMEOUT_MS = 30 * 1000;            // target's veto window; then auto-accept

// ============================================================
// ITEM SETTINGS LIBRARY - tuning for learned per-item configurations.
// ============================================================
export const MAX_SETTING_VARIANTS_PER_ITEM = 10; // keep the most popular N configs per item
// How to choose among learned settings when applying a picked item:
// "popular" = most-seen config (ties random); "random" = any learned config;
// "weighted" = random, biased by popularity.
export const ITEM_SETTING_STRATEGY: "popular" | "random" | "weighted" = "popular";

// ============================================================
// FEEDBACK STATUS LABELS
// ============================================================
export const FEEDBACK_STATUS_LABELS: Record<FeedbackItemStatus, string> = {
    pending: "⏳ Pending review",
    reviewing: "🔍 Reviewing",
    testing: "🧪 Testing",
    researching: "🔬 Researching — we're looking into this!",
    implemented: "✅ Implemented",
    declined: "❌ Declined",
    partly_implemented: "🔧 Partly implemented",
};

// Statuses that count as "resolved" - shown to the submitter only once.
export const RESOLVED_FEEDBACK_STATUSES: ReadonlySet<FeedbackItemStatus> = new Set([
    "implemented",
    "declined",
    "partly_implemented",
]);

// Statuses that are still "in progress" - covered by the single bundled
// "we're reviewing it" ack rather than a per-item whisper.
export const REVIEWING_FEEDBACK_STATUSES: ReadonlySet<FeedbackItemStatus> = new Set([
    "pending",
    "reviewing",
    "researching",
    "testing",
]);
