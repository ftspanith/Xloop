const { parseMessageBlock } = require('./utils/parser');
const text = `WEBRip x265 HEVC
10bit EAC3 5.1 MULTI
Atmos - ESub) - NazzY
- [ 3.29 GB ]
https://gdflix.dev/file/C4HaquUZKgib60H`;

console.log(JSON.stringify(parseMessageBlock(text), null, 2));
