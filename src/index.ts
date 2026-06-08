import { BCConnection } from "./connection";
import { log, logError } from "./logger";

async function main() {
    log("StripDiceBot starting...");

    const bot = new BCConnection();

    // Set up message handler before connecting
    bot.onMessage((data: any) => {
        log(`MSG [${data.Type}] from ${data.Sender}: ${data.Content}`);

        // Echo whispers back - basic test
        if (data.Type === "Whisper") {
            bot.whisper(data.Sender, `You said: ${data.Content}`);
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

        // Greet the new arrival
        bot.sendChat(`Welcome to Strip Dice, ${name}! 🎲 Type !join to join the game or !help for more info.`);
    });

    bot.onMemberLeave((data: any) => {
        log(`Member #${data.SourceMemberNumber} left the room.`);
    });

    // Enable debug logging for all events
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