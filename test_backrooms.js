const fs = require('fs');
const { parseMessageBlock } = require('./utils/parser');
const exportData = JSON.parse(fs.readFileSync('telegram_export.json', 'utf8'));
const msg = exportData.messages.find(m => m.text && m.text.includes('Backrooms'));
if (msg) {
  const result = parseMessageBlock(msg.text, msg.id, msg.date);
  console.log("TITLE IS:", result.title);
} else {
  console.log("NOT FOUND");
}
