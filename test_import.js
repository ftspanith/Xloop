const fs = require('fs');
const code = fs.readFileSync('import_bypassed.js', 'utf8');
console.log(code.match(/title:\s*([^,]+)/g));
