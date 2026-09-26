require('dotenv').config();
const mongoose = require('mongoose');
const ExtractedLinkM = require('./models/ExtractedLink');
const Movie = require('./models/Movie');
const { cleanTitleForApi, detectHost } = require('./utils/parser');
const { searchTMDB, searchOMDB, toMB, detectCodecLocal, seasonFromFilename, recomputeAggregates } = require('./pipeline_full');

async function runLocalImport() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI, { family: 4 });
  console.log('Connected.');

  console.log('Wiping movies collection...');
  await Movie.deleteMany({});
  console.log('Wiped.');

  console.log('Fetching links...');
  const links = await ExtractedLinkM.find({}).lean();
  console.log(`Found ${links.length} links.`);

  const groups = {};
  for (const item of links) {
    if (item.host === 'Shortlink' && !item.bypassedUrl) continue;
    const cTitle = cleanTitleForApi(item.title || '', item.year);
    if (!cTitle) continue;
    const key = cTitle.toLowerCase() + '__' + (item.year || '');
    if (!groups[key]) groups[key] = { items: [], msgDate: item.date || null };
    groups[key].items.push(item);
  }
  
  const groupEntries = Object.entries(groups);
  console.log(`Grouped into ${groupEntries.length} unique titles.`);

  let added = 0, updated = 0, skipped = 0;

  for (let i = 0; i < groupEntries.length; i++) {
    const [titleKey, group] = groupEntries[i];
    let finalTitle = cleanTitleForApi(group.items[0].title || '', group.items[0].year) || group.items[0].title;
    const origLang2 = group.items[0].language || 'Multi';
    let tmdbData = await searchTMDB(finalTitle, group.items[0].year, null, null, group.msgDate);
    if (!tmdbData) tmdbData = await searchOMDB(finalTitle, group.items[0].year, null);
    
    const meta = tmdbData || {};
    const finalType = meta.type || 'movie';
    if (meta.title && meta.title.length > 1) finalTitle = meta.title;

    for (const item of group.items) {
      const host = detectHost(item.bypassedUrl || item.link);
      const url = item.bypassedUrl || item.link;
      const codec = detectCodecLocal(item.filename || item.title);
      const rep = item.parsed || {};
      const quality = item.quality || 'HD';
      const language = item.language || origLang2;
      const season = seasonFromFilename(item.filename || item.title);
      const size = item.size || '';
      
      const newDl = { quality, language, codec, season, episode: item.episode || null, links: [{ host, url }] };
      if (size) newDl.size = size;

      let dbRec = await Movie.findOne({ title: finalTitle, type: finalType });
      if (dbRec) {
        let matchedIdx = -1;
        const correctSeason = (finalType === 'series' || finalType === 'anime') ? (season || 1) : null;
        let newMB = toMB(size);

        for (let j = 0; j < dbRec.downloads.length; j++) {
          const ex = dbRec.downloads[j];
          const qualOk = ex.quality === quality;
          const seasOk = (finalType === 'series' || finalType === 'anime') ? (ex.season == correctSeason && ex.episode == (item.episode ?? null)) : true;
          const exactSizeMatch = (newMB > 0 && toMB(ex.size) > 0 && Math.abs(newMB - toMB(ex.size)) < 2);
          const langOk = (ex.language || '') === (language || '');
          const sizeOk = ex.size === size || exactSizeMatch || (!ex.size && !size);
          
          if (qualOk && seasOk && (exactSizeMatch || (sizeOk && langOk))) { 
            matchedIdx = j; 
            if (language && language !== 'Multi' && (!ex.language || ex.language === 'Multi')) {
               ex.language = language;
            }
            break; 
          }
        }

        const metaSet = {};
        if (!dbRec.backdrop && meta.backdrop) metaSet.backdrop = meta.backdrop;
        if (!dbRec.poster && meta.poster) metaSet.poster = meta.poster;
        if (!dbRec.tmdbId && meta.tmdbId) metaSet.tmdbId = meta.tmdbId;
        if (!dbRec.imdbId && meta.imdbId) metaSet.imdbId = meta.imdbId;
        if (!dbRec.rating && meta.rating) metaSet.rating = meta.rating;
        if (!dbRec.description && meta.description) metaSet.description = meta.description;
        if (finalType === 'anime' && dbRec.type === 'series') metaSet.type = 'anime';

        if (matchedIdx >= 0) {
          if (dbRec.downloads[matchedIdx].language) {
              metaSet[`downloads.${matchedIdx}.language`] = dbRec.downloads[matchedIdx].language;
          }
          const existLinks = dbRec.downloads[matchedIdx]?.links || [];
          if (existLinks.length >= 3 || existLinks.map(l => l.host).includes(host)) { skipped++; continue; }
          const op = { $addToSet: { [`downloads.${matchedIdx}.links`]: newDl.links[0] } };
          if (Object.keys(metaSet).length) op.$set = metaSet;
          const res = await Movie.findOneAndUpdate({ _id: dbRec._id, [`downloads.${matchedIdx}.links.url`]: { $ne: url } }, op, { new: true });
          if (res) {
            recomputeAggregates(res);
            await Movie.findByIdAndUpdate(dbRec._id, { $set: { formats: res.formats, quality: res.quality, languages: res.languages, codecs: res.codecs } });
            updated++;
          } else skipped++;
        } else {
          const op = { $push: { downloads: newDl } };
          if (Object.keys(metaSet).length) op.$set = metaSet;
          const res = await Movie.findByIdAndUpdate(dbRec._id, op, { new: true });
          if (res) {
            recomputeAggregates(res);
            await Movie.findByIdAndUpdate(dbRec._id, { $set: { formats: res.formats, quality: res.quality, languages: res.languages, codecs: res.codecs } });
            updated++;
          }
        }
      } else {
        const newDoc = await Movie.create({
          title: finalTitle, tmdbId: meta.tmdbId || '', imdbId: meta.imdbId || '',
          type: finalType, totalSeasons: meta.totalSeasons || 0,
          description: meta.description || '', poster: meta.poster || '', backdrop: meta.backdrop || '',
          rating: meta.rating || 0, year: meta.year || rep.year || null,
          genre: meta.genre || [], duration: meta.duration || '', quality, language: origLang2,
          formats: [quality].filter(Boolean), codecs: [codec].filter(c => c && c !== 'Other'),
          languages: (language || origLang2).split(',').map(l => l.trim()).filter(Boolean),
          downloads: [newDl],
        });
        added++;
      }
    }
    process.stdout.write(`\rProgress: ${i + 1}/${groupEntries.length} | Added: ${added} | Updated: ${updated} | Skipped: ${skipped}`);
  }
  
  console.log('\n\nImport complete!');
  process.exit(0);
}

runLocalImport().catch(console.error);
