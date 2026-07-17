// ============================================================
// FEEDBACK SYSTEM - player feedback collection (!feedback), the
// admin proxy-submission flow, per-item status tracking shown back
// to submitters (!setstatus / join notifications), and the admin
// !feedback list view. Owns all feedback state; file I/O goes
// through storage, shared services through GameHost.
// ============================================================
import { centralTimestamp, log } from "./logger";
import { GameHost } from "./host";
import { FeedbackItemStatus, FeedbackStatusEntry } from "./types";
import {
    ADMIN_FEEDBACK_PROXY_TIMEOUT_MS, FEEDBACK_STATUS_LABELS,
    RESOLVED_FEEDBACK_STATUSES, REVIEWING_FEEDBACK_STATUSES,
} from "./constants";

export class FeedbackManager {
    private feedbackStatus: Record<string, FeedbackStatusEntry> = {};
    // Members already shown their status updates this session (once per join).
    private feedbackNotified: Set<number> = new Set();
    // Everyone who has ever submitted feedback (seeded from feedback.log).
    private feedbackMemberNumbers: Set<number> = new Set();
    // Members who sent a bare "!feedback" and owe us their next whisper.
    private pendingFeedbackRequest: Set<number> = new Set();
    // Admin proxy-feedback confirmation, keyed by admin member number. Set
    // when an admin runs "!feedback <room member name> <text>" so a follow-up
    // yes/no whisper can confirm logging it under the target player's name.
    private pendingAdminFeedbackProxy: Map<number, { targetMemberNumber: number; targetName: string; text: string; timeout: NodeJS.Timeout }> = new Map();

    constructor(private readonly host: GameHost) {
        this.feedbackStatus = host.storage.loadFeedbackStatus();
        this.feedbackMemberNumbers = host.storage.loadFeedbackMemberNumbers();
    }

    // True if this member has ever submitted feedback (used for the
    // feedbackGiven flag on player records).
    public hasGivenFeedback(memberNumber: number): boolean {
        return this.feedbackMemberNumbers.has(memberNumber);
    }

    // Bare "!feedback": remember that this member's next whisper is their
    // feedback text. Returns via consumePendingRequest() in handleWhisper.
    public handlePrompt(memberNumber: number): void {
        this.pendingFeedbackRequest.add(memberNumber);
        this.host.bot.whisper(memberNumber, "What's your feedback? Go ahead and whisper it to me and I'll pass it along! 💬");
    }

    // Clears and reports a pending bare-"!feedback" request for this member.
    public consumePendingRequest(memberNumber: number): boolean {
        if (!this.pendingFeedbackRequest.has(memberNumber)) return false;
        this.pendingFeedbackRequest.delete(memberNumber);
        return true;
    }

    public handleFeedback(memberNumber: number, name: string, message: string): void {
        const text = message.trim().slice("!feedback ".length).trim();
        if (!text) {
            this.host.bot.whisper(memberNumber, "Please include your feedback! e.g. !feedback The game was great but...");
            return;
        }

        // Admin proxy: "!feedback <room member name> <text>" logs the feedback
        // under that player's name/number instead of the admin's, after a
        // yes/no confirmation. Falls through to normal behavior if the first
        // word doesn't match anyone currently in the room.
        if (this.host.isAdmin(memberNumber)) {
            const spaceIdx = text.indexOf(" ");
            if (spaceIdx !== -1) {
                const firstWord = text.slice(0, spaceIdx);
                const rest = text.slice(spaceIdx + 1).trim();
                const target = rest ? this.host.matchRoomMemberByName(firstWord) : undefined;
                if (target && target.memberNumber !== memberNumber) {
                    this.startAdminProxy(memberNumber, target, rest);
                    return;
                }
            }
        }

        this.logEntry(memberNumber, name, text);
        this.host.bot.whisper(memberNumber, "Thank you for your feedback! 💬 We read everything and really appreciate it.");
    }

    // Public entry point for code that wants to log feedback on behalf of a
    // player without going through the "!feedback <text>" command. Used by the
    // solo prize question flow to capture inline descriptions.
    public submitDirect(memberNumber: number, name: string, text: string): void {
        this.logEntry(memberNumber, name, text);
        this.host.bot.whisper(memberNumber, "Got it — saved your idea! 💬 We really appreciate it.");
    }

    // Appends a feedback.log line and updates feedback-tracking state for the
    // given member/name. Shared by normal feedback submission and the admin
    // proxy-feedback confirmation, which logs under the target player's
    // identity rather than the submitting admin's.
    private logEntry(memberNumber: number, name: string, text: string): void {
        const timestamp = centralTimestamp();
        this.host.storage.appendFeedbackLog(`[${timestamp}] ${name} (#${memberNumber}): ${text}\n`);
        log(`Feedback from ${name}: ${text}`);
        this.feedbackMemberNumbers.add(memberNumber);

        const key = String(memberNumber);
        const entry = this.feedbackStatus[key] ?? { name, items: [] };
        entry.name = name;
        entry.items.push({ timestamp, text, status: "reviewing" });
        this.feedbackStatus[key] = entry;
        this.host.storage.saveFeedbackStatus(this.feedbackStatus);

        this.host.markFeedbackGiven(memberNumber);
    }

    // Starts (or restarts) the yes/no confirmation window for an admin's
    // proxied feedback submission on behalf of a room member.
    private startAdminProxy(adminMemberNumber: number, target: { memberNumber: number; name: string }, text: string): void {
        const existing = this.pendingAdminFeedbackProxy.get(adminMemberNumber);
        if (existing) clearTimeout(existing.timeout);

        const timeout = setTimeout(() => {
            this.pendingAdminFeedbackProxy.delete(adminMemberNumber);
            this.host.bot.whisper(adminMemberNumber, "Feedback proxy confirmation timed out — nothing was logged.");
        }, ADMIN_FEEDBACK_PROXY_TIMEOUT_MS);

        this.pendingAdminFeedbackProxy.set(adminMemberNumber, {
            targetMemberNumber: target.memberNumber,
            targetName: target.name,
            text,
            timeout,
        });

        this.host.bot.whisper(
            adminMemberNumber,
            `Did you mean to submit this feedback on behalf of **${target.name}**? Reply **yes** to confirm or **no** to cancel.`
        );
    }

    // Yes/No confirmation for a pending admin proxy-feedback submission.
    // Returns true if the message was consumed as a yes/no answer.
    public tryHandleProxyYesNo(memberNumber: number, msg: string): boolean {
        const pending = this.pendingAdminFeedbackProxy.get(memberNumber);
        if (!pending) return false;
        if (msg === "yes" || msg === "y") {
            clearTimeout(pending.timeout);
            this.pendingAdminFeedbackProxy.delete(memberNumber);
            this.logEntry(pending.targetMemberNumber, pending.targetName, pending.text);
            this.host.bot.whisper(memberNumber, `Feedback logged on behalf of ${pending.targetName}.`);
            return true;
        }
        if (msg === "no" || msg === "n") {
            clearTimeout(pending.timeout);
            this.pendingAdminFeedbackProxy.delete(memberNumber);
            this.host.bot.whisper(memberNumber, "Feedback cancelled.");
            return true;
        }
        return false;
    }

    // Admin: !setstatus [playerID] [status] — updates every feedback item for
    // that player and re-arms the join notification for resolved statuses.
    public handleSetStatus(memberNumber: number, message: string): void {
        if (!this.host.requireAdmin(memberNumber)) return;
        const parts = message.trim().split(/\s+/);
        const playerId = parts[1];
        const status = (parts[2] ?? "").toLowerCase() as FeedbackItemStatus;
        const validStatuses: FeedbackItemStatus[] = ["reviewing", "testing", "researching", "implemented", "partly_implemented"];

        if (!playerId || !/^\d+$/.test(playerId)) {
            this.host.bot.whisper(memberNumber, "Usage: !setstatus [playerID] [status]");
            return;
        }
        if (!validStatuses.includes(status)) {
            this.host.bot.whisper(memberNumber, `Invalid status. Valid statuses: ${validStatuses.join(", ")}`);
            return;
        }

        const entry = this.feedbackStatus[playerId];
        if (!entry || entry.items.length === 0) {
            this.host.bot.whisper(memberNumber, `No feedback found for player #${playerId}.`);
            return;
        }

        for (const item of entry.items) {
            item.status = status;
            item.statusShown = false;
        }
        this.host.storage.saveFeedbackStatus(this.feedbackStatus);
        this.host.bot.whisper(memberNumber, `Updated ${entry.items.length} feedback item(s) for ${entry.name} (#${playerId}) to "${status}".`);
    }

    // On join: whisper any unshown resolved-status updates, plus a single
    // bundled "we're reviewing it" ack for newly received in-progress items.
    public notifyStatus(memberNumber: number, name: string): void {
        if (this.feedbackNotified.has(memberNumber)) return;
        const entry = this.feedbackStatus[String(memberNumber)];
        if (!entry || entry.items.length === 0) return;
        this.feedbackNotified.add(memberNumber);

        let changed = false;

        const resolvedToShow = entry.items.filter(item =>
            RESOLVED_FEEDBACK_STATUSES.has(item.status) && !item.statusShown
        );
        if (resolvedToShow.length > 0) {
            const lines = resolvedToShow.map((item, i) =>
                `${i + 1}. "${item.text}" — ${FEEDBACK_STATUS_LABELS[item.status] ?? item.status}`
            );
            this.host.sendLongWhisper(memberNumber,
                `Hi ${name}! Here's an update on the feedback you've sent us:\n` +
                lines.join("\n") +
                `\n\nThanks for helping us improve the game! 💕`
            );
            for (const item of resolvedToShow) {
                item.statusShown = true;
            }
            changed = true;
        }

        const reviewingItems = entry.items.filter(item => REVIEWING_FEEDBACK_STATUSES.has(item.status));
        if (reviewingItems.length > 0) {
            const ackDate = entry.reviewingAckDate ? new Date(entry.reviewingAckDate) : null;
            const hasNewSinceAck = reviewingItems.some(item => !ackDate || new Date(item.timestamp) > ackDate);
            if (hasNewSinceAck) {
                this.host.sendLongWhisper(memberNumber,
                    `Hi ${name}! We've received your feedback and are reviewing it. We'll let you know when there's an update!`
                );
                entry.reviewingAckDate = new Date().toISOString();
                changed = true;
            }
        }

        if (changed) this.host.storage.saveFeedbackStatus(this.feedbackStatus);
    }

    // Admin: !feedback list — every player's feedback items with statuses.
    public handleList(memberNumber: number): void {
        if (!this.host.requireAdmin(memberNumber)) return;

        const entries = Object.entries(this.feedbackStatus).filter(([k]) => !k.startsWith("_"));
        if (entries.length === 0) {
            this.host.bot.whisper(memberNumber, "No feedback recorded yet.");
            return;
        }

        const lines: string[] = [];
        for (const [playerId, entry] of entries) {
            lines.push(`${entry.name} (#${playerId}):`);
            entry.items.forEach((item, i) => {
                lines.push(`  ${i + 1}. [${FEEDBACK_STATUS_LABELS[item.status] ?? item.status}] ${item.text}`);
            });
        }

        this.host.sendLongWhisper(memberNumber, `=== Feedback Status ===\n${lines.join("\n")}`);
    }
}
