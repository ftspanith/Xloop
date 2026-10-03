const fs = require('fs');
const path = require('path');
const glob = require('glob');

const files = glob.sync('public/admin/*.html');

const standardNav = `    <nav class="admin-nav">
      <a href="/admin/dashboard.html">Dashboard</a>
      <a href="/admin/add-movie.html">+ Add Movie</a>
      <a href="/admin/add-series.html">+ Add Series</a>
      <a href="/admin/add-manual.html">Smart Add</a>
      <a href="/admin/bulk-import.html">Bulk Import</a>
      <a href="/admin/manager.html">Content Manager</a>
      <a href="/admin/fix-posters.html">Fix Posters</a>
      <a href="/admin/collection.html">Collection Master</a>
      <a href="/admin/scraper.html">Scraper</a>
      <a href="/" target="_blank" style="margin-top:auto;border-top:1px solid var(--border);border-radius:0;padding-top:16px;">View Site ↗</a>
      <a href="#" onclick="logout()" style="color:var(--red);">Logout</a>
    </nav>`;

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  const basename = path.basename(file);
  
  // Inject active class
  let customizedNav = standardNav.replace(
    `href="/admin/${basename}"`,
    `href="/admin/${basename}" class="active"`
  );

  // Replace existing nav
  const updatedContent = content.replace(/<nav class="admin-nav">[\s\S]*?<\/nav>/, customizedNav);
  
  if (content !== updatedContent) {
    fs.writeFileSync(file, updatedContent);
    console.log(`Updated nav in ${file}`);
  }
});
