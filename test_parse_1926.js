const fs = require('fs');
const { parseMessageBlock } = require('./utils/parser');
const exportData = JSON.parse(fs.readFileSync('telegram_export.json', 'utf8'));
const msg = exportData.messages.find(m => m.id === 1926);
const result = parseMessageBlock(msg.text, msg.id, msg.date);
console.log("TITLE IS:", result ? result.title : "null");
