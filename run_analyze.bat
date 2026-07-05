@echo off
cd /d D:\Games\BC-Bot\StripDiceBot
node analyze_outfits.js > analyze_output.txt 2>&1
if errorlevel 1 (
  node -e "const LZString=require('./node_modules/lz-string');const d=require('./outfits.json');const tally={};d.outfits.forEach(o=>{let items=o.items||(o.code?JSON.parse(LZString.decompressFromBase64(o.code)).filter(i=>!['ItemMisc','ItemDevices'].includes(i.Group)):[]);items.forEach(i=>{if(!tally[i.Group])tally[i.Group]={};if(!tally[i.Group][i.Asset])tally[i.Group][i.Asset]=[];tally[i.Group][i.Asset].push(o.name);});});Object.entries(tally).sort().forEach(([g,assets])=>{console.log(g+':');Object.entries(assets).forEach(([a,outfits])=>console.log('  '+a+' — '+outfits.join(', ')));});" > analyze_output.txt 2>&1
)
