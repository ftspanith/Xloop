const parser = require('./utils/parser');
const rawText = `‼️ #BLURAY #REMUX #2160P #MULTi #HEVC\n\nThe.Death.of.Robin.Hood.2026.mkv\nhttps://gdflix.dev/file/abc`;
console.log(parser.parseMessageBlock(rawText, 1918, "2026"));
