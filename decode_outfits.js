const fs = require('fs');
const path = require('path');
const LZString = require('./node_modules/lz-string');

const outfitsPath = path.join(__dirname, 'outfits.json');
const outputPath = path.join(__dirname, 'decode_output.txt');

const raw = fs.readFileSync(outfitsPath, 'utf8');
const data = JSON.parse(raw);
const outfits = data.outfits || data;

const lines = [];
const errors = [];

// tally[slot][asset] = [outfitName, ...]
const tally = {};

for (const outfit of outfits) {
  const outfitName = outfit.name || '(unnamed)';
  let items = null;

  try {
    if (outfit.code) {
      const decoded = LZString.decompressFromBase64(outfit.code);
      if (!decoded) throw new Error('decompressFromBase64 returned null/empty');
      const parsed = JSON.parse(decoded);
      // BC appearance export is an array of item objects
      items = Array.isArray(parsed) ? parsed : (parsed.items || []);
    } else if (outfit.items) {
      items = outfit.items;
    } else {
      errors.push(`[${outfitName}] No 'code' or 'items' field found.`);
      continue;
    }

    for (const item of items) {
      // Handle both BC format (Group/Name) and direct format (group/name)
      const slot = item.Group || item.group || '(unknown slot)';
      const asset = item.Name || item.Asset || item.name || '(unknown asset)';

      if (!tally[slot]) tally[slot] = {};
      if (!tally[slot][asset]) tally[slot][asset] = [];
      tally[slot][asset].push(outfitName);
    }
  } catch (err) {
    errors.push(`[${outfitName}] ERROR: ${err.message}`);
  }
}

lines.push('=== OUTFIT ITEM TALLY ===');
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push('');

if (errors.length > 0) {
  lines.push('=== ERRORS ===');
  for (const e of errors) lines.push(e);
  lines.push('');
}

const slots = Object.keys(tally).sort();
for (const slot of slots) {
  lines.push(`--- ${slot} ---`);
  const assets = Object.keys(tally[slot]).sort();
  for (const asset of assets) {
    const usedBy = tally[slot][asset];
    lines.push(`  ${asset} (${usedBy.length} outfit${usedBy.length !== 1 ? 's' : ''}): ${usedBy.join(', ')}`);
  }
  lines.push('');
}

lines.push(`=== SUMMARY ===`);
lines.push(`Total slots: ${slots.length}`);
lines.push(`Total unique (slot, asset) pairs: ${slots.reduce((n, s) => n + Object.keys(tally[s]).length, 0)}`);
lines.push(`Outfits processed: ${outfits.length - errors.length} / ${outfits.length}`);
lines.push(`Errors: ${errors.length}`);

fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
console.log('Done. Output written to decode_output.txt');
