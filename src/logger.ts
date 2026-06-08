export function log(msg: string): void {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] ${msg}`);
}

export function logError(msg: string): void {
    const time = new Date().toLocaleTimeString();
    console.error(`[${time}] ERROR: ${msg}`);
}

export function logEvent(event: string, data?: any): void {
    const time = new Date().toLocaleTimeString();
    if (event === "ChatRoomSyncItem") {
        // Full output for item events - no truncation
        console.log(`[${time}] EVENT: ${event}`, JSON.stringify(data, null, 2));
    } else {
        console.log(`[${time}] EVENT: ${event}`, data ? JSON.stringify(data).slice(0, 120) : "");
    }
}