const fs = require('fs');
const parser = require('./utils/parser');

const msg = JSON.parse(fs.readFileSync('telegram_export.json', 'utf8')).messages.find(m => m.id === 1918);

// Proxy console.log to capture everything
const rawText = msg.text;
const emojiStripped=parser.stripEmojis(rawText);
console.log("emojiStripped:", JSON.stringify(emojiStripped));

const normalized=emojiStripped
  .replace(/^[A-Z0-9 _\-]{1,15}:\s*(https?:\/\/)/gim,'$1')
  .replace(/(?<![:/])\b(hubcloud\.(?:foo|lol|work|in|to|club|me|best|one)[^\/]*\/\S+)/gi,'https://$1')
  .replace(/(?<![:/])\b(gdflix\.(?:dev|to|one|link)\/\S+)/gi,'https://$1');

const lines=normalized.split('\n').map(l=>l.trim()).filter(l=>l.length>0);
console.log("lines:", lines);

let pairs = []; // I know pairs works
pairs.push({ rawFilename: 'The.Death...', url: 'https://gdflix.dev/file/PJY2mwX2mh2Zfuc' });

let masterTitle='';
for (const line of lines) {
  if (parser.isMetadataLine(line)) { console.log("isMetadataLine TRUE for:", line); continue; }
  const c=parser.cleanTitleForApi(line);
  if (c.length>=3&&!parser.isJunkTitle(line)) { masterTitle=line; break; }
}
console.log("masterTitle:", masterTitle);

let cleanedTitle = masterTitle;
console.log("BEFORE CUT:", cleanedTitle);

const firstTech = cleanedTitle.match(/\b(2160p|1080p|720p|480p|4[Kk]|UHD|WEB[-_.]?DL|WEBRip|HDRip|BluRay|BDRip|REMUX|HEVC|x265|x264|AVC|AV1|AMZN|NF|DSNP|ZEE5|SUNNXT|JIOHS|AHA|HMAX|HOTSTAR|CRKL|PCOK|DPLS)\b/i);
if (firstTech) {
  cleanedTitle = cleanedTitle.substring(0, firstTech.index);
}
console.log("AFTER FIRST TECH CUT:", cleanedTitle);

cleanedTitle = parser.cleanTitleForApi(cleanedTitle);
console.log("FINAL cleanTitleForApi:", cleanedTitle);
