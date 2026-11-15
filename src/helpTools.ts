// Dev-only (like the sims): keeps the help honest.
//
//   npm run check:help   fails (exit 1) if the help and the commands disagree
//   npm run wiki         rewrites wiki/Commands.md from src/help.ts
//
// The check reads game.ts's commandTable as text, in order, and treats each
// usage in help.ts the way dispatchCommand would: "!" + usage, lowercased,
// [placeholders] filled in, first matching key wins. So a usage line that an
// earlier prefix entry would swallow fails too, not just a missing one.
import * as fs from "fs";
import * as path from "path";
import {
    ALL_HELP_SECTIONS, BANG_NOTE, HIDDEN_COMMANDS, HelpContext, HelpEntry, HelpSection, entryText,
} from "./help";

const ROOT = path.join(__dirname, "..");
const GAME_TS = path.join(ROOT, "src", "game.ts");
const COMMANDS_MD = path.join(ROOT, "wiki", "Commands.md");

interface TableKey { command: string; prefix: boolean }

function readCommandTable(): TableKey[] {
    const src = fs.readFileSync(GAME_TS, "utf8");
    const start = src.indexOf("private readonly commandTable");
    const end = src.indexOf("\n    };", start);
    if (start < 0 || end < 0) throw new Error("commandTable not found in game.ts");
    const block = src.slice(start, end);
    const re = /^\s*"(![^"]*)":\s*\{/gm;
    const hits: { command: string; at: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) hits.push({ command: m[1], at: m.index });
    return hits.map((h, i) => {
        const chunk = block.slice(h.at, i + 1 < hits.length ? hits[i + 1].at : block.length);
        return { command: h.command, prefix: /prefix:\s*true/.test(chunk) };
    });
}

function alternatives(entry: HelpEntry): string[] {
    return entry.usage.split(" / ").map(s => s.trim()).filter(Boolean);
}

// "!" + usage as a player would send it: placeholders get a sample value.
function sampleMessage(usage: string): string {
    return ("!" + usage.replace(/\[[^\]]*\]/g, "x")).toLowerCase();
}

function dispatchTarget(table: TableKey[], msg: string): TableKey | undefined {
    return table.find(k => (k.prefix ? msg.startsWith(k.command) : msg === k.command));
}

function check(): number {
    const table = readCommandTable();
    const covered = new Set<string>();
    const errors: string[] = [];

    for (const section of ALL_HELP_SECTIONS) {
        for (const entry of section.entries) {
            for (const alt of alternatives(entry)) {
                const target = dispatchTarget(table, sampleMessage(alt));
                if (!target) errors.push(`help.ts "${section.title}": "/bot ${alt}" reaches no command`);
                else covered.add(target.command);
            }
        }
    }

    const hidden = new Set(HIDDEN_COMMANDS.map(h => h.command));
    for (const h of HIDDEN_COMMANDS) {
        if (!table.some(k => k.command === h.command)) errors.push(`HIDDEN_COMMANDS lists "${h.command}", which is not in commandTable`);
    }
    for (const key of table) {
        if (!covered.has(key.command) && !hidden.has(key.command)) {
            errors.push(`"${key.command.trim()}" is in commandTable but not in the help (add it to help.ts, or to HIDDEN_COMMANDS with a reason)`);
        }
    }

    const expected = renderCommandsPage();
    const actual = fs.existsSync(COMMANDS_MD) ? fs.readFileSync(COMMANDS_MD, "utf8").replace(/\r\n/g, "\n") : "";
    if (actual !== expected) errors.push("wiki/Commands.md is out of date — run npm run wiki");

    if (errors.length) {
        console.error(`Help check FAILED (${errors.length}):`);
        for (const e of errors) console.error("  - " + e);
        return 1;
    }
    console.log(`Help check passed: ${table.length} commands, ${covered.size} described, ${hidden.size} hidden on purpose.`);
    return 0;
}

// ---- wiki/Commands.md ---------------------------------------------------

const WIKI_CTX: HelpContext = { isAdmin: true, tournamentRunning: true, teamGameRunning: false };

function cell(text: string): string {
    return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderWikiSection(section: HelpSection): string {
    const lines: string[] = [`## ${section.title}`, ""];
    if (section.intro) lines.push(section.intro, "");
    lines.push("| Command | What it does |", "|---|---|");
    for (const entry of section.entries) {
        const usage = alternatives(entry).map(a => "`/bot " + cell(a) + "`").join(" · ");
        const tags = [entry.adminOnly ? "*(admin)*" : "", entry.tournamentOnly ? "*(while a tournament is on)*" : ""].filter(Boolean);
        lines.push(`| ${usage} | ${[...tags, cell(entryText(entry, WIKI_CTX))].join(" ")} |`);
    }
    if (section.outro) lines.push("", section.outro);
    lines.push("");
    return lines.join("\n");
}

export function renderCommandsPage(): string {
    const head = [
        "# Commands",
        "",
        "<!-- Generated from src/help.ts by `npm run wiki`. Edit help.ts, not this page. -->",
        "",
        "Type **`/bot`** and a command straight into the chat box, e.g. `/bot join`. Only the bot sees it, so the room stays quiet. The bot answers by whisper.",
        "",
        `> ${BANG_NOTE} Commands you type with ! in room chat work as before too, though everyone sees them.`,
        "",
        "Words in `[brackets]` are what you fill in. Answers to the bot's questions (yes, no, 1, 2...) can be whispered or sent as `/bot yes`.",
        "",
    ].join("\n");
    return head + "\n" + ALL_HELP_SECTIONS.map(renderWikiSection).join("\n");
}

function writeWiki(): number {
    fs.mkdirSync(path.dirname(COMMANDS_MD), { recursive: true });
    fs.writeFileSync(COMMANDS_MD, renderCommandsPage(), "utf8");
    console.log(`Wrote ${path.relative(ROOT, COMMANDS_MD)}`);
    return 0;
}

const mode = process.argv[2];
process.exit(mode === "wiki" ? writeWiki() : check());
