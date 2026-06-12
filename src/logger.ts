// The bot can be launched in different ways (directly, via the cmd.exe/
// PowerShell wrapper, etc.) and the host's local timezone isn't reliable
// across those, so we apply a fixed UTC-5 offset to the actual UTC time
// instead of relying on the system's local timezone at all.
// NOTE: UTC-5 is CDT. This will be off by 1 hour during CST in winter
// (UTC-6) since we don't account for DST here.
const CENTRAL_OFFSET_MS = 5 * 60 * 60 * 1000;

function centralNow(): Date {
    return new Date(Date.now() - CENTRAL_OFFSET_MS);
}

// ISO-style timestamp in US Central time, for log files (e.g. feedback.log,
// lock_release_log.txt, feedback_status.json).
export function centralTimestamp(): string {
    return centralNow().toISOString().replace("Z", "-05:00");
}

// HH:MM:SS in US Central time. Built from the UTC ISO string rather than
// toLocaleTimeString so it isn't double-shifted by the system's local
// timezone.
function centralTimeString(): string {
    return centralNow().toISOString().substring(11, 19);
}

export function log(msg: string): void {
    console.log(`[${centralTimeString()}] ${msg}`);
}

export function logError(msg: string): void {
    console.error(`[${centralTimeString()}] ERROR: ${msg}`);
}

export function logEvent(event: string, data?: any): void {
    console.log(`[${centralTimeString()}] EVENT: ${event}`, JSON.stringify(data, null, 2));
}
