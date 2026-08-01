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
