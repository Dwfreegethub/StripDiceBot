const fs = require('fs');
const LZString = require('./node_modules/lz-string/libs/lz-string.js');

const data = JSON.parse(fs.readFileSync('./outfits.json', 'utf8'));

// tally[slot][assetName] = [outfitName, ...]
const tally = {};

for (const outfit of data.outfits) {
  let items = [];

  if (outfit.items) {
    items = outfit.items;
  } else if (outfit.code) {
    try {
      const decoded = LZString.decompressFromBase64(outfit.code);
      if (!decoded) throw new Error('decompressFromBase64 returned null');
      const parsed = JSON.parse(decoded);
      // BC outfit codes are arrays of item objects with Group/Asset fields
      items = Array.isArray(parsed) ? parsed : (parsed.Items || parsed.items || []);
    } catch (e) {
      console.error(`Failed to decode outfit "${outfit.name}": ${e.message}`);
      continue;
    }
  }

  for (const item of items) {
    // Items from code use Group/Asset; items array uses group/name
    const slot = item.Group || item.group;
    const asset = item.Asset || item.name;

    if (!slot || !asset) continue;

    if (!tally[slot]) tally[slot] = {};
    if (!tally[slot][asset]) tally[slot][asset] = [];
    if (!tally[slot][asset].includes(outfit.name)) {
      tally[slot][asset].push(outfit.name);
    }
  }
}

// Output grouped by slot, sorted by usage count desc
const slots = Object.keys(tally).sort();
for (const slot of slots) {
  console.log(`\n=== ${slot} ===`);
  const assets = Object.entries(tally[slot])
    .sort((a, b) => b[1].length - a[1].length);
  for (const [asset, outfits] of assets) {
    console.log(`  ${asset} (${outfits.length}): ${outfits.join(', ')}`);
  }
}
