const fs = require('fs');
const f = require('../invite_tokens.json');
f.enabled = false;
fs.writeFileSync('./invite_tokens.json', JSON.stringify(f, null, 2));
console.log('🔒 Sharing disabled — all members locked out');
