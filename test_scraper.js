const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const html = fs.readFileSync('public/admin/scraper.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously' });
try {
  dom.window.generateCommand();
  console.log('Success!', dom.window.document.getElementById('commandPanel').style.display);
} catch (e) {
  console.error('Error:', e);
}
