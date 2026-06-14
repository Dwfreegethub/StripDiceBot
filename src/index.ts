import * as fs from "fs";
import * as path from "path";
import { BCConnection } from "./connection";
import { StripDiceGame } from "./game";
import { log, logError } from "./logger";

process.on("uncaughtException", (err: Error) => {
    logError(`Uncaught exception: ${err.stack || err.message || err}`);
    process.exit(1);
});

process.on("unhandledRejection", (reason: any) => {
    const details = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    logError(`Unhandled rejection: ${details}`);
    process.exit(1);
});

async function main() {
    const pendingUpdatePath = path.join(__dirname, "..", "pending_update.txt");
    let updateNote: string | null = null;
    if (fs.existsSync(pendingUpdatePath)) {
        try {
            updateNote = fs.readFileSync(pendingUpdatePath, "utf8").trim();
        } catch {
            updateNote = "";
        }
        fs.unlinkSync(pendingUpdatePath);
        log(`Removed pending_update.txt from previous restart (note: "${updateNote}").`);
    }
    let restartAnnounced = false;

    log("StripDiceBot starting...");

    const bot = new BCConnection();
    const game = new StripDiceGame(bot);

    // Strip OOC wrappers: (!roll) or [!roll] -> !roll
    function stripOOC(msg: string): string {
        return msg.trim().replace(/^[\(\[]\s*(.*?)\s*[\)\]]$/, '$1');
    }

    bot.onMessage((data: any) => {
        log(`MSG [${data.Type}] from ${data.Sender}: ${data.Content}`);

        const memberNumber: number = data.Sender;
        const name: string = game.getNameFor(memberNumber) ?? `Player #${memberNumber}`;

        if (data.Type === "Whisper") {
            const msg = stripOOC(data.Content).trim().toLowerCase();

            // Pass to game handler
            game.handleWhisper(memberNumber, name, stripOOC(data.Content));
        }

        if (data.Type === "Chat") {
            game.handleChat(memberNumber, name, stripOOC(data.Content));
        }
        if (data.Type === "Status" && data.Content === "Wardrobe") {
            game.handleWardrobe(memberNumber, name);
        }
    });

    bot.onRoomSync((data: any) => {
        log(`Room synced. Players in room: ${data.Character?.length ?? 0}`);
        game.onRoomSync(data.Character ?? []);
        if (data.Visibility?.[0] !== "All" || data.Private) {
            log("Room is not public, updating room settings to make it public...");
            bot.makeRoomPublic();
        }

        const myIndex = (data.Character ?? []).findIndex((c: any) => c.MemberNumber === bot.getMemberNumber());
        if (myIndex > 0) {
            log(`GameBot is at position ${myIndex} — moving to the leftmost spot...`);
            for (let i = 0; i < myIndex; i++) {
                bot.moveLeft();
            }
        }

        bot.sendChat("StripDiceBot is online! 🎲 Whisper !join to play Strip Dice or !help for info.");

        if (!restartAnnounced) {
            restartAnnounced = true;
            if (updateNote !== null) {
                bot.sendChat(updateNote
                    ? `⚙️ Update applied — ${updateNote}. Back online!`
                    : `⚙️ Update applied. Back online!`);
            } else {
                bot.sendChat("Sorry for the interruption — I'm back!");
            }
        }
    });

    bot.onMemberJoin((data: any) => {
        const memberNumber = data.SourceMemberNumber;
        const name = data.Character?.Nickname || data.Character?.Name || `Player #${memberNumber}`;
        log(`${name} (#${memberNumber}) joined the room.`);
        bot.sendChat(`Welcome to Strip Dice, ${name}! 🎲`);
        bot.whisper(memberNumber,
            `=== Welcome to Strip Dice! 🎲 ===\n` +
            `This is a dice game where you risk your clothing — and your freedom!\n\n` +
            `HOW IT WORKS:\n` +
            `• Players take turns rolling dice. The max shrinks each round.\n` +
            `• Roll a 1 and you lose an item of clothing!\n` +
            `• Once naked, you start receiving bondage restraints instead.\n` +
            `• Last player unbound wins!\n\n` +
            `⚠️ EARLY BETA: Bondage items are limited for now — more coming soon!\n\n` +
            `COMMANDS: Whisper !help for the full list.\n` +
            `FEEDBACK: Whisper !feedback [your thoughts] — we read everything!\n\n` +
            `Whisper !join to play!`
        );
        game.onMemberJoin(memberNumber, name, data.Character);
    });

    bot.onMemberLeave((data: any) => {
        const memberNumber = data.SourceMemberNumber;
        log(`Member #${memberNumber} left the room.`);
        game.onMemberLeave(memberNumber);
    });

    bot.onItemChange((data: any) => {
        game.onItemChange(data);
    });

    bot.onSyncSingle((data: any) => {
        game.onSyncSingle(data);
    });

    bot.onReconnect(() => {
        log("Reconnect complete. Re-announcing bot...");
        bot.sendChat("StripDiceBot reconnected! 🎲 Whisper !join to play or !help for info.");
        game.onReconnect();
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