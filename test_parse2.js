const { parseMessageBlock } = require('./utils/parser');
const raw = `❤️‍🔥 #NF_WEBDL #MULTI_AUDIO \n\nhttps://hubcloud.one/drive/1\nMovie.2023.1080p.mkv`;
console.log(parseMessageBlock(raw, 1, "2026-09-26T00:00:00Z").title);
