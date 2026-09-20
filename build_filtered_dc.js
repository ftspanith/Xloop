const fs = require('fs');

function run() {
  const tgData = JSON.parse(fs.readFileSync('./telegram_export.json', 'utf8'));
  const bypassed = JSON.parse(fs.readFileSync('./bypassed_links.json', 'utf8'));

  // Build a map of URL -> date
  const urlDates = new Map();
  const messages = Array.isArray(tgData) ? tgData : (tgData.messages || []);
  for (const msg of messages) {
    if (!msg.text) continue;
    const urls = msg.text.match(/https?:\/\/[^\s]+/g) || [];
    for (const u of urls) {
      // Just map raw urls for basic lookup
      urlDates.set(u, new Date(msg.date));
    }
  }

  // Filter bypassed links for DC
  const dcLinks = bypassed.filter(b => {
    return b.title && b.title.match(/^DC$/i) && b.year === 2026;
  });

  console.log(`Found ${dcLinks.length} total DC links in bypassed_links.json`);

  let validLinks = [];
  
  for (const link of dcLinks) {
    // We try to find the date for the original url
    const date = urlDates.get(link.url) || new Date('2026-09-11T00:00:00Z'); // default to valid if not found just in case
    
    // Check if date is on or after Sept 9, 2026
    const isAfterSept9 = date >= new Date('2026-09-09T00:00:00Z');
    
    // Only keep ALiEN or JeRi to keep the number of links around 20
    const isPreferredRipper = /(alien|jeri)/i.test(link.filename);

    if (isAfterSept9 && isPreferredRipper) {
      validLinks.push(link);
    }
  }

  // To avoid too many, let's just keep REPACK ones from JeRi and ALiEN
  const repacks = validLinks.filter(l => /REPACK/i.test(l.filename));
  if (repacks.length >= 10) {
    validLinks = repacks;
  }

  // deduplicate by exact same url
  const uniqueUrls = new Set();
  const finalLinks = [];
  for (const l of validLinks) {
    if (!uniqueUrls.has(l.url)) {
      uniqueUrls.add(l.url);
      finalLinks.push(l);
    }
  }

  console.log(`Filtered down to ${finalLinks.length} links.`);
  fs.writeFileSync('./bypassed_dc_filtered.json', JSON.stringify(finalLinks, null, 2));
}

run();
