const fs = require('fs');
const { parseMessageBlock } = require('./utils/parser');
const exportData = JSON.parse(fs.readFileSync('telegram_export.json', 'utf8'));
const msg = exportData.messages[13]; // Just get one of the Toy Story messages
// Ah wait I need to find the message by text
const target = exportData.messages.find(m => m.text && m.text.includes('Toy.Story.5'));
if (target) {
  const result = parseMessageBlock(target.text, target.id, target.date);
  console.log("RESULT:", result ? result.title : "null");
} else {
  console.log("MSG NOT FOUND");
}
