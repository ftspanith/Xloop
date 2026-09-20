const { parseMessageBlock, isJunkTitle } = require('./utils/parser');
const data = require('./telegram_export.json');
let count = 0;
for (const msg of data.messages) {
  let rawText = '';
  if (typeof msg.text === 'string') rawText = msg.text;
  else if (Array.isArray(msg.text)) rawText = msg.text.map(p => p.text || (p.href ? p.href + '\n' : '')).join('');
  if (!rawText.trim()) continue;
  
  const parsed = parseMessageBlock(rawText, msg.id);
  if (!parsed) continue;
  if (!parsed.title || isJunkTitle(parsed.title)) {
     if (count < 20 && parsed.rawTitle && !parsed.rawTitle.match(/^@|http/)) {
         console.log(msg.id, "RAW TITLE:", parsed.rawTitle, "CLEAN TITLE:", parsed.title);
         count++;
     }
  }
}
