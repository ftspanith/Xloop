const fs = require('fs');
const { parseMessageBlock } = require('./utils/parser');
const exportData = JSON.parse(fs.readFileSync('telegram_export.json', 'utf8'));
const msg = exportData.messages.find(m => m.id === 1918);
const { cleanTitleForApi, isJunkTitle, stripEmojis } = require('./utils/parser');
const lines=stripEmojis(msg.text).split('\n').map(l=>l.trim()).filter(l=>l.length>0);
for (const line of lines) {
  const c = cleanTitleForApi(line);
  console.log(`LINE: ${line}`);
  console.log(`cleanTitleForApi: [${c}]`);
  console.log(`isJunkTitle: ${isJunkTitle(line)}`);
  console.log("---");
}
