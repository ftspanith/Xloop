const fs = require('fs');
const f = require('../invite_tokens.json');
f.enabled = true;
fs.writeFileSync('./invite_tokens.json', JSON.stringify(f, null, 2));
console.log('[OK] Sharing enabled — members can access the site');
