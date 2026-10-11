document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const id   = params.get('id');
  const type = params.get('type') || 'movie';

  if (!id) {
    document.getElementById('wpCard').innerHTML = '<h2 style="text-align:center;padding:60px;">Content not found</h2>';
    return;
  }

  try {
    const res  = await fetch(`/api/${type === 'movie' ? 'movies' : 'series'}/${id}`);
    const data = await res.json();
    document.title = `${data.title} — XLOOP`;

    // ── Backdrop ─────────────────────────────────────────────────
    const bgUrl = data.backdrop || data.poster || '';
    if (bgUrl) {
      document.getElementById('wpHeroBg').style.backgroundImage = `url('${bgUrl}')`;
    }

    // ── Build cinematic layout ───────────────────────────────────
    const genreText = (data.genre || []).join(' · ');

    const starRating = data.rating
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="#f5c518" style="vertical-align:-2px"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> ${data.rating}`
      : '';

    const downloads = data.downloads || [];
    const downloadHtml = buildDownloadSection(downloads, data.language, data.type);

    let displayQuality = data.quality || '';
    if (!displayQuality || displayQuality === 'HD') {
      const QR = ['4K','1080p','720p','480p','360p'];
      for (const dl of downloads) {
        const fn = (dl.filename || dl.quality || '').toUpperCase();
        const found = QR.find(q => fn.includes(q) || fn.includes(q.replace('K','160P').replace('p','P')));
        if (found && found !== 'HD') { displayQuality = found; break; }
      }
      displayQuality = displayQuality || 'HD';
    }

    const descText  = data.description || '';
    const descShort = descText.length > 240 ? descText.slice(0, 240).trimEnd() + '…' : descText;

    const cardHtml = `
      <div class="wp-cinema">

        <!-- ── Left: text only (no poster here, poster is on cards) ── -->
        <div class="wp-cinema-left">
          <div class="wp-cinema-text">
            ${genreText ? `<div class="wp-genre-dots">${genreText}</div>` : ''}
            <h1 class="wp-title">${data.title}</h1>

            <div class="wp-actions">
              ${data.streamEmbed ? `
              <button class="wp-btn-play" onclick="openPlayer('${data.streamEmbed}', '${data.title.replace(/'/g, "\\'")}')">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                Play
              </button>` : ''}

            </div>

            <div class="wp-meta-inline">
              ${data.year     ? `<span class="wp-mi">${data.year}</span>` : ''}
              ${data.duration ? `<span class="wp-mi">${data.duration}</span>` : ''}
              ${starRating    ? `<span class="wp-mi wp-mi-star">${starRating}</span>` : ''}
              ${displayQuality? `<span class="wp-mi wp-mi-badge">${displayQuality}</span>` : ''}
            </div>

            ${descShort ? `<p class="wp-desc">${descShort}</p>` : ''}

            <button class="wp-btn-list">+ MY LIST</button>
          </div>
        </div>

        <!-- ── Right: floating info panel ── -->
        <div class="wp-side-panel">
          ${[data.duration ? `<div class="wp-side-row"><span class="wp-side-label">Runtime</span><span class="wp-side-val">${data.duration}</span></div>` : '',
             data.language ? `<div class="wp-side-row"><span class="wp-side-label">Language</span><span class="wp-side-val">${data.language.split(',')[0].trim()}</span></div>` : '',
             data.year ? `<div class="wp-side-row"><span class="wp-side-label">Release Year</span><span class="wp-side-val">${data.year}</span></div>` : '',
             displayQuality ? `<div class="wp-side-row"><span class="wp-side-label">Quality</span><span class="wp-side-val">${displayQuality}</span></div>` : '',
             data.rating ? `<div class="wp-side-row"><span class="wp-side-label">Rating</span><span class="wp-side-val">${data.rating} / 10</span></div>` : ''
          ].filter(Boolean).join('')}
        </div>
      </div>

      <!-- downloadSection kept for series episode use only -->
    `;


    document.getElementById('wpCard').innerHTML = cardHtml;
    document.getElementById('wpSpinner') && document.getElementById('wpSpinner').remove();

    // ── For series: show episodes ─────────────────────────────
    const actualType = (data.type || type).toLowerCase();
    if (actualType === 'series' || actualType === 'anime') {
      loadEpisodes(downloads, bgUrl, data.language, actualType, data._id);
    } else {
      // ── Show download links directly on the page for movies ───
      if (downloads.length > 0) {
        const dlSection = document.createElement('div');
        dlSection.id = 'downloadSection';
        dlSection.className = 'wp-inline-downloads';
        dlSection.innerHTML = `
          <div class="wp-dl-title">Download Links</div>
          ${downloadHtml || '<p class="dl-modal-empty">No download links available</p>'}
        `;
        document.getElementById('wpBelow').prepend(dlSection);
      }
    }

    // ── Similar content ───────────────────────────────────────
    loadSimilar(type, id);

  } catch (err) {
    console.error(err);
    document.getElementById('wpCard').innerHTML = '<h2 style="text-align:center;padding:60px;">Failed to load content</h2>';
  }
});

// ── Flat-list download section ─────────────────────────────────────────────────
function buildDownloadSection(rawDownloads, fallbackLang, mediaType) {
  if (!rawDownloads || rawDownloads.length === 0) return '';

  const toMB = s => { if (!s) return 0; const n = parseFloat(s); return /GB/i.test(s) ? n*1024 : (n||0); };

  // ─ Per-file metadata detection ───────────────────────────────────────────
  function parseDlInfo(dl) {
    const fn   = dl.filename || '';
    const tags = (dl.tags || '').toLowerCase();

    const LANG_MAP = [
      { re: /\btelugu\b/i,       label: 'Telugu' },
      { re: /\btamil\b/i,        label: 'Tamil' },
      { re: /\bhindi\b/i,        label: 'Hindi' },
      { re: /\bmalayalam\b/i,    label: 'Malayalam' },
      { re: /\bkannada\b/i,      label: 'Kannada' },
      { re: /\benglis[h]?\b/i,   label: 'English' },
      { re: /\bmarathi\b/i,      label: 'Marathi' },
      { re: /\bbengali\b/i,      label: 'Bengali' },
      { re: /\bpunjabi\b/i,      label: 'Punjabi' },
      { re: /\b(Tel|TEL)\b/,     label: 'Telugu' },
      { re: /\b(Tam|TAM)\b/,     label: 'Tamil' },
      { re: /\b(Hin|HIN)\b/,     label: 'Hindi' },
      { re: /\b(Mal|MAL|ML)\b/,  label: 'Malayalam' },
      { re: /\b(Kan|KAN)\b/,     label: 'Kannada' },
      { re: /\b(Eng|ENG)\b/,     label: 'English' },
      { re: /\b(Mar|MAR)\b/,     label: 'Marathi' },
      { re: /\b(Ben|BEN)\b/,     label: 'Bengali' },
      { re: /\b(Pun|PUN|Pa)\b/,  label: 'Punjabi' },
      { re: /తెలుగు/,            label: 'Telugu' },
      { re: /தமிழ்/,             label: 'Tamil' },
      { re: /हिन्दी|हिंदी/,     label: 'Hindi' },
      { re: /മലയാളം/,            label: 'Malayalam' },
      { re: /ಕನ್ನಡ/,             label: 'Kannada' },
      { re: /বাংলা/,              label: 'Bengali' },
      { re: /ਪੰਜਾਬੀ/,             label: 'Punjabi' },
      { re: /मराठी/,              label: 'Marathi' },
      { re: /\bmulti\b/i,         label: 'Multi' },
    ];
    let detectedLangs = [];
    for (const { re, label } of LANG_MAP) {
      if (re.test(fn) || re.test(tags)) {
        if (!detectedLangs.includes(label)) detectedLangs.push(label);
      }
    }
    if (detectedLangs.length === 0 && dl.language && dl.language !== 'Unknown') detectedLangs.push(dl.language);
    else if (detectedLangs.length === 0 && fallbackLang) detectedLangs.push(fallbackLang);

    const specificLangs = detectedLangs.filter(l => l !== 'Multi');
    const isMulti  = detectedLangs.includes('Multi') || specificLangs.length > 1;
    const langLabel = isMulti ? 'Multi' : (detectedLangs[0] || '');

    let res = dl.quality || 'HD';
    // Override from filename if filename has explicit quality token
    if (/2160p|\b4k\b|\buhd\b/i.test(fn) || /\b4k\b/i.test(tags)) res = '4K';
    else if (/1080p/i.test(fn)) res = '1080p';
    else if (/720p/i.test(fn))  res = '720p';
    else if (/480p/i.test(fn))  res = '480p';
    else if (/360p/i.test(fn))  res = '360p';
    // dl.quality already set above as fallback when filename has no quality

    // HDR: DB-stored field first, then detect from filename
    let hdr = dl.hdr || '';
    if (!hdr) {
      if (/dolby.?vision|\.dv\b|dovi/i.test(fn)) hdr = 'DV';
      else if (/ dv /i.test(fn))   hdr = 'DV';
      else if (/hdr10\+/i.test(fn)) hdr = 'HDR10+';
      else if (/hdr10\b/i.test(fn)) hdr = 'HDR10';
      else if (/\bhdr\b/i.test(fn)) hdr = 'HDR';
      else if (/\bsdr\b/i.test(fn)) hdr = 'SDR';
    }

    // Codec: DB-stored field first, then detect from filename
    let codec = dl.codec || '';
    if (!codec || codec === 'Other') {
      codec = '';
      if      (/\bav1\b/i.test(fn))             codec = 'AV1';
      else if (/hevc|h\.265|x265/i.test(fn))    codec = 'HEVC';
      else if (/\bavc\b|h\.264|x264/i.test(fn)) codec = 'AVC';
    }
    // Normalize stored codec values
    if (codec && /hevc|h\.265|x265/i.test(codec))      codec = 'HEVC';
    else if (codec && /avc|h\.264|x264/i.test(codec))  codec = 'AVC';
    else if (codec && /av1/i.test(codec))               codec = 'AV1';

    // Source: DB-stored field first, then detect from filename
    let source = dl.source || '';
    if (!source) {
      if      (/remux/i.test(fn))                              source = 'REMUX';
      else if (/web-dl|webdl/i.test(fn)||/web.?dl/i.test(tags)) source = 'WEB-DL';
      else if (/webrip/i.test(fn))                             source = 'WEBRip';
      else if (/bluray|blu-ray|bdrip|brrip/i.test(fn))         source = 'BluRay';
      else if (/hdrip/i.test(fn))                              source = 'HDRip';
      else if (/dvdrip|dvd/i.test(fn))                         source = 'DVD';
    }

    // Audio: DB-stored field first, then detect from filename
    let audio = dl.audio || '';
    if (!audio) {
      if      (/\batmos\b/i.test(fn))           audio = 'ATMOS';
      else if (/dts-hdma?/i.test(fn))           audio = 'DTS-HD';
      else if (/\bdts\b/i.test(fn))             audio = 'DTS';
      else if (/ddp5\.1|eac3|dd\+5\.1/i.test(fn)) audio = 'DDP5.1';
      else if (/ddp2\.0|dd\+2/i.test(fn))      audio = 'DDP2.0';
      else if (/dd5\.1|ac3/i.test(fn))         audio = 'DD5.1';
      else if (/\baac\b/i.test(fn))            audio = 'AAC';
    else if (/\bflac\b/i.test(fn))           audio = 'FLAC';

    let platform = '';
    if      (/ nf[.\- ]|netflix/i.test(fn))                  platform = 'NF';
    else if (/ amzn[.\- ]|amazon/i.test(fn))                  platform = 'AMZ';
    else if (/ dsnp[.\- ]|disney|hotstar|jio/i.test(fn))      platform = 'Jio·Hot';
    else if (/ mmax[.\- ]|\bmax\b/i.test(fn))                 platform = 'MAX';
    else if (/ aha[.\- ]/i.test(fn))                          platform = 'AHA';
    else if (/ zee[.\- ]|zee5/i.test(fn))                     platform = 'ZEE5';
    else if (/ sny[.\- ]|sonyliv/i.test(fn))                  platform = 'Sony';
    else if (/ atv[.\- ]|appletv|apple/i.test(fn))            platform = 'ATV';

    // ── DB-stored field fallbacks (when filename is absent or too short to parse) ─
    if (!codec  && dl.codec)  codec  = dl.codec;
    if (!audio  && dl.audio)  audio  = dl.audio;
    if (!hdr    && dl.hdr)    hdr    = dl.hdr;
    if (!source && dl.source) source = dl.source;
    // Normalize codec stored values
    if (codec && /hevc|h\.265|x265/i.test(codec))      codec = 'HEVC';
    else if (codec && /avc|h\.264|x264/i.test(codec))  codec = 'AVC';
    else if (codec && /av1/i.test(codec))               codec = 'AV1';

    return { lang: langLabel, res, hdr, codec, source, audio, platform, isMulti,
             season: dl.season || null, episode: dl.episode || null };
  }

  // ─ Flatten all (dl, link) → individual rows — one row per URL ─────────────
  // Each URL is shown as its own download row.
  // Filename is displayed on each row so different file variants are distinguishable.
  const rows = [];
  const seenUrls = new Set();
  const HOST_RANK = {
    'GDFlix':0,'HubCloud':1,'FilePress':2,'DTFlix':3,'TMBCloud':4,
    'DriveNext':5,'FileBee':6,'BuzzHeavier':7,'PixelDrain':8,
    'StreamTape':9,'MixDrop':10,'DoodStream':11,'1Fichier':12,'CatBox':13,
    'Direct':14,'Download':99
  };

  rawDownloads.forEach(dl => {
    if (!dl.links || dl.links.length === 0) return;
    const info = parseDlInfo(dl);

    const techParts = [];
    if (info.hdr)      techParts.push(info.hdr);
    if (info.source)   techParts.push(info.source);
    if (info.codec)    techParts.push(info.codec);
    if (info.audio)    techParts.push(info.audio);
    if (info.platform) techParts.push(info.platform);
    const techTags = techParts.filter(Boolean).join(' · ');

    // Cleaned display filename (strip inline size bracket — size shown separately)
    let displayName = (dl.filename || '').trim();
    if (dl.size) displayName = displayName.replace(/\s*\[[\d.,]+ ?(GB|MB)\]\s*/gi, '').trim();

    dl.links.forEach(link => {
      const url = (link.url || '').replace(/^http:\/\//i, 'https://').replace(/\/$/, '');
      if (!url || seenUrls.has(url)) return;
      seenUrls.add(url);
      // Resolve host from stored field or classify from URL
      let hostLabel = link.host || '';
      if (!hostLabel || hostLabel === 'Direct') {
        try {
          const hn = new URL(url).hostname.toLowerCase();
          if (/gdflix/.test(hn))      hostLabel = 'GDFlix';
          else if (/hubcloud/.test(hn)) hostLabel = 'HubCloud';
          else if (/filepress/.test(hn)) hostLabel = 'FilePress';
          else if (/drivehub/.test(hn)) hostLabel = 'DriveHub';
          else if (/pixeldrain/.test(hn)) hostLabel = 'PixelDrain';
          else if (/streamtape/.test(hn)) hostLabel = 'StreamTape';
          else if (/mixdrop/.test(hn)) hostLabel = 'MixDrop';
          else if (/doodstream|dood\./.test(hn)) hostLabel = 'DoodStream';
          else if (/buzzheavier/.test(hn)) hostLabel = 'BuzzHeavier';
          else if (/1fichier/.test(hn)) hostLabel = '1Fichier';
          else if (/catbox/.test(hn)) hostLabel = 'CatBox';
          else if (/krakenfiles/.test(hn)) hostLabel = 'KrakenFiles';
          else hostLabel = hostLabel || 'Direct';
        } catch(_) { hostLabel = hostLabel || 'Direct'; }
      }
      rows.push({
        quality:     info.res,
        size:        dl.size || '',
        host:        hostLabel,
        url,
        filename:    dl.filename || '',
        displayName,
        techTags,
        hdr:         info.hdr,
        lang:        info.lang,
        isMulti:     info.isMulti,
        rank:        HOST_RANK[hostLabel] ?? 99,
        season:      dl.season,
        episode:     dl.episode,
      });
    });
  });

  if (rows.length === 0) return '';

  // ─ Sort: quality → language priority → size desc → host rank ────────────
  const Q_ORDER = {'4K':0,'1080p':1,'720p':2,'480p':3,'360p':4,'HD':5};

  // Language display priority: Multi-audio first, then common languages
  const LANG_ORDER = { 'multi':0, 'telugu':1, 'tamil':2, 'hindi':3, 'malayalam':4, 'kannada':5 };
  function langPriority(lang) {
    if (!lang) return 99;
    const l = lang.toLowerCase();
    if (/multi|dual|4-in-1|5-in-1/i.test(l)) return 0;
    for (const [key, val] of Object.entries(LANG_ORDER)) { if (l.includes(key)) return val; }
    return 99;
  }

  // Parse size string to MB for numeric comparison
  function sizeToMB(s) {
    if (!s) return 0;
    const n = parseFloat(s);
    return /GB/i.test(s) ? n * 1024 : (n || 0);
  }

  rows.sort((a, b) => {
    // 1. Season/Episode order for series
    if (a.season != null || b.season != null) {
      const seA = (a.season||0)*1000 + (a.episode||0);
      const seB = (b.season||0)*1000 + (b.episode||0);
      if (seA !== seB) return seA - seB;
    }
    // 2. Quality (4K > 1080p > 720p ...)
    const qa = Q_ORDER[a.quality]??9, qb = Q_ORDER[b.quality]??9;
    if (qa !== qb) return qa - qb;
    // 3. Language priority (Multi-audio first, then by language)
    const la = langPriority(a.lang), lb = langPriority(b.lang);
    if (la !== lb) return la - lb;
    // 4. File size descending (larger = higher quality variant shown first)
    const sa = sizeToMB(a.size), sb = sizeToMB(b.size);
    if (sb !== sa) return sb - sa;
    // 5. Host rank (GDFlix > HubCloud > ...)
    return a.rank - b.rank;
  });

  // ─ Filter pills (quality order: 4K > 1080p > 720p > 480p > 360p > HD) ──────
  const Q_PILL_ORDER = ['4K','1080p','720p','480p','360p','HD'];
  const quals = [...new Set(rows.map(r => r.quality))]
    .sort((a, b) => (Q_PILL_ORDER.indexOf(a) < 0 ? 99 : Q_PILL_ORDER.indexOf(a)) - (Q_PILL_ORDER.indexOf(b) < 0 ? 99 : Q_PILL_ORDER.indexOf(b)));
  const pillsHtml = quals.length > 1
    ? `<div class="dl-filter-pills">
        <button class="dl-pill active" data-filter="all" onclick="dlFilter(this,'all')">All</button>
        ${quals.map(q=>`<button class="dl-pill" data-filter="${q}" onclick="dlFilter(this,'${q}')">${q}</button>`).join('')}
       </div>`
    : '';

  // ─ HDR badge palette ─────────────────────────────────────────────────────
  const HDR_COLORS = {
    'DV':    {bg:'rgba(168,85,247,0.15)',  border:'rgba(168,85,247,0.4)',  text:'#c084fc'},
    'HDR10+':{bg:'rgba(245,158,11,0.15)',  border:'rgba(245,158,11,0.4)',  text:'#fbbf24'},
    'HDR10': {bg:'rgba(59,130,246,0.15)',  border:'rgba(59,130,246,0.4)',  text:'#60a5fa'},
    'HDR':   {bg:'rgba(59,130,246,0.10)',  border:'rgba(59,130,246,0.3)',  text:'#93c5fd'},
    'SDR':   {bg:'rgba(107,114,128,0.15)', border:'rgba(107,114,128,0.4)', text:'#9ca3af'},
  };

  // ─ Build rows HTML ────────────────────────────────────────────────────────
  const rowsHtml = rows.map(row => {
    const copyText    = `${row.displayName}${row.size ? ` - [${row.size}]` : ''}\n${row.url}\n\n~janiXloop`;
    const escapedCopy = copyText.replace(/\\/g, '\\\\').replace(/`/g, '\\`');

    const hdrC   = row.hdr && HDR_COLORS[row.hdr] ? HDR_COLORS[row.hdr] : null;
    const hdrBadge = hdrC
      ? `<span class="dl-row-hdr" style="background:${hdrC.bg};border:1px solid ${hdrC.border};color:${hdrC.text}">${row.hdr}</span>`
      : '';

    const seBadge = (row.season || row.episode)
      ? `<span class="dl-row-se">${row.season?'S'+String(row.season).padStart(2,'0'):''}${row.episode?'E'+String(row.episode).padStart(2,'0'):''}</span>`
      : '';

    const langBadge = row.lang
      ? `<span class="dl-row-lang">${row.isMulti ? 'MULTI' : row.lang}</span>`
      : '';

    return `
      <div class="dl-row" data-quality="${row.quality}">
        <div class="dl-row-info">
          <div class="dl-row-headline">
            ${seBadge}
            <span class="dl-row-host">${row.host}</span>
            <span class="dl-dot">·</span>
            <span class="dl-row-quality">${row.quality}</span>
            ${row.size ? `<span class="dl-dot">·</span><span class="dl-row-size">${row.size}</span>` : ''}
            ${hdrBadge}
            ${langBadge}
          </div>
          ${row.techTags ? `<div class="dl-row-tags">${row.techTags}</div>` : ''}
        </div>
        <div class="dl-row-actions">
          <button class="dl-copy-btn" title="Copy link" onclick="copyLink(this,\`${escapedCopy}\`)">
            <svg class="icon-copy" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            <svg class="icon-check" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" style="display:none"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
          <a href="${row.url}" target="_blank" rel="noopener noreferrer" class="dl-download-btn">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
            Download
          </a>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="dl-list-wrap">
      <div class="dl-list-toolbar">
        <span class="dl-found-count">Found <strong>${rows.length}</strong> link${rows.length !== 1 ? 's' : ''}</span>
        ${pillsHtml}
      </div>
      <div class="dl-rows-list">
        ${rowsHtml}
      </div>
    </div>`;
}



window.toggleAccordion = (i) => {
  const acc = document.getElementById(`dl-acc-${i}`);
  if (!acc) return;
  acc.classList.toggle('open');
};

// ── Quality filter for flat download list ─────────────────────────
window.dlFilter = (btn, quality) => {
  btn.closest('.dl-filter-pills').querySelectorAll('.dl-pill').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  // Filter only within the modal body
  const scope = btn.closest('.dl-modal-body') || document;
  scope.querySelectorAll('.dl-row').forEach(row => {
    row.style.display = (quality === 'all' || row.dataset.quality === quality) ? 'flex' : 'none';
  });
};

// ── Download Modal open / close ────────────────────────────────────
window.openDownloadModal = () => {
  const overlay = document.getElementById('dlModalOverlay');
  if (!overlay) return;
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
};

window.closeDownloadModal = () => {
  const overlay = document.getElementById('dlModalOverlay');
  if (!overlay) return;
  overlay.classList.remove('active');
  document.body.style.overflow = '';
};


// ── Copy link to clipboard ─────────────────────────────────────────
window.copyLink = (btn, text) => {
  navigator.clipboard.writeText(text).then(() => {
    const iconCopy  = btn.querySelector('.icon-copy');
    const iconCheck = btn.querySelector('.icon-check');
    if (iconCopy)  iconCopy.style.display  = 'none';
    if (iconCheck) iconCheck.style.display = 'block';
    btn.classList.add('copied');
    setTimeout(() => {
      if (iconCopy)  iconCopy.style.display  = 'block';
      if (iconCheck) iconCheck.style.display = 'none';
      btn.classList.remove('copied');
    }, 2000);
  }).catch(() => {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity  = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 2000);
  });
};


// ── Open video player modal ────────────────────────────────────────
window.openPlayer = (src, title) => {
  const modal   = document.getElementById('watchPlayerModal');
  const wrap    = document.getElementById('playerWrap');
  const titleEl = document.getElementById('wpPlayerTitle');
  modal.style.display = 'flex';
  titleEl.textContent = title || '';
  wrap.innerHTML = `<iframe src="${src}" allowfullscreen></iframe>`;
  document.body.style.overflow = 'hidden';
};

document.getElementById('closePlayerBtn').addEventListener('click', () => {
  document.getElementById('watchPlayerModal').style.display = 'none';
  document.body.style.overflow = '';
  const iframe = document.querySelector('#playerWrap iframe');
  if (iframe) iframe.src = iframe.src;
});

// ── Load episodes for TV series ───────────────────────────────────
async function loadEpisodes(downloads, fallbackImg, language, type, id) {
  document.getElementById('episodeSection').style.display = 'block';

  let tmdbSeasons = [];
  try {
    const res = await fetch(`/api/series/${id}/tmdb-data`);
    const tmdbData = await res.json();
    tmdbSeasons = tmdbData.seasons || [];
  } catch(e) { console.error('TMDB fetch error', e); }

  const seasons = {};
  
  // 1. Initialize from TMDB data (authoritative episode counts)
  tmdbSeasons.forEach(ts => {
    if (ts.seasonNumber === 0) return; // skip specials
    seasons[ts.seasonNumber] = {
      tmdbCount: ts.episodeCount,
      name: ts.name || `Season ${ts.seasonNumber}`,
      eps: {},
      packs: []  // Season packs (full season zip files, episode=null)
    };
  });

  // 2. Map available downloads — SEPARATE packs from individual episodes
  if (downloads) {
    downloads.forEach(dl => {
      // Read the real season from the filename if the DB season is wrong
      const s = dl.season || 1;
      if (!seasons[s]) seasons[s] = { tmdbCount: 0, name: `Season ${s}`, eps: {}, packs: [] };
      
      // If episode is null/undefined, it's a SEASON PACK (full-season zip)
      if (!dl.episode) {
        seasons[s].packs.push(dl);
      } else {
        const e = dl.episode;
        if (!seasons[s].eps[e]) {
          seasons[s].eps[e] = { season: s, episode: e, title: `Episode ${e}`, downloads: [] };
        }
        seasons[s].eps[e].downloads.push(dl);
      }
    });
  }

  // 3. Fallback if no seasons found
  if (Object.keys(seasons).length === 0) {
    document.getElementById('episodeSection').style.display = 'none';
    return;
  }

  const seasonTabs  = document.getElementById('seasonTabs');
  const episodeGrid = document.getElementById('episodeGrid');
  const sortedSeasons = Object.keys(seasons).sort((a, b) => a - b);
  let currentSeason = sortedSeasons[0];
  for (const s of sortedSeasons) {
    if (Object.keys(seasons[s].eps).length > 0 || seasons[s].packs.length > 0) {
      currentSeason = s;
      break;
    }
  }
  let activeEpKey   = null;

  function updateEpCountBadge() {
    const badge = document.getElementById('seasonEpCountBadge');
    if (!badge) return;
    const sd = seasons[currentSeason];
    const haveCount = Object.keys(sd.eps).length;
    const totalCount = sd.tmdbCount || haveCount;
    if (totalCount > 0) {
      const color = haveCount >= totalCount ? '#4caf50' : 'var(--accent)';
      badge.innerHTML = `<span style="color:${color};">${haveCount}/${totalCount} episodes available</span>`;
    } else {
      badge.innerHTML = '';
    }
  }

  function renderSeasons() {
    if (!seasonTabs) return;
    let html = Object.keys(seasons).sort((a,b) => a-b).map((s, idx) => {
      const delay = (idx * 0.04).toFixed(2);
      const isActive = s == currentSeason ? 'active' : '';
      const sd = seasons[s];
      const haveEps = Object.keys(sd.eps).length;
      const totalEps = sd.tmdbCount || haveEps;
      // Color the badge green if complete, red if partial
      const badgeColor = haveEps > 0 && haveEps >= totalEps ? '#4caf50' : (haveEps > 0 ? 'var(--accent)' : '#555');
      const epBadge = totalEps > 0 ? `<span style="font-size:0.68em; background:${badgeColor}; color:#fff; border-radius:4px; padding:1px 5px; margin-left:4px;">${haveEps}/${totalEps}</span>` : '';
      return `
        <button class="season-btn ${isActive}" style="animation-delay:${delay}s" onclick="selectSeason(${s})">
          Season ${s} ${epBadge}
        </button>
      `;
    }).join('');
    seasonTabs.innerHTML = html;
  }

  function renderEpisodes() {
    const sd = seasons[currentSeason];
    const downloadedEpNums = Object.keys(sd.eps).map(Number);
    const maxDownloaded = downloadedEpNums.length > 0 ? Math.max(...downloadedEpNums) : 0;
    const totalEps = Math.max(sd.tmdbCount || 0, maxDownloaded);
    
    let html = '';

    // Show Season Pack button at the top if we have one
    if (sd.packs && sd.packs.length > 0) {
      html += `
        <button class="ep-btn pack-btn" onclick="selectSeasonPack(${currentSeason})" title="Full Season Pack Download">
           Season Pack
          <span style="font-size:0.72em; opacity:0.75; display:block;">${sd.packs.length} file${sd.packs.length > 1 ? 's' : ''}</span>
        </button>`;
    }

    // Show individual episode buttons
    let hasButtons = false;
    for (let i = 1; i <= totalEps; i++) {
      const isAvailable = !!sd.eps[i];
      if (!isAvailable) continue;
      
      hasButtons = true;
      const delay = ((i-1) * 0.03).toFixed(2);
      const key = `${currentSeason}_${i}`;
      const isActive = activeEpKey === key ? 'active' : '';

      html += `
      <button class="ep-btn ${isActive}" style="animation-delay:${delay}s" onclick="selectEpisode(${currentSeason}, ${i})">
        Episode ${i}
      </button>`;
    }
    
    if (!hasButtons && (!sd.packs || sd.packs.length === 0)) {
       html = '<p style="padding: 20px; color: var(--text2); font-size: 0.9em; text-align: center; width: 100%;">No download links have been uploaded for this season yet.</p>';
    }
    
    episodeGrid.innerHTML = html;
    updateEpCountBadge();
  }

  window.selectSeason = (s) => { 
    currentSeason = s; 
    activeEpKey = null;
    document.getElementById('downloadSection').style.display = 'none';
    renderSeasons(); 
    renderEpisodes(); 
  };
  
  window.selectSeasonPack = (s) => {
    const sd = seasons[s];
    if (!sd || !sd.packs || !sd.packs.length) return;
    
    let dlSection = document.getElementById('downloadSection');
    if (!dlSection) {
      dlSection = document.createElement('div');
      dlSection.id = 'downloadSection';
      dlSection.className = 'wp-inline-downloads';
      document.getElementById('episodeSection').after(dlSection);
    }
    
    dlSection.style.display = 'block';
    const html = buildDownloadSection(sd.packs, language, type);
    dlSection.innerHTML = `
      <div class="wp-dl-title">Downloads: Season ${s} — Full Season Pack</div>
      <div id="qualityPanels">${html}</div>
    `;
    dlSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  
  window.selectEpisode = (s, e) => {
    activeEpKey = `${s}_${e}`;
    renderEpisodes();
    
    const epData = seasons[s].eps[e];
    let dlSection = document.getElementById('downloadSection');
    if (!dlSection) {
      dlSection = document.createElement('div');
      dlSection.id = 'downloadSection';
      dlSection.className = 'wp-inline-downloads';
      document.getElementById('episodeSection').after(dlSection);
    }
    
    dlSection.style.display = 'block';
    const html = buildDownloadSection(epData.downloads, language, type);
    dlSection.innerHTML = `
      <div class="wp-dl-title">Downloads: Season ${s} Episode ${e}</div>
      <div id="qualityPanels">${html}</div>
    `;
    dlSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  renderSeasons();
  renderEpisodes();
}

// ── Load similar content slider ───────────────────────────────────
const REGIONAL_LANGS = ['Telugu', 'Tamil', 'Hindi', 'Malayalam', 'Kannada', 'Bengali', 'Marathi', 'Punjabi'];

async function loadSimilar(type, currentId) {
  try {
    // Fetch current item to know its genre and language
    const selfRes  = await fetch(`/api/${(type === 'movie') ? 'movies' : 'series'}/${currentId}`);
    const selfData = await selfRes.json();
    const selfLang  = (selfData.language || '').split(',')[0].trim();
    const selfGenre = (selfData.genre || [])[0] || '';
    const isRegional = REGIONAL_LANGS.some(l => selfLang.toLowerCase().includes(l.toLowerCase()));

    const apiBase = (type === 'movie') ? 'movies' : 'series';

    // Fetch genre-similar using search API (supports type + genre properly)
    let similarItems = [];
    try {
      const selfId = String(currentId);
    const simUrl  = `/api/search?genre=${encodeURIComponent(selfGenre)}&type=${encodeURIComponent(type)}&limit=24`;
      const simRes  = await fetch(simUrl);
      const simData = await simRes.json();
      const simArr  = simData.results || simData.movies || simData.series || [];
      const seenIds = new Set();
      
      // Exclude self, filter duplicates, then filter by language for regional content
      similarItems = simArr
        .filter(i => String(i._id) !== selfId)
        .filter(i => {
          const key = i.tmdbId ? String(i.tmdbId) : (i.title || '').toLowerCase();
          if (seenIds.has(key)) return false;
          seenIds.add(key);
          return true;
        })
        .filter(i => {
          if (!isRegional) return true;
          const itemLang = (i.language || '').toLowerCase();
          return REGIONAL_LANGS.some(l =>
            itemLang.includes(l.toLowerCase()) && selfLang.toLowerCase().includes(l.toLowerCase())
          );
        });
    } catch(_) {}

    let latestItems = [];
    try {
      const latUrl  = `/api/search?type=${encodeURIComponent(type)}&limit=20`;
      const latRes  = await fetch(latUrl);
      const latData = await latRes.json();
      const latArr  = latData.results || latData.movies || latData.series || [];
      const seenIds = new Set(similarItems.map(i => i.tmdbId ? String(i.tmdbId) : (i.title || '').toLowerCase()));
      
      latestItems   = latArr.filter(i => {
        if (String(i._id) === String(currentId)) return false;
        const key = i.tmdbId ? String(i.tmdbId) : (i.title || '').toLowerCase();
        if (seenIds.has(key)) return false;
        seenIds.add(key);
        return true;
      });
    } catch(_) {}

    function makeCard(item) {
      return `
        <a href="/watch.html?id=${item._id}&type=${item.type || type}" class="card">
          <div class="card-img-wrap">
            <img src="${item.poster || '/images/placeholder.svg'}" alt="${item.title}" loading="lazy">
          </div>
          <div class="card-info">
            <h3 class="card-title">${item.title}</h3>
            <p class="card-meta">${item.year || ''} • ${item.rating || 'N/A'}</p>
          </div>
        </a>`;
    }

    const grid = document.getElementById('similarGrid');
    let html = '';

    // Section 1: Genre-Similar
    if (similarItems.length > 0) {
      html += similarItems.map(makeCard).join('');
    }
    // Section 2: Latest (as a fallback filler)
    if (latestItems.length > 0) {
      if (similarItems.length > 0) {
        html += `<div class="similar-divider"><span>Latest Added</span></div>`;
      }
      html += latestItems.slice(0, 12).map(makeCard).join('');
    }

    grid.innerHTML = html || '<p style="padding:20px;color:var(--text2);">No similar content found.</p>';
  } catch (e) { console.error(e); }
}
