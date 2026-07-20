// ============================================================
// BOT STORAGE - every data file the bot reads or writes, in one
// place. Stateless: each method loads from or saves to disk and
// returns; in-memory caches live with the code that owns them.
//
// Adding a new persisted file? Give it a path here and a load/save
// (or append) pair below — don't call fs from game logic.
// ============================================================
import * as fs from "fs";
import * as path from "path";
import { log } from "./logger";
import {
    ChangelogEntry, FeedbackStatusEntry, GameLogEntry, ItemSettingsLibrary, OutfitSuggestion,
    PlayerRecord, SoloRecordsData,
} from "./types";
import { CHANGELOG_MAX_ENTRIES, GAME_LOG_RETENTION_MS } from "./constants";
import { emptySoloRecordsData, utcDateString } from "./util";

export interface GameCounts {
    multiplayer: number;
    solo_strip: number;
    solo_bondage: number;
    aborted: number;
    team_2v2: number;
    team_3v3: number;
    toysDeclineCount: number;
    lastUpdated: string;
}

export class BotStorage {
    private readonly baseDir = path.join(__dirname, "..");
    private readonly soloRecordsPath = path.join(this.baseDir, "solo_records.json");
    private readonly gameLogPath = path.join(this.baseDir, "game_log.json");
    private readonly botStatePath = path.join(this.baseDir, "bot_state.json");
    private readonly gameCountsPath = path.join(this.baseDir, "game_counts.json");
    private readonly playerRecordsPath = path.join(this.baseDir, "players.json");
    private readonly feedbackStatusPath = path.join(this.baseDir, "feedback_status.json");
    private readonly feedbackLogPath = path.join(this.baseDir, "feedback.log");
    private readonly outfitSuggestionsPath = path.join(this.baseDir, "outfit_suggestions.json");
    private readonly itemSettingsPath = path.join(this.baseDir, "item_settings.json");
    private readonly bondageUsagePath = path.join(this.baseDir, "bondage_usage.json");
    private readonly outfitCandidatesPath = path.join(this.baseDir, "outfit_candidates.json");
    private readonly changelogPath = path.join(this.baseDir, "changelog.json");

    // ---- changelog ---------------------------------------------------

    // Shipped updates, oldest first. Grown by one entry each time the bot
    // restarts onto a pending_update.txt version it hasn't recorded yet.
    loadChangelog(): ChangelogEntry[] {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.changelogPath, "utf8"));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    // No-op if this version is already recorded, so a restart that doesn't
    // bring a new update can't duplicate the last entry.
    appendChangelogEntry(entry: ChangelogEntry): void {
        const entries = this.loadChangelog();
        if (entries.some(e => e.version === entry.version)) return;
        entries.push(entry);
        try {
            const trimmed = entries.slice(-CHANGELOG_MAX_ENTRIES);
            fs.writeFileSync(this.changelogPath, JSON.stringify(trimmed, null, 2), "utf8");
        } catch (err) {
            log("ERROR: Failed to write changelog.json: " + err);
        }
    }

    // ---- solo records ------------------------------------------------

    // Loads solo records, resetting the daily records/attempts if the UTC
    // date has rolled over since they were last written.
    loadSoloRecords(): SoloRecordsData {
        let data: SoloRecordsData;
        try {
            const raw = fs.readFileSync(this.soloRecordsPath, "utf8");
            data = JSON.parse(raw);
        } catch {
            data = emptySoloRecordsData();
        }

        const today = utcDateString();
        if (data.date !== today) {
            data.date = today;
            data.daily = { race: {}, survive: {} };
            data.attempts = { race: {}, survive: {} };
        }

        return data;
    }

    saveSoloRecords(data: SoloRecordsData): void {
        try {
            fs.writeFileSync(this.soloRecordsPath, JSON.stringify(data, null, 2), "utf8");
        } catch (err) {
            log("ERROR: Failed to write solo_records.json: " + err);
        }
    }

    // ---- game activity log -------------------------------------------

    // Appends one NDJSON line to game_log.json for a completed game (multiplayer or solo).
    appendGameLog(entry: GameLogEntry): void {
        try {
            fs.appendFileSync(this.gameLogPath, JSON.stringify(entry) + "\n", "utf8");
        } catch (err) {
            log("ERROR: Failed to write game_log.json: " + err);
        }
    }

    // Drops game_log.json entries older than 30 days. Called once on startup.
    pruneGameLog(): void {
        try {
            if (!fs.existsSync(this.gameLogPath)) return;
            const raw = fs.readFileSync(this.gameLogPath, "utf8");
            const cutoff = Date.now() - GAME_LOG_RETENTION_MS;

            const kept = raw.split("\n")
                .filter(line => line.trim().length > 0)
                .filter(line => {
                    try {
                        const entry: GameLogEntry = JSON.parse(line);
                        return new Date(entry.endTime).getTime() >= cutoff;
                    } catch {
                        return false;
                    }
                });

            fs.writeFileSync(this.gameLogPath, kept.map(line => line + "\n").join(""), "utf8");
        } catch (err) {
            log("ERROR: Failed to prune game_log.json: " + err);
        }
    }

    // ---- bot state snapshot --------------------------------------------

    // Writes a small status snapshot read by external monitoring tools.
    writeBotState(activeMultiplayer: boolean, activeSoloCount: number): void {
        const state = {
            activeMultiplayer,
            activeSoloCount,
            lastUpdated: new Date().toISOString(),
        };
        try {
            fs.writeFileSync(this.botStatePath, JSON.stringify(state, null, 2), "utf8");
        } catch (err) {
            log("ERROR: Failed to write bot_state.json: " + err);
        }
    }

    // ---- game counts ---------------------------------------------------

    loadGameCounts(): GameCounts {
        try {
            const raw = fs.readFileSync(this.gameCountsPath, "utf8");
            const parsed = JSON.parse(raw);
            parsed.team_2v2 ??= 0;
            parsed.team_3v3 ??= 0;
            return parsed;
        } catch {
            return { multiplayer: 0, solo_strip: 0, solo_bondage: 0, aborted: 0, team_2v2: 0, team_3v3: 0, toysDeclineCount: 0, lastUpdated: new Date().toISOString() };
        }
    }

    incrementGameCount(type: "multiplayer" | "solo_strip" | "solo_bondage" | "aborted" | "team_2v2" | "team_3v3"): void {
        const counts = this.loadGameCounts();
        counts[type]++;
        counts.lastUpdated = new Date().toISOString();
        this.saveGameCounts(counts);
    }

    // Running total across all games of explicit "no" answers to the toys
    // consent question (late-join timeouts/declines are NOT counted here —
    // only players who actually answered "no").
    incrementToysDeclineCount(): void {
        const counts = this.loadGameCounts();
        counts.toysDeclineCount = (counts.toysDeclineCount ?? 0) + 1;
        counts.lastUpdated = new Date().toISOString();
        this.saveGameCounts(counts);
    }

    private saveGameCounts(counts: GameCounts): void {
        try {
            fs.writeFileSync(this.gameCountsPath, JSON.stringify(counts, null, 2), "utf8");
        } catch (err) {
            log(`ERROR: Failed to write game_counts.json: ${err}`);
        }
    }

    // ---- player records --------------------------------------------------

    loadPlayerRecords(): Record<string, PlayerRecord> {
        try {
            const raw = fs.readFileSync(this.playerRecordsPath, "utf8");
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }

    savePlayerRecords(records: Record<string, PlayerRecord>): void {
        try {
            fs.writeFileSync(this.playerRecordsPath, JSON.stringify(records, null, 2), "utf8");
        } catch (err) {
            log("ERROR: Failed to write players.json: " + err);
        }
    }

    // ---- feedback --------------------------------------------------------

    loadFeedbackStatus(): Record<string, FeedbackStatusEntry> {
        try {
            const raw = fs.readFileSync(this.feedbackStatusPath, "utf8");
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }

    saveFeedbackStatus(status: Record<string, FeedbackStatusEntry>): void {
        try {
            fs.writeFileSync(this.feedbackStatusPath, JSON.stringify(status, null, 2), "utf8");
        } catch (err) {
            log("ERROR: Failed to write feedback_status.json: " + err);
        }
    }

    appendFeedbackLog(line: string): void {
        try {
            fs.appendFileSync(this.feedbackLogPath, line, "utf8");
        } catch (err) {
            log("ERROR: Failed to write feedback.log: " + err);
        }
    }

    // Reads feedback.log and returns the set of member numbers that have
    // submitted feedback, e.g. lines like "... Missy (#208543): ...".
    loadFeedbackMemberNumbers(): Set<number> {
        const memberNumbers = new Set<number>();
        try {
            const raw = fs.readFileSync(this.feedbackLogPath, "utf8");
            for (const match of raw.matchAll(/\(#(\d+)\)/g)) {
                memberNumbers.add(Number(match[1]));
            }
        } catch {
            // No feedback log yet
        }
        return memberNumbers;
    }

    // ---- outfit suggestions ------------------------------------------------

    loadOutfitSuggestions(): OutfitSuggestion[] {
        try {
            const raw = fs.readFileSync(this.outfitSuggestionsPath, "utf8");
            return JSON.parse(raw);
        } catch {
            return [];
        }
    }

    saveOutfitSuggestions(suggestions: OutfitSuggestion[]): void {
        try {
            fs.writeFileSync(this.outfitSuggestionsPath, JSON.stringify(suggestions, null, 2), "utf8");
        } catch (err) {
            log("ERROR: Failed to write outfit_suggestions.json: " + err);
        }
    }

    // ---- item settings library ------------------------------------------------

    loadItemSettings(): ItemSettingsLibrary {
        try {
            if (fs.existsSync(this.itemSettingsPath)) {
                return JSON.parse(fs.readFileSync(this.itemSettingsPath, "utf8"));
            }
        } catch (err) {
            log(`WARNING: Could not load item_settings.json — starting with empty settings library: ${err}`);
        }
        return {};
    }

    saveItemSettings(settings: ItemSettingsLibrary): void {
        try {
            fs.writeFileSync(this.itemSettingsPath, JSON.stringify(settings, null, 2), "utf8");
        } catch (err) {
            log(`ERROR: Failed to write item_settings.json: ${err}`);
        }
    }

    // ---- bondage usage popularity ---------------------------------------------

    loadBondageUsage(): Record<string, Record<string, number>> {
        try {
            if (fs.existsSync(this.bondageUsagePath)) {
                return JSON.parse(fs.readFileSync(this.bondageUsagePath, "utf8"));
            }
        } catch (err) {
            log(`WARNING: Could not load bondage_usage.json — starting with empty usage data: ${err}`);
        }
        return {};
    }

    saveBondageUsage(usage: Record<string, Record<string, number>>): void {
        try {
            fs.writeFileSync(this.bondageUsagePath, JSON.stringify(usage, null, 2), "utf8");
        } catch (err) {
            log(`ERROR: Failed to write bondage_usage.json: ${err}`);
        }
    }

    // ---- outfit candidates (player-pick selections for manual review) ----------

    appendOutfitCandidate(entry: any): number {
        try {
            let existing: any[] = [];
            if (fs.existsSync(this.outfitCandidatesPath)) {
                const parsed = JSON.parse(fs.readFileSync(this.outfitCandidatesPath, "utf8"));
                if (Array.isArray(parsed)) existing = parsed;
            }
            existing.push(entry);
            fs.writeFileSync(this.outfitCandidatesPath, JSON.stringify(existing, null, 2), "utf8");
            return existing.length;
        } catch (err) {
            log(`ERROR: Failed to write outfit_candidates.json: ${err}`);
            return -1;
        }
    }
}
