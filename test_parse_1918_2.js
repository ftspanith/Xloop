const fs = require('fs');
const { parseMessageBlock } = require('./utils/parser');
const exportData = JSON.parse(fs.readFileSync('telegram_export.json', 'utf8'));
const msg = exportData.messages.find(m => m.id === 1918);
console.log(parseMessageBlock(msg.text, msg.id, msg.date));
