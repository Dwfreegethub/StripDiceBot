// The bot's version, read once at startup from package.json — the single
// source of truth. Bump it there with every code change (patch for a fix,
// minor for a new feature or a change players have to learn). It shows on
// the online/reconnect lines, !about, !changelog and the startup log, so
// anyone can read back which build is running.
//
// require() rather than an import: package.json sits outside rootDir, and
// build/version.js resolves "../package.json" to the repo root at runtime.
let version = "unknown";
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    version = require("../package.json").version ?? "unknown";
} catch {
    // Missing or unreadable package.json — keep "unknown" rather than crash.
}

export const BOT_VERSION: string = version;
