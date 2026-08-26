// ============================================================
// OUTFIT + CATALOG LOADING - reads outfits.json and bc_items.json
// at module load. BONDAGE_OUTFITS and BC_ITEM_CATALOG are the
// shared read-only results. Depends on types.ts, util.ts, logger.ts
// only — never import from game.ts here (load-order cycle).
// ============================================================
import * as fs from "fs";
import * as path from "path";
import * as LZString from "lz-string";
import { log } from "./logger";
import { BondageItem, BondageOutfit, OutfitDefinition } from "./types";
import { cleanDecodedProperty } from "./util";

// ============================================================
// BONDAGE OUTFITS - multiple sets, one is randomly chosen per
// player when they start receiving bondage items.
// Add more outfits to outfits.json as we confirm asset names.
// ============================================================
function loadBondageOutfits(): BondageOutfit[] {
    try {
        const filePath = path.join(__dirname, "..", "outfits.json");
        const raw = fs.readFileSync(filePath, "utf8");
        const data: { outfits: OutfitDefinition[] } = JSON.parse(raw);

        const outfits: BondageOutfit[] = [];

        for (const def of data.outfits) {
            if (def.code && def.groups) {
                const decompressed = LZString.decompressFromBase64(def.code);
                if (!decompressed) {
                    log(`Outfit "${def.name}": failed to decompress appearance code, skipping.`);
                    continue;
                }
                const appearance: any[] = JSON.parse(decompressed);
                const items: BondageItem[] = def.groups.map(group => {
                    const entry = appearance.find(e => e.Group === group);
                    if (!entry) {
                        throw new Error(`Outfit "${def.name}": group "${group}" not found in appearance code`);
                    }
                    return {
                        group: entry.Group,
                        name: entry.Name,
                        color: entry.Color,
                        property: cleanDecodedProperty(entry.Property)
                    };
                });
                outfits.push({ name: def.name, items });
            } else if (def.items) {
                outfits.push({ name: def.name, items: def.items });
            } else {
                throw new Error(`Outfit "${def.name}" has neither "items" nor "code"+"groups"`);
            }
        }

        return outfits;
    } catch (err) {
        log(`FATAL: Could not load outfits.json — check the file exists and is valid JSON: ${err}`);
        process.exit(1);
    }
}

export const BONDAGE_OUTFITS: BondageOutfit[] = loadBondageOutfits();

// Full BC item catalog (group -> item names), shared read-only reference that
// lives one level above the repo. Missing/invalid file disables player-pick
// mode (everyone silently gets outfit mode) rather than crashing the bot.
function loadBcItemCatalog(): Map<string, string[]> {
    const catalog = new Map<string, string[]>();
    try {
        const filePath = path.join(__dirname, "..", "..", "bc_items.json");
        const raw = fs.readFileSync(filePath, "utf8");
        const data: { group: string; items: string[] }[] = JSON.parse(raw);
        for (const entry of data) {
            if (entry?.group && Array.isArray(entry.items)) {
                catalog.set(entry.group, entry.items);
            }
        }
    } catch (err) {
        log(`WARNING: Could not load bc_items.json — player-pick bondage mode disabled: ${err}`);
    }
    return catalog;
}

export const BC_ITEM_CATALOG: Map<string, string[]> = loadBcItemCatalog();

// Per-item body requirements (group -> item -> BC prerequisite names), living
// beside bc_items.json. Generated from BC's own asset definitions rather than
// hand-maintained — see the generator notes in item_body_requirements.json.
// Only gated items appear; anything absent draws on any body.
//
// A missing or invalid file just disables fit marking (every item reads as
// displayable) rather than breaking the picker, same as the catalog above.
function loadItemBodyData(): {
    reqs: Map<string, Map<string, string[]>>;
    unknown: Map<string, Set<string>>;
} {
    const reqs = new Map<string, Map<string, string[]>>();
    const unknown = new Map<string, Set<string>>();
    try {
        const filePath = path.join(__dirname, "..", "..", "item_body_requirements.json");
        const raw = fs.readFileSync(filePath, "utf8");
        const data: {
            requirements?: Record<string, Record<string, string[]>>;
            unknownItems?: Record<string, string[]>;
        } = JSON.parse(raw);

        for (const [group, items] of Object.entries(data.requirements ?? {})) {
            const m = new Map<string, string[]>();
            for (const [name, prereqs] of Object.entries(items)) {
                if (Array.isArray(prereqs) && prereqs.length) m.set(name, prereqs);
            }
            if (m.size) reqs.set(group, m);
        }
        for (const [group, names] of Object.entries(data.unknownItems ?? {})) {
            if (Array.isArray(names) && names.length) unknown.set(group, new Set(names));
        }
    } catch (err) {
        log(`WARNING: Could not load item_body_requirements.json — pick lists won't flag items that can't display: ${err}`);
    }
    return { reqs, unknown };
}

const itemBodyData = loadItemBodyData();

export const BC_ITEM_BODY_REQS: Map<string, Map<string, string[]>> = itemBodyData.reqs;

// Catalog entries with no definition in vanilla BC. bc_items.json was
// harvested from a modded/Chinese client, so it carries names (乳胶口罩,
// EFMask, ...) the main server has never heard of. They can't apply at all,
// which makes them worse picks than a merely non-drawing item — without this
// they'd sort to the TOP of the list, since having no body requirement reads
// as "fits everyone".
export const BC_ITEM_UNKNOWN: Map<string, Set<string>> = itemBodyData.unknown;
