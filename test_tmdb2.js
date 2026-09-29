const { searchTMDB } = require('./import_bypassed');
searchTMDB('Test', 2026, false, null, null, null, null).then(r => console.log(r)).catch(e => console.log(e.message));
