const fs = require('fs');
const glob = require('glob');

const files = glob.sync('public/admin/*.html');

let dashHtml = fs.readFileSync('public/admin/dashboard.html', 'utf8');
let match = dashHtml.match(/<!-- ── Mobile Bottom Navigation Bar ── -->[\s\S]*?<\/nav>\n<script>\n\(function\(\)\{[\s\S]*?\}\)\(\);\n<\/script>/);

if (!match) {
  console.log("Could not find bottom nav block in dashboard.html");
  process.exit(1);
}

const standardNav = match[0];

files.forEach(file => {
  if (file.includes('dashboard.html')) return;
  let content = fs.readFileSync(file, 'utf8');
  
  // Replace anything that looks like a bottom nav
  let updatedContent = content.replace(/<!-- ── Mobile Bottom Navigation Bar ── -->[\s\S]*?(?:<\/script>|<\/nav>)/, standardNav);
  
  if (content !== updatedContent) {
    fs.writeFileSync(file, updatedContent);
    console.log(`Updated bottom nav in ${file}`);
  }
});
