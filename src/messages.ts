// Flavor-text message pools for bonus bot commentary (streaks, easter eggs,
// etc.). Purely cosmetic — kept separate from game.ts so wording can be
// tweaked without touching game logic.

export const STREAK_MESSAGES: string[] = [
    // Sarcastic
    "{n} again? The dice are clearly having a moment.",
    "Oh look, {n}. What a surprise. Truly no one saw that coming.",
    "The dice are stuck on {n}. Did someone forget to shake them?",
    "{n} AGAIN? At this point I'm just going to assume they're broken.",
    "Incredible. Another {n}. You must be very proud.",
    "The dice have chosen {n} as their personality. We respect that.",
    "Statistically speaking, this is fine. Totally fine.",
    // Flirty
    "{n} again? The dice are persistent. I respect that in a roll.",
    "Still {n}? Someone's got a type.",
    "{n} keeps coming up... must like the attention.",
    "Mmm, {n} again. The dice are trying to tell you something.",
    "The dice keep saying {n}. Who am I to argue with that kind of confidence?",
];

export const SIXTY_NINE_MESSAGES: string[] = [
    "69! My favorite number. For purely mathematical reasons.",
    "Nice.",
    "69 — the dice know exactly what they're doing.",
];

// Used in team mode when a 69 is rolled — announces the bonus added to the
// losing team's pool. {bonus} = minutes added this roll, {total} = running total.
export const TEAM_69_MESSAGES: string[] = [
    "🎰 69! The losing team just earned themselves an extra {bonus} min on their locks. Pool: {total}/30 min.",
    "🎰 Nice. +{bonus} min added to the losing team's lock pool. ({total}/30 min banked so far.)",
    "🎰 69 — the dice are feeling generous. Or cruel, depending on which team you're on. +{bonus} min. ({total}/30 min.)",
    "🎰 Someone rolled 69! That's +{bonus} min stacking onto the losing team's sentence. Running total: {total}/30 min.",
];

// Flavor for when the team 69 pool hits the 30-min cap.
export const TEAM_69_CAP_MESSAGES: string[] = [
    "🎰 69 — but the losing team's bonus pool is already maxed at 30 min. They caught a break there.",
    "🎰 Nice roll, but the 30-min cap has been hit. The losing team's extra time won't get any worse. Lucky them.",
    "🎰 69! ...and the pool is capped. 30 min is as bad as it gets for the losing team. Probably.",
];

export function pickRandomMessage(pool: string[]): string {
    return pool[Math.floor(Math.random() * pool.length)];
}

export function formatStreakMessage(roll: number): string {
    return pickRandomMessage(STREAK_MESSAGES).replace(/\{n\}/g, String(roll));
}
