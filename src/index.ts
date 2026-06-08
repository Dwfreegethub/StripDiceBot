import { BCConnection } from "./connection";
import { log, logError } from "./logger";

async function main() {
    log("StripDiceBot starting...");

    const bot = new BCConnection();

    bot.onMessage((data: any) => {
        log(`MSG [${data.Type}] from ${data.Sender}: ${data.Content}`);

        if (data.Type === "Whisper") {
            const msg = data.Content.trim().toLowerCase();
            const sender = data.Sender;

            // Echo whispers back - basic test
            bot.whisper(sender, `You said: ${data.Content}`);

            // Test applying cuffs with timer lock
            if (msg === "!testcuffs") {
                bot.whisper(sender, "Applying ankle cuffs with timer lock...");
                
                // Step 1 - Apply the ankle cuffs
                bot.applyItem(sender, "ItemFeet", "HighStyleSteelAnkleCuffs", "#A23939", {
                    TypeRecord: { typed: 2 },
                    Difficulty: 0
                });

                // Step 2 - Apply timer password lock after short delay
                setTimeout(() => {
                    bot.applyItem(sender, "ItemFeet", "HighStyleSteelAnkleCuffs", "#A23939", {
                        TypeRecord: { typed: 2 },
                        Difficulty: 0,
                        Effect: ["Slow", "Lock"],
                        LockedBy: "TimerPasswordPadlock",
                        LockMemberNumber: bot.getMemberNumber(),
                        LockMemberName: "GameBot",
                        Password: "DICE",
                        Hint: "The game password",
                        LockSet: true,
                        RemoveItem: true,
                        ShowTimer: true,
                        EnableRandomInput: false,
                        MemberNumberList: [],
                        RemoveTimer: Date.now() + (5 * 60 * 1000) // 5 minutes from now
                    });
                }, 500); // 500ms delay between apply and lock
            }
        }
    });

    bot.onRoomSync((data: any) => {
        log(`Room synced. Players in room: ${data.Character?.length ?? 0}`);
        bot.sendChat("StripDiceBot is online! Type !help to learn how to play.");
    });

    bot.onMemberJoin((data: any) => {
        const memberNumber = data.SourceMemberNumber;
        const name = data.Character?.Nickname || data.Character?.Name || "stranger";
        log(`${name} (#${memberNumber}) joined the room.`);
        bot.sendChat(`Welcome to Strip Dice, ${name}! 🎲 Type !join to join the game or !help for more info.`);
    });

    bot.onMemberLeave((data: any) => {
        log(`Member #${data.SourceMemberNumber} left the room.`);
    });

    bot.listenAll();

    try {
        await bot.connect();
        bot.joinRoom();
    } catch (err: any) {
        logError(`Failed to start: ${err.message}`);
        process.exit(1);
    }
}

main();