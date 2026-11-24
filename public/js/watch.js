document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const id   = params.get('id');
  const type = params.get('type') || 'movie';

  if (!id) {
    document.getElementById('wpCard').innerHTML = '<h2 style="text-align:center;padding:60px;">Content not found</h2>';
    return;
  }

  try {
    let res  = await fetch(`/api/${type === 'movie' ? 'movies' : 'series'}/${id}`);
    let data = await res.json();
    if (!res.ok || !data || data.message || !data.title) {
      // Fallback: try the alternate endpoint in case type parameter was mismatched
      const altType = type === 'movie' ? 'series' : 'movies';
      try {
        const altRes = await fetch(`/api/${altType}/${id}`);
        if (altRes.ok) {
          const altData = await altRes.json();
          if (altData && altData.title) data = altData;
        }
      } catch (_) {}
    }
    if (!data || !data.title) {
      document.getElementById('wpCard').innerHTML = '<h2 style="text-align:center;padding:60px;">Content not found</h2>';
      const sp = document.getElementById('wpSpinner');
      if (sp) sp.remove();
      return;
    }
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
    const downloadHtml = buildDownloadSection(downloads, '', data.type);
    const availableLanguageLabels = getAvailableLanguageLabels(downloads);

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
    const runtimeLabel = data.duration || (data.runtimeMinutes
      ? (Math.floor(data.runtimeMinutes / 60)
        ? Math.floor(data.runtimeMinutes / 60) + 'h' + (data.runtimeMinutes % 60 ? ' ' + (data.runtimeMinutes % 60) + 'm' : '')
        : data.runtimeMinutes + ' min')
      : '');
    const certificationLabel = data.certification || data.cbfcRating || '';

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
              ${runtimeLabel ? `<span class="wp-mi">${runtimeLabel}</span>` : ''}
              ${certificationLabel ? `<span class="wp-mi wp-mi-badge">CBFC ${certificationLabel}</span>` : ''}
              ${starRating    ? `<span class="wp-mi wp-mi-star">${starRating}</span>` : ''}
              ${displayQuality? `<span class="wp-mi wp-mi-badge">${displayQuality}</span>` : ''}
            </div>

            ${descShort ? `<p class="wp-desc">${descShort}</p>` : ''}

            <button class="wp-btn-list">+ MY LIST</button>
          </div>
        </div>

        <!-- ── Right: floating info panel ── -->
        <div class="wp-side-panel">
          ${[runtimeLabel ? `<div class="wp-side-row"><span class="wp-side-label">Runtime</span><span class="wp-side-val">${runtimeLabel}</span></div>` : '',
             availableLanguageLabels.length ? `<div class="wp-side-row"><span class="wp-side-label">Available Languages</span><span class="wp-side-val">${availableLanguageLabels.join(' · ')}</span></div>` : '',
             data.year ? `<div class="wp-side-row"><span class="wp-side-label">Release Year</span><span class="wp-side-val">${data.year}</span></div>` : '',
             displayQuality ? `<div class="wp-side-row"><span class="wp-side-label">Quality</span><span class="wp-side-val">${displayQuality}</span></div>` : '',
             data.rating ? `<div class="wp-side-row"><span class="wp-side-label">Rating</span><span class="wp-side-val">${data.rating} / 10</span></div>` : '',
              data.isIMAX ? `<div class="wp-side-row"><span class="wp-side-label">Format</span><span class="wp-side-val">IMAX</span></div>` : '',
              data.aspectRatio ? `<div class="wp-side-row"><span class="wp-side-label">Screen Ratio</span><span class="wp-side-val">${data.aspectRatio}</span></div>` : '',
              certificationLabel ? `<div class="wp-side-row"><span class="wp-side-label">CBFC</span><span class="wp-side-val">${certificationLabel}</span></div>` : ''
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
      loadEpisodes(downloads, bgUrl, '', actualType, data._id);
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

// Detect languages from the actual Telegram download record only.
// Never use TMDB/OMDb original-language metadata as an availability signal.
const DOWNLOAD_LANGUAGE_MAP = [
  { re: /\b(?:telugu|tel|tl)\b|తెలుగు/i, label: 'Telugu' },
  { re: /\b(?:tamil|tam|tk)\b|தமிழ்/i, label: 'Tamil' },
  { re: /\b(?:hindi|hin)\b|हिन्दी|हिंदी/i, label: 'Hindi' },
  { re: /\b(?:malayalam|mal|ml)\b|മലയാളം/i, label: 'Malayalam' },
  { re: /\b(?:kannada|kan|kn)\b|ಕನ್ನಡ/i, label: 'Kannada' },
  { re: /\b(?:bengali|ben|bang|bn)\b|বাংলা/i, label: 'Bengali' },
  { re: /\b(?:english|eng)\b/i, label: 'English' },
  { re: /\b(?:marathi|mar)\b|मराठी/i, label: 'Marathi' },
  { re: /\b(?:punjabi|pun|pan)\b|ਪੰਜਾਬੀ/i, label: 'Punjabi' },
  { re: /\b(?:japanese|jpn|jap)\b/i, label: 'Japanese' },
  { re: /\b(?:korean|kor)\b/i, label: 'Korean' },
  { re: /\b(?:chinese|chi|zho|mandarin|cantonese)\b/i, label: 'Chinese' },
  { re: /\b(?:arabic|ara)\b|عربي|عربى/i, label: 'Arabic' },
  { re: /\b(?:turkish|tur)\b/i, label: 'Turkish' },
  { re: /\b(?:spanish|spa)\b/i, label: 'Spanish' },
  { re: /\b(?:french|fre|fra)\b/i, label: 'French' },
  { re: /\b(?:german|ger|deu)\b/i, label: 'German' },
  { re: /\b(?:portuguese|por)\b/i, label: 'Portuguese' },
  { re: /\b(?:russian|rus)\b/i, label: 'Russian' },
  { re: /\b(?:italian|ita)\b/i, label: 'Italian' },
  { re: /\b(?:dutch|nld|dut)\b/i, label: 'Dutch' },
  { re: /\b(?:polish|pol)\b/i, label: 'Polish' },
  { re: /\b(?:thai|tha)\b/i, label: 'Thai' },
  { re: /\b(?:vietnamese|vie)\b/i, label: 'Vietnamese' },
  { re: /\b(?:indonesian|ind|bahasa)\b/i, label: 'Indonesian' },
  { re: /\b(?:malay|msa)\b/i, label: 'Malay' },
  { re: /\b(?:filipino|tagalog|tgl)\b/i, label: 'Filipino' },
  { re: /\b(?:persian|farsi|fas|per)\b/i, label: 'Persian' },
  { re: /\b(?:hebrew|heb)\b/i, label: 'Hebrew' },
  { re: /\b(?:greek|ell|gre)\b/i, label: 'Greek' },
  { re: /\b(?:ukrainian|ukr)\b/i, label: 'Ukrainian' },
  { re: /\b(?:urdu|urd)\b|اردو/i, label: 'Urdu' },
  { re: /\b(?:nepali|nep)\b/i, label: 'Nepali' },
  { re: /\b(?:sinhala|sin)\b/i, label: 'Sinhala' },
  { re: /\b(?:gujarati|guj)\b|ગુજરાતી/i, label: 'Gujarati' },
  { re: /\b(?:odia|oriya|ori)\b|ଓଡ଼ିଆ/i, label: 'Odia' },
  { re: /\b(?:assamese|asm)\b|অসমীয়া/i, label: 'Assamese' },
  { re: /\b(?:bhojpuri|bho)\b/i, label: 'Bhojpuri' },
  { re: /\b(?:swedish|swe)\b/i, label: 'Swedish' },
  { re: /\b(?:norwegian|nor)\b/i, label: 'Norwegian' },
  { re: /\b(?:danish|dan)\b/i, label: 'Danish' },
  { re: /\b(?:finnish|fin)\b/i, label: 'Finnish' },
  { re: /\b(?:czech|ces|cze)\b/i, label: 'Czech' },
  { re: /\b(?:hungarian|hun)\b/i, label: 'Hungarian' },
  { re: /\b(?:romanian|ron|rum)\b/i, label: 'Romanian' },
  { re: /\b(?:bulgarian|bul)\b/i, label: 'Bulgarian' },
  { re: /\b(?:croatian|hrv)\b/i, label: 'Croatian' },
  { re: /\b(?:serbian|srp)\b/i, label: 'Serbian' },
  { re: /\b(?:swahili|swa)\b/i, label: 'Swahili' },
];

function detectDownloadLanguageInfo(dl) {
  const languageText = [dl.filename || '', dl.tags || '', dl.language || ''].join(' ');
  const languages = [];
  for (const { re, label } of DOWNLOAD_LANGUAGE_MAP) {
    if (re.test(languageText) && !languages.includes(label)) languages.push(label);
  }
  const hasMultiMarker = /\b(?:multi(?:[.\s_-]?audio)?|tri[.\s_-]?audio)\b/i.test(languageText);
  const hasDualMarker = /\b(?:dual(?:[.\s_-]?audio)?|bilingual)\b/i.test(languageText);
  const storedType = ['Single', 'Dual', 'Multi'].includes(dl.languageType) ? dl.languageType : '';
  const languageType = hasMultiMarker || languages.length >= 3 ? 'Multi'
    : hasDualMarker || languages.length === 2 ? 'Dual'
    : languages.length === 1 ? 'Single' : storedType;
  return { languages, languageType };
}

function getAvailableLanguageLabels(downloads) {
  const labels = new Set();
  for (const dl of downloads || []) {
    const info = detectDownloadLanguageInfo(dl || {});
    if (info.languageType === 'Multi' || info.languages.length >= 3) labels.add('MULTi');
    else if (info.languageType === 'Dual' || info.languages.length === 2) labels.add('DUAL');
    else if (info.languages.length === 1) labels.add(info.languages[0]);
  }
  return [...labels];
}

function formatDownloadLanguageLabel(languageType, lang) {
  // Multi is intentionally branded as MULTi; never append the same label twice.
  if (languageType === 'Multi') return 'MULTi';
  if (languageType === 'Dual') return 'DUAL';
  return lang || '';
}

function normalizeAudioDisplayLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw
    .replace(/E[.\s_-]?AC[.\s_-]?3/ig, 'DDP')
    .replace(/\bDDP\+?/ig, 'DDP')
    .replace(/\bDD\+|\bDD[.\s_-]+PLUS/ig, 'DDP')
    .replace(/DOLBY[.\s_-]*DIGITAL[.\s_-]*PLUS/ig, 'DDP')
    .replace(/AC[.\s_-]?3/ig, 'DD')
    .replace(/DOLBY[.\s_-]*DIGITAL/ig, 'DD')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectAudioChannelsForDisplay(download) {
  const stored = String(download?.audioChannels || '').trim();
  const layouts = /^(?:11\.1\.8|9\.1\.8|9\.1\.6|9\.1\.4|7\.2\.4|7\.2\.2|7\.1\.8|7\.1\.6|7\.1\.4|7\.1\.2|5\.2\.4|5\.1\.6|5\.1\.4|5\.1\.2|3\.1\.2|7\.2|5\.2|7\.1|6\.1|5\.1|4\.1|4\.0|3\.1|3\.0|2\.1|2\.0|1\.0)$/;
  if (layouts.test(stored)) return stored;
  const technicalText = [download?.filename || '', download?.tags || ''].join(' ');
  const match = technicalText.match(/(?<!\d)(11\.1\.8|9\.1\.8|9\.1\.6|9\.1\.4|7\.2\.4|7\.2\.2|7\.1\.8|7\.1\.6|7\.1\.4|7\.1\.2|5\.2\.4|5\.1\.6|5\.1\.4|5\.1\.2|3\.1\.2|7\.2|5\.2|7\.1|6\.1|5\.1|4\.1|4\.0|3\.1|3\.0|2\.1|2\.0|1\.0)(?!\d)/i);
  if (match) return match[1];
  if (/\b(?:STEREO|2CH)\b/i.test(technicalText)) return '2.0';
  if (/\b(?:MONO|1CH)\b/i.test(technicalText)) return '1.0';
  return '';
}
function buildAudioDisplayTag(download, audioValue) {
  const tracks = Array.isArray(download?.audioTracks) ? download.audioTracks : [];
  const explicitTrackLabels = tracks.map(track => {
    const codec = normalizeAudioDisplayLabel(track?.codec);
    if (!codec) return '';
    const channels = detectAudioChannelsForDisplay({ audioChannels: track?.channels || '' });
    const language = String(track?.language || '').trim();
    return codec
      + (channels ? ' + ' + channels : '')
      + (language ? ' (' + language + ')' : '');
  }).filter(Boolean);
  const uniqueTrackLabels = [...new Set(explicitTrackLabels)];
  if (uniqueTrackLabels.length >= 2) return uniqueTrackLabels.join(' / ');

  const audio = normalizeAudioDisplayLabel(audioValue || download?.audio);
  if (!audio) return '';
  const channels = detectAudioChannelsForDisplay(download);
  return channels ? audio + ' + ' + channels : audio;
}

function buildTechnicalMetadataTags(info, download) {
  const dl = download || {};
  const videoParts = [
    info?.hdr,
    info?.source,
    info?.codec,
    String(dl.bitDepth || '').trim(),
  ].filter(Boolean);
  if (dl.isIMAX || /\bIMAX\b/i.test(dl.filename || '')) videoParts.push('IMAX');
  if (dl.aspectRatio) videoParts.push('AR ' + dl.aspectRatio);
  const audioTag = buildAudioDisplayTag(dl, info?.audio);
  const parts = [...videoParts];
  if (audioTag) parts.push(audioTag);
  if ((videoParts.length || audioTag) && info?.platform) parts.push(info.platform);
  return parts.join(' · ');
}

// ── Flat-list download section ─────────────────────────────────────────────────
function buildDownloadSection(rawDownloads, fallbackLang, mediaType) {
  if (!rawDownloads || rawDownloads.length === 0) return '';

  const toMB = s => { if (!s) return 0; const n = parseFloat(s); return /GB/i.test(s) ? n*1024 : (n||0); };

  function normalizeSourceLabel(value) {
    const s = String(value || '').toUpperCase();
    if (/\bREMUX\b/.test(s)) return 'REMUX';
    if (/\b(?:BLU[.\s_-]?RAY|BLURAY|BDRIP|BRRIP|BD[ ._-]?(?:25|50)|BDMV)\b/.test(s)) return 'BluRay';
    if (/\bDVD[.\s_-]?9\b/.test(s)) return 'DVD9';
    if (/\bDVD[.\s_-]?5\b/.test(s)) return 'DVD5';
    if (/\bWEB[.\s_-]?DL\b|\bWEBDL\b/.test(s)) return 'WEB-DL';
    if (/\bWEB[.\s_-]?RIP\b|\bWEBRIP\b/.test(s)) return 'WEBRip';
    if (/\bHDTV\b/.test(s)) return 'HDTV';
    if (/\bHDRIP\b|\bHD[.\s_-]?RIP\b/.test(s)) return 'HDRip';
    if (/\bDVDRIP\b|\bDVD\b/.test(s)) return 'DVD';
    if (/\b(?:CAMRIP|HDCAM|CAM)\b/.test(s)) return 'CAM';
    return '';
  }

  // ─ Per-file metadata detection ───────────────────────────────────────────
  function parseDlInfo(dl) {
    const fn   = dl.filename || '';
    const tags = (dl.tags || '').toLowerCase();


    const languageInfo = detectDownloadLanguageInfo(dl);
    const detectedLangs = languageInfo.languages;
    const languageType = languageInfo.languageType;
    const isMulti = languageType === 'Multi';
    // Keep each download row compact on mobile: names for Single, type only for Dual/Multi.
    const langLabel = languageType === 'Multi' ? 'MULTi'
      : languageType === 'Dual' ? 'DUAL'
      : detectedLangs.length ? detectedLangs[0] : '';

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

    // Normalize source labels in legacy rows and infer missing values from filenames.
    let source = normalizeSourceLabel(fn) || normalizeSourceLabel(dl.source) || normalizeSourceLabel(tags);

    // Audio: preserve stored metadata first, then recognize common release-codec aliases.
    let audio = dl.audio || '';
    if (!audio) {
      if (/truehd/i.test(fn)) audio = /\batmos\b/i.test(fn) ? 'TrueHD Atmos' : 'TrueHD';
      else if (/dts[.\s_-]?x\b/i.test(fn)) audio = 'DTS:X';
      else if (/dts[.\s_-]?hd[.\s_-]?ma\b|dts[.\s_-]?hd[.\s_-]?master[.\s_-]*audio\b/i.test(fn)) audio = 'DTS-HD MA';
      else if (/dts[.\s_-]?hd[.\s_-]?(?:hra|hr)\b|dts[.\s_-]?hd[.\s_-]*high[.\s_-]*resolution[.\s_-]*audio\b/i.test(fn)) audio = 'DTS-HD HRA';
      else if (/dts[.\s_-]?hd\b/i.test(fn)) audio = 'DTS-HD';
      else if (/dts[.\s_-]?es\b/i.test(fn)) audio = 'DTS-ES';
      else if (/dts[.\s_-]?96[.\s_-]?24\b/i.test(fn)) audio = 'DTS 96/24';
      else if (/dts[.\s_-]?express\b/i.test(fn)) audio = 'DTS Express';
      else if (/dolby[.\s_-]*digital[.\s_-]*ex|\bdd[.\s_-]*ex\b/i.test(fn)) audio = 'DD-EX';
      else if (/e[.\s_-]?ac[.\s_-]?3[.\s_-]*joc\b|\bddp[.\s_-]*joc\b/i.test(fn)) audio = 'EAC3 JOC';
      else if (/e[.\s_-]?ac[.\s_-]?3|\bddp\+?|\bdd\+|dolby[.\s_-]*digital[.\s_-]*plus/i.test(fn)) audio = /\batmos\b/i.test(fn) ? 'DDP Atmos' : 'DDP';
      else if (/\bac[.\s_-]?3\b|\bdd5[.\s_-]?1|\bdd\b|dolby[.\s_-]*digital/i.test(fn)) audio = 'DD';
      else if (/\bac[.\s_-]?4\b/i.test(fn)) audio = 'AC4';
      else if (/\bmpeg[.\s_-]*h(?:[.\s_-]*3d)?\b/i.test(fn)) audio = 'MPEG-H';
      else if (/\bauro[.\s_-]?3d\b/i.test(fn)) audio = 'Auro-3D';
      else if (/\bhe[.\s_-]?aac[.\s_-]?v?2\b|\bheaacv?2\b/i.test(fn)) audio = 'HE-AAC v2';
      else if (/\bhe[.\s_-]?aac\b|\bheaac\b/i.test(fn)) audio = 'HE-AAC';
      else if (/\baac[.\s_-]?lc\b/i.test(fn)) audio = 'AAC-LC';
      else if (/\baac\b/i.test(fn)) audio = 'AAC';
      else if (/\bflac\b/i.test(fn)) audio = 'FLAC';
      else if (/\bopus\b/i.test(fn)) audio = 'Opus';
      else if (/\balac\b/i.test(fn)) audio = 'ALAC';
      else if (/\blpcm\b/i.test(fn)) audio = 'LPCM';
      else if (/\bpcm\b/i.test(fn)) audio = 'PCM';
      else if (/\bvorbis\b/i.test(fn)) audio = 'Vorbis';
      else if (/\bmp3\b|mpeg[.\s_-]*1[.\s_-]*layer[.\s_-]*iii/i.test(fn)) audio = 'MP3';
      else if (/\bmp2\b|mpeg[.\s_-]*1[.\s_-]*layer[.\s_-]*ii/i.test(fn)) audio = 'MP2';
      else if (/\bmlp\b/i.test(fn)) audio = 'MLP';
      else if (/\bwma[.\s_-]*lossless\b/i.test(fn)) audio = 'WMA Lossless';
      else if (/\bwma[.\s_-]*pro\b/i.test(fn)) audio = 'WMA Pro';
      else if (/\bwma\b/i.test(fn)) audio = 'WMA';
      else if (/\batrac(?:3(?:plus)?|advanced[.\s_-]*lossless)?\b/i.test(fn)) audio = 'ATRAC';
      else if (/\bdra\b/i.test(fn)) audio = 'DRA';
      else if (/\brealaudio\b|\breal[.\s_-]*audio\b/i.test(fn)) audio = 'RealAudio';
      else if (/\bspeex\b/i.test(fn)) audio = 'Speex';
      else if (/\bamr[.\s_-]*(?:wb|nb)\b/i.test(fn)) audio = fn.match(/\bamr[.\s_-]*(?:wb|nb)\b/i)[0].replace(/[.\s_-]+/g, '-').toUpperCase();
    }


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
    if (!codec  && dl.codec && dl.codec !== 'Other') codec = dl.codec;
    if (!audio  && dl.audio)  audio  = dl.audio;
    if (!hdr    && dl.hdr)    hdr    = dl.hdr;
    if (!source && dl.source) source = dl.source;
    // Normalize codec stored values
    if (codec && /hevc|h\.265|x265/i.test(codec))      codec = 'HEVC';
    else if (codec && /avc|h\.264|x264/i.test(codec))  codec = 'AVC';
    else if (codec && /av1/i.test(codec))               codec = 'AV1';

    return { lang: langLabel, languageType, languageCount: detectedLangs.length, res, hdr, codec, source, audio, platform, isMulti,
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

    const techTags = buildTechnicalMetadataTags(info, dl);

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
        languageType: info.languageType,
        languageCount: info.languageCount,
        isMulti:     info.isMulti,
        isRepack:    !!dl.isRepack || /\bre[\s._-]?pack\b/i.test(String(dl.releaseType || '') + ' ' + (dl.filename || '')),
        releaseType: dl.releaseType || '',
        isIMAX:      !!dl.isIMAX,
        aspectRatio: dl.aspectRatio || '',
        sourceDate:  dl.sourceDate || dl.date || '',
        rank:        HOST_RANK[hostLabel] ?? 99,
        season:      dl.season,
        episode:     dl.episode,
      });
    });
  });

  if (rows.length === 0) return '';

  // ─ Sort: episode → resolution → numeric size desc → language → host ───────
  const Q_ORDER = {'4K':0,'1080p':1,'720p':2,'480p':3,'360p':4,'HD':5};

  // Language priority is deliberately a tie-breaker, not a primary grouping.
  // This lets larger Telugu/Hindi files rank above smaller MULTI files.
  const LANG_ORDER = { 'multi':0, 'telugu':1, 'tamil':2, 'hindi':3, 'malayalam':4, 'kannada':5 };
  function langPriority(lang, languageType) {
    if (!lang) return 99;
    const l = String(lang).toLowerCase();
    if (languageType === 'Multi' || languageType === 'Dual' || /multi|dual|4-in-1|5-in-1/i.test(l)) return 0;
    for (const [key, val] of Object.entries(LANG_ORDER)) { if (l.includes(key)) return val; }
    return 99;
  }

  // Convert every supported file-size unit to bytes before comparing.
  // Unsuffixed legacy values and numeric values retain the old MB interpretation.
  function telegramDateToMs(value) {
    if (!value) return 0;
    const raw = String(value).trim();
    if (/^\d{10,13}$/.test(raw)) {
      const numeric = Number(raw);
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function sizeToBytes(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number') {
      return Number.isFinite(value) && value > 0 ? value * 1024 ** 2 : 0;
    }

    const normalized = String(value).replace(/,/g, '').trim();
    const match = normalized.match(/(\d+(?:\.\d+)?)\s*(TB|TIB|GB|GIB|MB|MIB|KB|KIB|BYTES?|B)?/i);
    if (!match) return 0;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const unit = (match[2] || 'MB').toUpperCase();
    const power = unit.startsWith('T') ? 4
      : unit.startsWith('G') ? 3
      : unit.startsWith('M') ? 2
      : unit.startsWith('K') ? 1 : 0;
    return amount * (1024 ** power);
  }

  rows.sort((a, b) => {
    // 1. Preserve season/episode ordering for series.
    if (a.season != null || b.season != null) {
      const seA = (a.season||0)*1000 + (a.episode||0);
      const seB = (b.season||0)*1000 + (b.episode||0);
      if (seA !== seB) return seA - seB;
    }
    // 2. Keep resolution tiers intact: 4K > 1080p > 720p ...
    const qa = Q_ORDER[a.quality]??9, qb = Q_ORDER[b.quality]??9;
    if (qa !== qb) return qa - qb;
    // 3. Keep a same-resolution repack ahead of its older main/original release.
    if (a.isRepack !== b.isRepack) return a.isRepack ? -1 : 1;
    // Within repacks of this resolution, prefer the newest Telegram upload.
    if (a.isRepack && b.isRepack) {
      const dateDiff = telegramDateToMs(b.sourceDate) - telegramDateToMs(a.sourceDate);
      if (dateDiff) return dateDiff;
    }
    // 4. Compare actual byte counts first within a release class.
    const sa = sizeToBytes(a.size), sb = sizeToBytes(b.size);
    if (sb !== sa) return sb - sa;
    // 4. Language is only used when file sizes tie.
    const la = langPriority(a.lang, a.languageType), lb = langPriority(b.lang, b.languageType);
    if (la !== lb) return la - lb;
    // 5. Retain the existing provider preference as the final tie-breaker.
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

    const langText = formatDownloadLanguageLabel(row.languageType, row.lang);
    const langBadge = langText
      ? `<span class="dl-row-lang">${langText}</span>`
      : '';
    const repackBadge = row.isRepack
      ? '<span class="dl-row-lang" title="Repack release">REPACK</span>'
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
            ${repackBadge}
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
      year: Number(ts.year) || null,
      eps: {},
      packs: []  // Season packs (full season zip files, episode=null)
    };
  });

  // 2. Map available downloads — SEPARATE packs from individual episodes
  if (downloads) {
    downloads.forEach(dl => {
      // Read the real season from the filename if the DB season is wrong
      const s = dl.season || 1;
      const downloadYear = Number(dl.fileYear || dl.seasonYear) || null;
      if (!seasons[s]) seasons[s] = { tmdbCount: 0, name: `Season ${s}`, year: downloadYear, eps: {}, packs: [] };
      else if (!seasons[s].year && downloadYear) seasons[s].year = downloadYear;
      
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
          Season ${s}${sd.year ? ' · ' + sd.year : ''} ${epBadge}
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
