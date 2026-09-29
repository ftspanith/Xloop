require('dotenv').config();
const { findTmdbMeta } = require('./import_bypassed');
async function run() {
  const result = await findTmdbMeta('Jumanji The Next Level', 2019, false);
  console.log(result);
}
run();
