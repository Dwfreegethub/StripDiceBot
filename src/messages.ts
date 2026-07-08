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

export function pickRandomMessage(pool: string[]): string {
    return pool[Math.floor(Math.random() * pool.length)];
}

export function formatStreakMessage(roll: number): string {
    return pickRandomMessage(STREAK_MESSAGES).replace(/\{n\}/g, String(roll));
}
