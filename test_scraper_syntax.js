const fs = require('fs');
const html = fs.readFileSync('public/admin/scraper.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/g);
if (scriptMatch) {
  scriptMatch.forEach((script, idx) => {
    const code = script.replace(/<\/?script>/g, '');
    fs.writeFileSync(`test_script_${idx}.js`, code);
    try {
      require('child_process').execSync(`node -c test_script_${idx}.js`);
      console.log(`Script ${idx} OK`);
    } catch (e) {
      console.error(`Script ${idx} Syntax Error:`, e.message);
    }
  });
}
