// ═══════════════════════════════════════════════════════════════════════════
// utils/parser.js  ─ v6 ULTRA
// Central Intelligent Parser — the brain of the entire pipeline.
// v6 changes: stronger junk skip, season-range detection, numeric title
// protection, release-group trailer stripper, O→0 S-tag normalization,
// IMAX/Edition strip, channel-hub junk pattern, batch list detection.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

// ─── EMOJI STRIP ─────────────────────────────────────────────────────────────
function stripEmojis(str) {
  if (!str) return '';
  const norm = str.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return norm
    .replace(/(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g,'')
    .replace(/[\u{1F000}-\u{1FFFF}]/gu,'')
    .replace(/[\u{2600}-\u{27BF}]/gu,'')
    .replace(/[\u200d\ufe0f\u20e3]/g,'')
    .trim();
}

// ─── QUALITY ─────────────────────────────────────────────────────────────────
function normalizeQuality(str) {
  if (!str) return 'HD';
  const s = str.toUpperCase();
  if (/2160P|4K\b|UHD/.test(s)) return '4K';
  if (/1080P/.test(s))           return '1080p';
  if (/720P/.test(s))            return '720p';
  if (/480P/.test(s))            return '480p';
  if (/360P/.test(s))            return '360p';
  return 'HD';
}

// ─── SIZE ────────────────────────────────────────────────────────────────────
function extractSize(str) {
  if (!str) return '';
  const pats = [
    /[\[\(]\s*(\d+(?:\.\d+)?\s*(?:GB|MB))\s*[\]\)]/i,
    /(\d+(?:\.\d+)?\s*(?:GB|MB))/i,
  ];
  for (const re of pats) {
    const m = str.match(re);
    if (m) return m[1].replace(/\s+/g,'').trim();
  }
  return '';
}

// ─── STREAMING URL → TITLE SLUG ──────────────────────────────────────────────
function extractTitleFromStreamingUrl(url) {
  if (!url) return '';
  const patterns = [
    { re: /\/movie\/watch-([a-z0-9-]+?)-(?:movie|show)-online/i, g: 1 },
    { re: /\/(?:movie|show|series|episodes|episode|title)\/([a-z][a-z0-9-]{3,50})(?:\/|$)/i, g: 1 },
    { re: /\/(?:watch|details)\/([a-z][a-z0-9-]{3,50})-\d+/i, g: 1 },
  ];
  for (const { re, g } of patterns) {
    const m = url.match(re);
    if (m && m[g] && !/^\d+$/.test(m[g]) && m[g].length > 3) {
      const slug = m[g]
        .replace(/-/g,' ')
        .replace(/\b(the|a|an|of|in|on|at|to|for|and|or|but)\b/gi, w=>w.toLowerCase())
        .replace(/\b\w/g, c=>c.toUpperCase())
        .trim();
      if (slug.length >= 3) return slug;
    }
  }
  return '';
}

// ─── URL CLASSIFIER ──────────────────────────────────────────────────────────
const DIRECT_RE = [
  /gdflix\.(dev|to|one|link|net|dad|cfd)/i, /gdlink\.dev/i,
  /hubcloud\.(foo|one|art|cx|lol|bz|club|in|to|work|zone|dev|me|best)/i,
  /drivehub\.(dev|to|in|online)/i,
  /filepress\.(store|wiki|in|me|xyz)/i, /fpgo\.xyz/i,
  /dtflix\.ink/i, /dotflix\.wtf/i,
  /tmbcloud\.(dev|online|lol)/i,
  /files\.catbox\.moe/i, /gdtot\.(dad|one|sbs)/i,
  /extralink\.cfd/i, /neolinks\.sbs/i, /gtlinks\.me/i,
  /filebee\.xyz/i,
  /streamtape\.(com|co)/i, /mixdrop\.(co|to|ag)/i,
  /dood\.(la|so|pm|to|watch|re)/i, /buzzheavier\.com/i,
  /pixeldrain\.com\/u\//i, /1fichier\.com/i,
];
const SHORTLINK_RE = [
  /oyy\./i,/ouo\./i,/gplinks\./i,/softurl\./i,/arolinks\./i,/vplink\./i,
  /anyshorturl\./i,/droplink\./i,/mdisk\./i,/terabox/i,/1024tera\./i,
  /bit\.ly/i,/tinyurl\./i,/rb\.gy/i,/t\.ly/i,/cutt\.ly/i,
  /linkvertise\./i,/adf\.ly/i,/short\.io/i,/rebrand\.ly/i,
  /shrinkme\./i,/earnload\./i,/iir\.ai/i,/kglinks\./i,/linksace\./i,
  /dl\.fliprs\./i,/techyjagran\./i,/safelinking\./i,/iiv\.li/i,
  /urlo\.cc/i,/go2share\./i,/oke\.io/i,/linksly\./i,/shrink\./i,
  /reviewsbuddy\./i,/nowshorturl\./i,/nanolinks\./i,/tnshort\./i,
  /minifyurls\./i,/urllinkshort\./i,/shorturl\./i,/shrt\.me/i,
];
const PASTE_RE = [
  /paste\.rs/i,/pastebin\.com/i,/telegra\.ph/i,/graph\.org/i,
  /katb\.in/i,/justpaste\.it/i,/rentry\.co/i,/hastebin\./i,
];
const IGNORE_RE = [
  /t\.me\//i,/telegram\.me\//i,
  /youtube\.com/i,/youtu\.be/i,/yt\.be/i,/youtube-nocookie\.com/i,
  /gofile\.io/i,
  /drive\.google\.com/i,/image\.tmdb\.org/i,/m\.media-amazon\.com/i,
  /hotstar/i,/jiohotstar\./i,/jiocinema\./i,
  /primevideo\./i,/netflix\./i,/play\.google\./i,
  /mxplayer\./i,/etvwin/i,/zee5\./i,
  /aha\.(video|in|com)/i,/sonyliv\./i,
  /tentkotta\./i,/sunnxt\./i,/sun\.nxt/i,/tv\.apple\./i,/apple\.com\/.*movie/i,
  /hoichoi\./i,/manoramamax\./i,/chaupal\./i,/shemaroo/i,/voot\./i,/hungama\./i,/lionsgate/i,/stage\.in/i,
  /x\.com/i,/twitter\.com/i,/instagram\.com/i,/facebook\.com/i,
  /encrypted-tbn0\.gstatic\.com/i,/i\.ibb\.co/i,/iili\.io/i,
  /occ-0-\d+-\d+\./i,/img\d*\.hotstar\.com/i,/i\.slow\.pics/i,
  /photo\.chelpbot\.me/i,/akamaized\.net/i,/cloudfront\.net/i,
  /vflix\./i, /vifix\./i, /dtflix\./i, /dotflix\./i,
  /\.(jpg|jpeg|png|webp|gif|svg)(\?.*)?$/i,
];

function classifyUrl(url) {
  if (!url) return 'Ignore';
  if (IGNORE_RE.some(r=>r.test(url)))    return 'Ignore';
  // Mediainfo links are never download links — always filter
  if (/mediainfo|media\.info|mfinfo/i.test(url)) return 'Ignore';
  if (PASTE_RE.some(r=>r.test(url)))     return 'Paste';
  if (SHORTLINK_RE.some(r=>r.test(url))) return 'Shortlink';
  if (/gdflix\.|gdlink\.dev|gdtot\./i.test(url))   return 'GDFlix';
  if (/hubcloud\.|drivehub\./i.test(url))           return 'HubCloud';
  if (/filepress\.|fpgo\.xyz/i.test(url))           return 'FilePress';
  if (/tmbcloud\./i.test(url))                       return 'TMBCloud';
  if (/drivenext\./i.test(url))                      return 'DriveNext';
  if (DIRECT_RE.some(r=>r.test(url)))   return 'Direct';
  if (/\/(file|download|d|dl|f)\/[a-zA-Z0-9_\-]{4,}/i.test(url)) return 'Direct';
  if (/\.(mkv|mp4|avi|zip|rar|m2ts|ts|mov)(\?.*)?$/i.test(url))  return 'Direct';
  return 'Download';
}
function detectHost(url) {
  const c = classifyUrl(url);
  return (c==='Ignore'||c==='Paste'||c==='Download') ? 'Download' : c;
}

// ─── METADATA LINE DETECTOR ───────────────────────────────────────────────────
// Returns true for lines that are channel/format headers, NOT real title/filename lines
function isMetadataLine(line) {
  const s = (line || '').trim();
  if (!s) return false;
  // Pure hashtag-only lines: '#NF_WEBDL #MULTI_AUDIO', '#APPLETVPLUS #UHD'
  if (/^(#[A-Za-z0-9_]+(?:\s+#[A-Za-z0-9_]+)*)\s*$/.test(s)) return true;
  // Mixed bullet+hashtag: '~.  #DUAL_AUDIO', '~  #MULTI_AUDIO'
  if (/^[~\-•*._\s]+#[A-Za-z0-9_]+/i.test(s) && !/\.(mkv|mp4|avi|zip)\b/i.test(s)) return true;
  // Section headers (case-insensitive): 'DRIVE LINKS: #HUBCLOUD', 'TELEGRAM FILES:', 'AVC', 'HEVC'
  if (/^(DRIVE\s+LINKS?|TELEGRAM\s+FILES?|HEVC\s*$|AVC\s*$)\s*[:#]?/i.test(s)) return true;
  // Size / File Size lines: 'Size : 8.36 GB', 'File Size: 6.74 GB'
  if (/^(?:File\s*)?Size\s*[:]\/?.*/i.test(s) && /\d/.test(s)) return true;
  // 'Click Here', 'Join', 'Credits', etc. (not inline with real content)
  if (/^(?:[[LINK][SAVE]\s]*)?(CLICK\s+HERE|JOIN\s+NOW|CREDITS?\s*:?|SUBSCRIBE|BACKUP\s+CHANNEL)\s*$/i.test(s)) return true;
  // Quality/format lists without filename: 'DOLBY VISION 4K , SDR 4K , 1080P'
  if (/^(DOLBY\s+VISION|SDR|HLG|HDR|AVC|HEVC)\b/i.test(s) && !/\.(mkv|mp4|avi|zip)\b/i.test(s) && s.length < 60) return true;
  return false;
}

// ─── LANGUAGE ────────────────────────────────────────────────────────────────
const LANG_MAP = [
  { name:'Telugu',    re:/(?:\b|(?<=\W|^))(tel(?:ugu)?|tl|తెలుగు)(?:\b|(?=\W|$))/i },
  { name:'Tamil',     re:/(?:\b|(?<=\W|^))(tam(?:il)?|tk|தமிழ்)(?:\b|(?=\W|$))/i },
  { name:'Hindi',     re:/(?:\b|(?<=\W|^))(hin(?:di)?|हिन्दी|हिंदी)(?:\b|(?=\W|$))/i },
  { name:'Malayalam', re:/(?:\b|(?<=\W|^))(mal(?:ayalam)?|ml|മലയാളം)(?:\b|(?=\W|$))/i },
  { name:'Kannada',   re:/(?:\b|(?<=\W|^))(kan(?:nada)?|kn|ಕನ್ನಡ)(?:\b|(?=\W|$))/i },
  { name:'Bengali',   re:/(?:\b|(?<=\W|^))(ben(?:gali)?|bang|বাংলা)(?:\b|(?=\W|$))/i },
  { name:'English',   re:/(?:\b|(?<=\W|^))(eng(?:lish)?)(?:\b|(?=\W|$))/i },
  { name:'Marathi',   re:/(?:\b|(?<=\W|^))(mar(?:athi)?|मराठी)(?:\b|(?=\W|$))/i },
  { name:'Punjabi',   re:/(?:\b|(?<=\W|^))(pun(?:jabi)?|ਪੰਜਾਬੀ)(?:\b|(?=\W|$))/i },
  { name:'Japanese',  re:/(?:\b|(?<=\W|^))(japanese|jpn|jap)(?:\b|(?=\W|$))/i },
  { name:'Korean',    re:/(?:\b|(?<=\W|^))(korean|kor)(?:\b|(?=\W|$))/i },
  { name:'Chinese',   re:/(?:\b|(?<=\W|^))(chinese|chi|mandarin)(?:\b|(?=\W|$))/i },
  { name:'Arabic',    re:/(?:\b|(?<=\W|^))(arabic|ara|عربي|عربى)(?:\b|(?=\W|$))/i },
  { name:'Turkish',   re:/(?:\b|(?<=\W|^))(turkish|tur)(?:\b|(?=\W|$))/i },
  { name:'Spanish',   re:/(?:\b|(?<=\W|^))(spanish|spa)(?:\b|(?=\W|$))/i },
  { name:'French',    re:/(?:\b|(?<=\W|^))(french|fre)(?:\b|(?=\W|$))/i },
  { name:'German',    re:/(?:\b|(?<=\W|^))(german|ger)(?:\b|(?=\W|$))/i },
  { name:'Multi',     re:/(?:\b|(?<=\W|^))(multi(?:[.\-_]?audio)?|dual[.\-_]?audio|bilingual|tri[.\-_]?audio|dual)(?:\b|(?=\W|$))/i },
];
const CHAN_LANG = [
  {re:/telugu|tg4u|tollywood/i, lang:'Telugu'},
  {re:/tamil|kollywood/i,       lang:'Tamil'},
  {re:/hindi|bolly/i,           lang:'Hindi'},
  {re:/mallu|malayalam/i,       lang:'Malayalam'},
  {re:/kannada|sandalwood/i,    lang:'Kannada'},
  {re:/anime|manga|jpn/i,       lang:'Japanese'},
  {re:/korean|kdrama/i,         lang:'Korean'},
];

function detectAllLanguages(str) {
  if (!str) return [];
  const found = new Set();
  for (const {name,re} of LANG_MAP) if (re.test(str)) found.add(name);
  // Bracket notation
  const brackets = str.match(/[\[({]([A-Za-z]+(?:[-+\/, ][A-Za-z]+)+)[\])}]/g)||[];
  for (const b of brackets) {
    for (const part of b.slice(1,-1).split(/[-+\/,\s]+/)) {
      for (const {name,re} of LANG_MAP) if (re.test(part.trim())) found.add(name);
    }
  }
  // Channel/hashtag tags
  for (const tag of (str.match(/#[A-Za-z]+|@[A-Za-z0-9_]+/g)||[])) {
    for (const {re,lang} of CHAN_LANG) if (re.test(tag)) found.add(lang);
  }
  return Array.from(found);
}
function detectLanguage(str) {
  const langs = detectAllLanguages(str);
  if (!langs.length) return '';
  const spec = langs.filter(l=>l!=='Multi');
  return spec.length ? spec.join(', ') : 'Multi';
}

// ─── CODEC ───────────────────────────────────────────────────────────────────
function detectCodec(fn) {
  const s=(fn||'').toUpperCase();
  if (/\bAV1\b/.test(s))              return 'AV1';
  if (/HEVC|H\.265|X265|H265/.test(s)) return 'HEVC';
  if (/\bAVC\b|H\.264|X264|H264/.test(s)) return 'H.264';
  return 'Other';
}

// ─── HDR ─────────────────────────────────────────────────────────────────────
function detectHDR(fn) {
  const s=(fn||'').toUpperCase();
  if (/DOLBY\s*VISION|\.DV\.|\bDV\b/.test(s)) return 'Dolby Vision';
  if (/HDR10\+|HDR10P/.test(s))               return 'HDR10+';
  if (/HDR10/.test(s))                         return 'HDR10';
  if (/\bHDR\b/.test(s))                       return 'HDR';
  if (/HLG/.test(s))                           return 'HLG';
  if (/\bSDR\b/.test(s))                       return 'SDR';
  return null;
}

// ─── AUDIO ───────────────────────────────────────────────────────────────────
// Detects audio codec/format from a filename or message text.
// Returns a short label string or null.
function extractAudio(fn) {
  const s = (fn || '').toUpperCase();
  // Dolby Atmos (must check before TrueHD/DDP since Atmos is often combined)
  if (/DOLBY\s*ATMOS|\bATMOS\b/.test(s))           return 'Atmos';
  // Dolby TrueHD
  if (/TRUEHD/.test(s))                             return 'TrueHD';
  // DTS variants — order matters: check X and HD-MA before plain DTS
  if (/DTS[:\s._-]?X\b/.test(s))                   return 'DTS:X';
  if (/DTS[:\s._-]?HD[:\s._-]?MA/.test(s))         return 'DTS-HD MA';
  if (/DTS[:\s._-]?HD/.test(s))                     return 'DTS-HD';
  if (/\bDTS\b/.test(s))                            return 'DTS';
  // Dolby Digital Plus / EAC3
  if (/EAC[\s._-]?3|DD[P+]/.test(s))               return 'EAC3';
  // Dolby Digital / AC3
  if (/\bAC[\s._-]?3\b|\bDD\b/.test(s))            return 'DD';
  // AAC
  if (/\bAAC\b/.test(s))                            return 'AAC';
  // FLAC
  if (/\bFLAC\b/.test(s))                           return 'FLAC';
  // MP3
  if (/\bMP3\b/.test(s))                            return 'MP3';
  return null;
}

// ─── SIZE → MB ───────────────────────────────────────────────────────────────
// Converts a size string like "1.5 GB" or "800MB" to a float in MB.
function toMB(s) {
  if (!s) return 0;
  const n = parseFloat(s);
  return /GB/i.test(s) ? n * 1024 : (n || 0);
}

// ─── CONTENT TYPE ────────────────────────────────────────────────────────────
function detectContentType(text) {
  const t=(text||'').toLowerCase();
  if (
    /\banime\b/.test(t)||/\bfunimation\b/.test(t)||/\bcrunchyroll\b/.test(t)||
    /\baniwatch\b/.test(t)||
    /\b(one[\s._-]?piece|naruto|bleach|dragon[\s._-]?ball|dbz|dbs|attack[\s._-]?on[\s._-]?titan|aot|demon[\s._-]?slayer|kimetsu|jujutsu[\s._-]?kaisen|jjk|my[\s._-]?hero[\s._-]?academia|mha|fullmetal[\s._-]?alchemist|fma|death[\s._-]?note|fairy[\s._-]?tail|hunter[\s._-]?x[\s._-]?hunter|hxh|sword[\s._-]?art[\s._-]?online|sao|black[\s._-]?clover|boruto|shingeki|mob[\s._-]?psycho|chainsaw[\s._-]?man|spy[\s._-]?x[\s._-]?family|vinland[\s._-]?saga|haikyuu|tensura|slime|goblin[\s._-]?slayer|shield[\s._-]?hero|isekai|re[\s:_-]?zero|overlord|violet[\s._-]?evergarden|your[\s._-]?name|kimi[\s._-]?no|spirited[\s._-]?away|howl|totoro|ghibli|cowboy[\s._-]?bebop|inuyasha|one[\s._-]?punch|tokyo[\s._-]?ghoul|blue[\s._-]?exorcist|noragami|parasyte|made[\s._-]?in[\s._-]?abyss|promised[\s._-]?neverland|dr\.?\s*stone|fire[\s._-]?force|black[\s._-]?butler|berserk|devilman|dandadan|dungeon[\s._-]?meshi|frieren|oshi[\s._-]?no[\s._-]?ko|blue[\s._-]?lock|mashle|bocchi|konosuba|overlord|rezero|clannad|steins[\s._-]?gate|neon[\s._-]?genesis|evangelion)\b/i.test(t)
  ) return 'anime';

  if (
    /\bs[o0]?\d{1,2}e[o0]?\d{1,3}\b/i.test(t)||/\bseason\s*\d+\b/i.test(t)||
    /\bepisode\s*\d+\b/i.test(t)||/\bep\s*\d+\b/i.test(t)||
    /\bcomplete\s*(series|season)\b/i.test(t)||
    /\bcomplete\s+series\b/i.test(t)||
    /\bseason\s*\d+\s*[-–to]+\s*\d+\b/i.test(t)||  // "Season 1-5", "Season 1 to 5"
    /\bs\d{1,2}[-–]s\d{1,2}\b/i.test(t)||           // "S01-S05" pack
    /\b(web[\s-]?series|webseries)\b/i.test(t)||
    /\bs[o0]?\d{1,2}\b(?!\d)/i.test(t)||/\.s\d{2}\./.test(t)||
    /\bS[O0]\d{1,2}\b/.test(text)||
    /E\(\d{1,3}[-–]\d{1,3}\)/i.test(t)
  ) return 'series';

  return 'movie';
}

// ─── SEASON/EPISODE ──────────────────────────────────────────────────────────
function extractSeasonEpisode(str) {
  if (!str) return {season:null,episode:null};
  // Normalize: treat letter-O as digit-0 in season/episode tags (e.g. SO1, S0O2)
  const s = str.replace(/\bS([O0])(\d)/gi, 'S0$2').replace(/\bS(\d)([O])(\d)/gi, 'S$1$3');
  let m;
  // Standard SxxExx
  m=s.match(/\bS(\d{1,2})\s*E(\d{1,3})/i);
  if(m) return {season:+m[1],episode:+m[2]};
  // Episode range: E(01-08) or E(01–08)
  m=s.match(/[SE](\d{1,2})\s*E\((\d{1,3})[-–](\d{1,3})\)/i);
  if(m) return {season:+m[1],episode:+m[2]};
  // Plain range with season: SO1 E(01-08)
  m=s.match(/S(\d{1,2})\s+E\((\d{1,3})[-–]\d{1,3}\)/i);
  if(m) return {season:+m[1],episode:+m[2]};
  // Episode range without season: E(01-08)
  m=s.match(/E\((\d{1,3})[-–](\d{1,3})\)/i);
  if(m) return {season:1,episode:+m[1]};
  m=s.match(/\b(\d{1,2})x(\d{2,3})\b/i);
  if(m) return {season:+m[1],episode:+m[2]};
  m=s.match(/\bSeason\s*(\d+)\s*Episode\s*(\d+)\b/i);
  if(m) return {season:+m[1],episode:+m[2]};
  m=s.match(/\bSeason\s*(\d+)\b/i);
  if(m) return {season:+m[1],episode:null};
  m=s.match(/\bS(\d{1,2})\b(?!\d)/i);
  if(m) return {season:+m[1],episode:null};
  m=s.match(/\b(?:Ep|Episode)\s*(\d{1,3})\b/i);
  if(m) return {season:1,episode:+m[1]};
  return {season:null,episode:null};
}

// ─── CLEAN TITLE FOR API ─────────────────────────────────────────────────────
function cleanTitleForApi(title, year = null) {
  if (!title) return '';
  let rawClean = stripEmojis(title);

  // Pre-clean dots/underscores like pipeline_full does
  if (/[._]/.test(rawClean)) {
    const spaced = rawClean.replace(/[._]/g, ' ');
    const TECH_TOKEN_RE = /\b(2160p|1080p|720p|480p|360p|4K|UHD|WEB[-\s]?DL|WEBRip|BluRay|BDRip|HDRip|REMUX|HEVC|x265|x264|AV1|AVC|DVDRip|DVDScr|DVDBD|DVD5|DVD9|\bDVD\b|AMZN|NF|DSNP|ZEE5|SUNNXT|JIOHS|TK|SS|AHA|ARTL|HMAX|HOTSTAR|CRKL|PCOK|DPLS|DDPd?|AAC|DTS|FLAC|DD5|DD2|HDR|SDR|DV|HLG)\b/i;
    const techMatch = TECH_TOKEN_RE.exec(spaced);
    if (techMatch && techMatch.index > 3) rawClean = spaced.substring(0, techMatch.index);
    else rawClean = spaced;
  }
  
  if (year) {
    const yStr = String(year);
    const yi   = rawClean.indexOf(yStr);
    // yi >= 1 so even 1-char titles like 'Hi 2026' get year stripped
    if (yi >= 1 && /[\s.\-_(]/.test(rawClean[yi - 1] || '')) rawClean = rawClean.substring(0, yi).trim();
  }

  let cleaned = rawClean
    // ── Normalize Ampersands ──────────────────────────────────────────
    .replace(/\s*&\s*/g, ' and ')
    // ── Strip leading numbered lists (e.g. "1. ", "1) ") ─────────────────
    // IMPORTANT: Do NOT strip if the number is followed by letters (could be title like "300 Spartans")
    .replace(/^\s*(\d+)[\).}]\s+(?=\w)/g, '')
    // ── Strip Website URLs (e.g. www.telugumv.sbs) ────────────────────────
    .replace(/\b(?:www\.)?[a-zA-Z0-9-]+\.(?:com|org|net|in|co|me|sbs|xyz|cc|to|tv|site|link|info)\b/gi, '')
    .replace(/\b(?:www|sbs|telugumv)\b/gi, '')
    // ── Strip leading @channel handles first ──────────────────────────────
    .replace(/^@[A-Za-z0-9_]+\s*/g, '')
    // ── Strip Hoichoi/brand watermark suffixes ────────────────────────
    .replace(/\s*(HOiCHOi|Hoichoi)\s*(RAW|Unlimited|Original)\s*[A-Za-z0-9]*\s*$/i, '')
    .replace(/\s*(JoyMaa|JanaSeksPyaar|PodMereUreJabo|RoserGolla|MosirJANA|LiCKW33D|PodMere[A-Za-z]+)\s*$/i, '')
    // ── Language words ────────────────────────────────────────────────
    .replace(/\b(telugu|tamil|hindi|malayalam|kannada|bengali|english|marathi|japanese|korean|chinese|arabic|turkish|spanish|french|german|punjabi|dual|multi)\b/gi,'')
    // ── Resolution / quality ─────────────────────────────────────────
    .replace(/\b(2160p|1080p|720p|480p|360p|4[Kk]|UHD|WEB[\s._-]*DL|WEB[\s._-]*RIP|HDRip|HDTV|BluRay|BD[\s._-]*Rip|WEBRip|HEVC|x265|x264|H\.265|H\.264|H[\s._-]*265|H[\s._-]*264|AVC|HDR|HDR10P|DV|Remux|HLG|SDR|AV1|FLAC|AAC|DDP|DTS|Atmos|DD5|DD2|DVD[\s._-]*Rip|DVD[\s._-]*Scr|DVDBD|DVD5|DVD9|\bDVD\b)\b/gi,'')
    // ── Edition / Cut variants ────────────────────────────────────────
    .replace(/\b(IMAX|Remastered|Anniversary|Director.?s?\s*Cut|Extended\s*Cut|Special\s*Edition|Theatrical\s*Cut|Uncut|Unrated|Open\s*Matte|Hybrid|Fan\s*Edit|Edition)\b/gi,'')
    // ── Streaming platform codes (standalone 2-4 letter tags) ─────────────────
    .replace(/\b(AMZN|NF|DSNP|ZEE5|SUNNXT|JIOHS|AHA|ARTL|HMAX|CRKL|PCOK|DPLS|HOTSTAR|APPLETV|TVNZ|SS|TK|SLV|VOOT|ETVWIN)\b/gi,'')
    // ── Release group tags ────────────────────────────────────────────
    .replace(/\b(Rahul4K|JeRi|TK\s*\d+\s*\d+|AAC\s*\d+\s*\d+|ATV|ETV|JIOHS|DE3PM|DUDU|iP0|iP[12]|JHS|MSD4K|MKV4U|MKV4K|DHD|YTS|YIFY|RARBG|PSA|FGT|NTG|EVO|ION10|CMRG|FLUX|TEPES|SiGMA|ROCCaT|SPARKS|VEXT|ULTRAHDCLUB|SMURF|OFT|mkvcage|AGAT|MZABI|SiGMA|MRTRJ|MRN|TOMMY|GalaxyTV|Pahe|HONE|QxR|BRRip|R4RBG|SALT\s+AND\s+STARDUST)\b/gi,'')
    .replace(/\b(ManoramaMax|EtvWin|NaMovies|TamilBlasters|Isaimini|Kuttymovies|TamilRockers|Movierulz|HDHub4u|Filmyzilla|Cinemavilla|Tamilgun|ConradsHome|4X4RYA|SNXT|MMAX|AWS|AVMA|LIONS|APTV|4KDVS|HiDt|SPHD|FraMeSToR|ALiEN|Malli4U|Malli4UOfficial|Official2|Official|TeluguDrives|MoviesWorld|LGP|ANToNi|CBR|VBR|BDMV|LUMiX|OutKast|BlackSpider|PrimeFix|SKST|DarQ|ZoroSenpai)\b/gi,'')
    // ── Audio codec + channel format: DDP5.1, AAC 2.0, DD 5 1, etc ─────────────
    .replace(/\b(AAC|DDP|DD\+?|DD|AC3|DTS|FLAC)\s*[._]?\s*\d\s*[._]?\s*\d\b/gi,'')
    .replace(/\b(AAC|DDP|DD\+?|DD|AC3|DTS|FLAC)\b/gi,'')
    // ── Stray audio/video channel numbers: "5 1", "2 0", "7 1" after codec strip ──
    .replace(/\b[2-9]\s+[01]\b/g, '')
    .replace(/\bH\s*26[45]\b/gi,'')
    .replace(/\b(audio|video|track|tracks|soundtrack)\b/gi,'')
    .replace(/\b(iNTERNAL|INTERNAL|REPACK|PROPER|EXTENDED|THEATRICAL|UNRATED|DIRECTORS?[\s._-]*CUT)\b/gi,'')
    .replace(/\b\d+[\s.]\d+\s*GB\b/gi,'')
    .replace(/\b(mkv|mp4|avi|m2ts)\b/gi,'')
    .replace(/\bS\d{1,2}\s*E\d{1,3}\b/gi,'')
    .replace(/\b(?:EP|EPISODE|EPISODES)\s*\d{1,3}\b/gi,'')
    .replace(/\bE\d{1,3}\b/gi,'')
    .replace(/\bS\s*\d{1,2}\b(?!\d)/gi,'')
    .replace(/\bSeason\s*\d+\s*[-–to]+\s*\d+\b/gi,'')  // strip "Season 1-5", "Season 1 to 3"
    .replace(/\bSeason\s*\d+\b/gi,'')
    .replace(/\.(mkv|mp4|avi|mov|ts|m2ts|zip|rar)\b/gi,'')
    .replace(/v\d+|reloaded|uncut|extended/gi,'')
    .replace(/(?<!^)#[a-zA-Z0-9_]+/g,'')   // strip mid/end hashtags (channel tags) but NOT leading # (part of title like #Love)
    // ── Strip trailing standalone year (1900–2099) at end of title ───────────
    // Handles: 'Hi 2026', 'The Batman 2022', 'Movie (2024)', '2024-2025'
    .replace(/\s*\(\s*(19|20)\d{2}\s*\)\s*$/, '')          // trailing (2024)
    .replace(/\s+(19|20)\d{2}(?:[\s\-–]+(19|20)\d{2})?\s*$/, '')  // trailing 2024 or 2024-2025
    // ── Final stray digit pairs and cleanup ───────────────────────────────
    .replace(/\b\d\s+\d\b/g, '')
    .replace(/(?<!^[#])[^a-zA-Z0-9 \-'#]/g,' ')  // strip symbols but preserve leading # (title like #Love)
    .replace(/(?<=\s)#/g,' ')                      // strip # that appear mid-title after cleanup
    // ── Split CamelCase for unspaced titles (AhanaPellanta -> Ahana Pellanta) ─────────────
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g,' ')
    .trim()
    // ── Generic release-group trailer (CamelCase or ALL-CAPS single word) ──
    // Catches watermarks like "Benzmovies", "TamilMV", "TEAMX" at end of string
    .replace(/\s+[A-Z][a-z]{1,3}[A-Z][a-zA-Z0-9]{2,14}$/, '')   // CamelCase: "TamilMV"
    .replace(/\s+[A-Z]{3,12}(?:\d+[Kk]?)?$/, '')                  // ALL-CAPS: "TEAMX", "DS4K"
    .replace(/\s+s$/i, ''); // strip trailing 'S' often left behind

  const JUNK_WORDS = new Set(['audio', 'video', 'track', 'tracks', 'hdr10', 'h265', 'h264', 's01', 'e04', 'cbr', 'vbr', 'mkv', 'mp4', 'requested']);
  if (!cleaned || cleaned.length < 2 || JUNK_WORDS.has(cleaned.toLowerCase())) {
    return rawClean;
  }

  const parts = cleaned.split(' ');
  if (parts.length >= 2 && parts.length % 2 === 0) {
    const half = parts.length / 2;
    const p1 = parts.slice(0, half).join(' ');
    const p2 = parts.slice(half).join(' ');
    if (p1.toLowerCase() === p2.toLowerCase()) {
      cleaned = p1;
    }
  }

  return cleaned;
}

// ─── JUNK FILTER ─────────────────────────────────────────────────────────────
const JUNK_PATTERNS = [
  // ── Channel/group admin messages ─────────────────────────────────────────────
  /^(ALIGHT|ALIGHTMOVIES|TORRENT|PIRATE|BACKUP\s*CHANNEL|UPDATES?|GROUP\s*(LINK|JOIN)|OFFICIAL\s*(CHANNEL|GROUP)|ADMIN|FORWARD|SUBSCRIBE|EXCLUSIVE\s*CHANNEL)/i,
  /\b(check\s*this\s*out|sample\s*before|before\s*download|click\s*here|join\s*us|subscribe\s*now|backup\s*channel|new\s*channel|old\s*channel|daily\s*update|auto\s*delete|forward\s*this|copyright\s*notice|dmca\s*notice|taken\s*down|link\s*expired)\b/i,
  /\b(rip\s*this|upload\s*cheyyandi|upload\s*please|sync\s*chesi|please\s*upload|please\s*rip|request\s*movie|need\s*this|add\s*this|upload\s*this|upload\s*bro|without\s*any\s*sync|official\s*link|watch\s*online|stream\s*now)\b/i,
  /^(?:RECENTLY|NEWLY|JUST)\s+ADDED\b/i,

  // ── OTT platform names as standalone titles ───────────────────────────────
  /^[#\s]*(Netflix|Amazon|SonyLiv|Zee5|Aha|Hotstar|Disney|SunNXT|Crunchyroll|Funimation|SimplySouth|Hoichoi|ManoramaMax|Voot|Chaupal|Hungama|Lionsgate|Shemaroo|EtvWin|MXPlayer|JioCinema|PrimeVideo|AppleTV)[#\s]*$/i,

  // ── Metadata lines: Audio Tracks, Size, Bitrate, etc. ─────────────────────
  /^audio\s*tracks?\s*:/i,                                    // Audio Tracks : Telugu, Tamil...
  /^audio\s*track\s*(1|2|3|one|two|three)\b/i,               // Audio track 1 : Hindi
  /^size\s*:/i,                                               // Size : 8.36 GB
  /^\d+(?:\.\d+)?\s*(?:GB|MB)\s*$/i,                        // "2.55 GB" standalone
  /^\[\s*\d+(?:\.\d+)?\s*(?:GB|MB)\s*\]\s*$/i,              // [2.55 GB] standalone
  /^(?:bitrate|bit\s*rate|resolution|format|encoder|encoded?\s*by)\s*:/i,
  /^video\s*:/i,                                              // Video : H.265
  /^(?:subtitle|sub|subs?)\s*:/i,                             // Subtitle : English
  /^release\s*(?:date|info|note|year)\s*:/i,
  /^source\s*:/i,
  /^language\s*:/i,
  /^note\s*:/i,

  // ── Lines that ARE a language list (common in South Indian channels) ──────────
  // e.g. "తెలుగు, தமிழ், हिन्दी" or "Telugu | Tamil | Hindi | Malayalam"
  /^(?:(?:Telugu|Tamil|Hindi|Malayalam|Kannada|Bengali|Marathi|English|Japanese|Korean|Telugu|Punjabi|Odia|Gujarati|Urdu)[,|\s&]+){2,}$/i,

  // ── Technical-only titles (codec/quality descriptors with nothing else) ────
  /^(HDR10\+?|H265|H264|1080P|720P|480P|360P|2160P|4K|8K|HEVC|AVC|BD50|CBR|VBR|ENCODES|AUDIO|VIDEO|TRACKS?|CATALOG|PACK|DUMP|HIGH BITRATE|LOWER BITRATES?|\d+KPBS|\d+MBPS|\d+GB|\d+MB)$/i,

  // ── Channel/bot watermarks that appear as first lines ───────────────────
  /^TG\s*:\s*@/i,                                            // TG : @LiCKW33D
  /^@[A-Za-z]/,                                              // @channel
  /^[A-Z]{2,5}\s*:\s*@/i,                                   // CH : @handle etc

  // ── Titles starting with punctuation/codec badges ──────────────────────
  /^[,\s]*(HDR10\+?|HDR|HLG|SDR|DV|Dolby)/i,

  // ── Hashtag-leftover patterns: # # AUDIO, # UK, # NEWZEALAND, # Version Rip ──
  // These are produced when '#AMZN_WEBDL #MULTI_AUDIO' is cleaned and tags removed
  /^#\s+#\s*/i,                                           // '# # AUDIO', '# #'
  /^#\s+[A-Z]{2,15}\s*$/i,                               // '# UK', '# NEWZEALAND'
  /^#\s*(Version\s*Rip|ADDON|WEBDL|WEBDL|MULTI_AUDIO|MULTI|UHD)/i,
  /^(#[A-Za-z0-9_]+\s*){1,4}\s*$/,                       // pure hashtag line like '#NF_WEBDL #MULTI_AUDIO'

  // ── Channel/website brand handles appearing as title prefix ───────────────
  /^@[A-Za-z]/,          // Telegram channel handle = NOT a title


  // ── Event/sports match titles (FIFA, IPL, etc. — not movies) ─────────────
  /^\d{4}\s+(FIFA\s+World|IPL|ICC|UEFA|Champion[s]?\s+League|Premier\s+League|NBA|NFL)\b/i,

  // ── Pure channel/group rule/announcement messages ─────────────────────────
  /Please\s+read\s+and\s+review|Channel\s+&\s+Group\s+Rules/i,

  // ── Channel bot-name pattern: ALL-CAPS + numbers + release tag ───────────
  /^@?[A-Z][A-Za-z0-9_]{4,}(BOT|ZONE|STORE|DUMP|POINT|PLUS|PRO|WORLD|KING|GANG|CREW|HUB)\s*$/,

  // ── Channel "Hub" / "Zone" watermark lines ───────────────────────────────
  // e.g. "AAA Movies Hub", "Telugu Hits Zone", "HD Films World"
  /\b(?:[A-Z]{2,}\s+)?(?:Movies?|Films?|Series|Anime|Content)\s+(?:Hub|Zone|World|Store|Channel|Group|Point|Center|Archive)\s*$/i,

  // ── "Updates Channel", "Backup Channel", "Daily Updates" patterns ──────
  /^(?:Daily|Latest|New|Hot|Top|Fresh)\s+(?:Updates?|Movies?|Releases?)\s*$/i,
  // ── Junk patterns from account 2 "messy" channels ───────────────────────
  /^(?:Shared\s+By|Credits?\s+To|Ripped\s+By|Encoded?\s+By|Uploaded\s+By)\b/i,  // "Shared By - Kd Creation"
  /^Forwarded\s+from\b/i,                                              // "Forwarded from KD CREATION™"
  /^\d+\.\s*DDP\b|^\d+\.\s*AAC\b|^\d+\.\s*AC3\b|^\d+\.\s*DD\b/i,  // "1. DDP | 5.1 | 640 kb/s"
  /^\d+\.\s+\d+\s*\|\s*\d+\s*kb/i,                                   // "5.1 | 640 kb/s | Tamil"
  /^\d{3,4}x\d{3,4}\s*[~\-]\s*(HEVC|AVC|H\.?26[45])/i,             // "1920x1080 ~ HEVC"
  /^(?:Audio\s+Track|Video\s+Track)\s*:/i,                            // "Audio Track:"
  /^(?:TEL|HIN|TAM|MAL|KAN|ENG|BEN|PUN)[,\s]*(?:TEL|HIN|TAM|MAL|KAN|ENG|BEN|PUN|KOR|JPN)[,\s&|]*$/i, // standalone lang codes
  /^@[A-Za-z0-9_]+\s*-\s*\S+\.mkv/i,                                 // @MULTIVERSE_OFCL - filename.mkv (TG file upload)
];
function isJunkTitle(title) {
  if (!title || title.length < 2) return true;
  const c = stripEmojis(title).trim();
  if (!c || c.length < 2) return true;
  // Pure number check — but allow short numeric titles like "300", "9", "1917", "1408"
  // A valid numeric title is either:
  //   a) NOT in the 4-digit year range 1900-2099 (e.g. "300", "9", "10000")
  //   b) IN the year range BUT has more context (handled via numericFallback later)
  // A standalone 4-digit number in year range (1900-2099) = junk (it's a year, not a title)
  if (/^\d+$/.test(c)) {
    const n = parseInt(c, 10);
    if (n >= 1900 && n <= 2099) return true; // standalone year = junk
    return false; // "300", "9", etc. = valid numeric titles
  }
  if (/^@/.test(c)) return true;                             // Telegram @handle
  if (/^[,\s\-_.:|•►▶◆×#]+$/.test(c)) return true;    // punctuation only
  if (/^\d{4}\s*(&|and|ISO|\+|FHD|HFR|BRD|CBR)\b/i.test(c)) return true; // year + tech spec

  // Pure non-Latin (Indic/CJK) text = language list line, not a title
  if (!/[a-zA-Z0-9]/.test(c) && c.length > 3) return true;

  // Size-only string: "8 36 GB", "2.55 GB", "Size : 8.36GB"
  if (/^(size\s*:\s*)?\d+[\s.]*\d*\s*(GB|MB)$/i.test(c)) return true;

  // Colon-prefixed metadata label: "Audio Tracks : Telugu", "Video : H.265"
  const colonIdx = c.indexOf(':');
  if (colonIdx > 0 && colonIdx < 30) {
    const label = c.substring(0, colonIdx).trim().toLowerCase().replace(/\s+/g, ' ');
    const META_LABELS = [
      'audio tracks', 'audio track', 'audio', 'video', 'size', 'bitrate',
      'subtitle', 'sub', 'subs', 'source', 'language', 'languages', 'format',
      'note', 'release', 'quality', 'tracks', 'track', 'encoder', 'resolution',
      'codec', 'file', 'files', 'links', 'tg', 'ch', 'channel',
    ];
    if (META_LABELS.includes(label)) return true;
  }

  return JUNK_PATTERNS.some(re => re.test(c));
}


// ─── AUDIO TRACKS ────────────────────────────────────────────────────────────
function extractAudioTracks(text) {
  if (!text) return null;
  const found=new Set();
  // Match 'Audio Tracks:', 'Audios:', ' Audio:', ' Audios:' lines
  const p1=text.match(/(?:(?:AUDIO\s*TRACKS?)|(?:Audios?))\s*[:\-]\s*([^\n]+)/i);
  if (p1&&p1[1]&&!/kbps|kb\/s/.test(p1[1])) {
    // Split on , | & + and 'and'
    p1[1].split(/[,|&+]|\band\b/i).forEach(s=>detectAllLanguages(s.replace(/\(.*?\)/g,'').trim()).forEach(l=>found.add(l)));
  }
  const p2=text.match(/Audio\s*Tracks?[^\n]*\n([\s\S]+?)(?=\n\n|https?:\/\/|@|$)/i);
  if (p2&&p2[1]) {
    p2[1].split('\n').map(l=>l.trim()).filter(Boolean).forEach(line=>{
      line.split(/[|+,&]/).forEach(part=>detectAllLanguages(part.trim()).forEach(l=>found.add(l)));
    });
  }
  (text.match(/\[([A-Za-z]+(?:[-+\/][A-Za-z]+){1,})\]/g)||[]).forEach(b=>detectAllLanguages(b).forEach(l=>found.add(l)));
  // Also check 'TEL-TAM-HIN-MAL-KAN' style hyphenated language codes in filenames
  const hyphenLangs=text.match(/\b([A-Z]{2,3}(?:-[A-Z]{2,3}){2,})\b/g)||[];
  hyphenLangs.forEach(hl=>hl.split('-').forEach(code=>detectAllLanguages(code.trim()).forEach(l=>found.add(l))));
  if (found.size===0&&/\bDUAL\b/i.test(text)) found.add('Multi');
  if (!found.size) return null;
  const spec=Array.from(found).filter(l=>l!=='Multi');
  return spec.length?spec.join(', '):'Multi';
}

// ─── YEAR ────────────────────────────────────────────────────────────────────
// Priority 1: year inside brackets/parens → most explicit: (2023) or [2023]
// Priority 2a: LAST year in dot-separated filename (the release year, not title part)
//              e.g. "2018.Everyone.Is.A.Hero.2023.1080p" → 2023
// Priority 2b: year preceded by separator → Movie.Name.2023.1080p
// Priority 3: year at end of string before extension
// Priority 4: any year found (last resort)
function extractYear(sources) {
  // P1: bracketed year — most reliable signal in Telegram posts like "Title (2023)"
  for (const s of sources) {
    if (!s) continue;
    const m = s.match(/[\[({]\s*(19\d{2}|20[012]\d)\s*[\])}]/);
    if (m) return parseInt(m[1], 10);
  }
  // P2a: For dot-separated filenames, collect ALL separator-bounded years and
  //       return the LAST one BEFORE a quality/codec token.
  //       This handles: "2018.Everyone.2023.1080p" → 2023 (not 2018 which is the title)
  for (const s of sources) {
    if (!s) continue;
    if (!(/[._]/.test(s))) continue; // only applies to dot/underscore filenames
    const QUALITY_RE = /\b(2160p|1080p|720p|480p|360p|4[Kk]|UHD|WEB[-_.]?DL|WEBRip|HDRip|BluRay|BDRip|REMUX|HEVC|x265|x264|AVC|AV1|AMZN|NF|DSNP|ZEE5|SUNNXT|JIOHS|AHA|HMAX|HOTSTAR|CRKL|PCOK|DPLS)\b/i;
    const qualMatch = QUALITY_RE.exec(s);
    const searchIn = qualMatch ? s.substring(0, qualMatch.index) : s;
    // Find ALL years in the pre-quality section
    const allYears = [];
    const yearRE = /[._\-\s](19\d{2}|20[012]\d)[._\-\s]/g;
    let ym;
    while ((ym = yearRE.exec(searchIn)) !== null) {
      allYears.push(parseInt(ym[1], 10));
    }
    if (allYears.length > 0) {
      // If multiple years found (e.g. title starts with year + release year),
      // return the LAST year (the release year)
      return allYears[allYears.length - 1];
    }
  }
  // P2b: year embedded between dots/underscores/dashes — single year case
  for (const s of sources) {
    if (!s) continue;
    const m = s.match(/[._\-](19\d{2}|20[012]\d)[._\-\s]/);
    if (m) return parseInt(m[1], 10);
  }
  // P3: year at tail, just before file extension or end of string
  for (const s of sources) {
    if (!s) continue;
    const m = s.match(/(19\d{2}|20[012]\d)\s*(?:$|\.(?:mkv|mp4|avi|mov|ts|zip|rar))/i);
    if (m) return parseInt(m[1], 10);
  }
  // P4: first year anywhere (last resort — may grab year from title name like "2001")
  for (const s of sources) {
    if (!s) continue;
    const m = s.match(/\b(19\d{2}|20[012]\d)\b/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// ─── MASTER PARSER ───────────────────────────────────────────────────────────
function parseMessageBlock(rawText, messageId, msgDate) {
  if (!rawText||typeof rawText!=='string') return null;
  const emojiStripped=stripEmojis(rawText);

  // Normalize bare URLs
  const normalized=emojiStripped
    .replace(/^[A-Z0-9 _\-]{1,15}:\s*(https?:\/\/)/gim,'$1')
    .replace(/(?<![:/])\b(hubcloud\.(?:foo|lol|work|in|to|club|me|best|one)[^\/]*\/\S+)/gi,'https://$1')
    .replace(/(?<![:/])\b(gdflix\.(?:dev|to|one|link)\/\S+)/gi,'https://$1')
    .replace(/(?<![:/])\b(dtflix\.ink\/\S*)/gi,'https://$1')
    .replace(/(?<![:/])\b(filepress\.in\/\S+)/gi,'https://$1')
    .replace(/(?<![:/])\b(drivehub\.(?:dev|to|in)\/\S+)/gi,'https://$1');

  const lines=normalized.split('\n').map(l=>l.trim()).filter(l=>l.length>0);
  if (!lines.length) return null;

  const isUrl=l=>/^https?:\/\//i.test(l);
  const isTgLink=l=>/(?:^|\s)(?:https?:\/\/)?t\.me\/(joinchat|\+|[a-zA-Z])|telegram\.me/i.test(l);
  const isYtLink=l=>/youtube\.com|youtu\.be/i.test(l);
  const isPromo=l=>{
    const noFile=!/\.(mkv|mp4|zip|rar|avi)\b|\d{3,4}p|\d+(?:\.\d+)?\s*(?:GB|MB)|\b(S\d{2}E\d{2}|Season|Episode)\b/i.test(l);
    const hasPromo=/\b(join|subscribe|forward|copyright|dmca|click here|share this|our channel|follow us|backup channel)\b/i.test(l)||/\.t\.me(?:\/|$)/i.test(l)||/telegram\.me/i.test(l);
    return noFile&&hasPromo;
  };

  // ── Helper: is this line a real file descriptor? ──────────────────────────
  const isFileDesc=l=>{
    if (!l||isUrl(l)||isMetadataLine(l)||isPromo(l)||isTgLink(l)) return false;
    return (
      /\.(mkv|mp4|avi|zip|rar|m2ts|mov)\b/i.test(l)||
      /\b(2160p|1080p|720p|480p|360p|4[Kk]\b|UHD)\b/i.test(l)||
      /\b\d+(?:\.\d+)?\s*(?:GB|MB)\b/i.test(l)
    ) && l.length > 8;
  };

  // ── Helper: extract size from a 'Size :' or 'File Size:' line ─────────────
  const extractSizeFromMeta=l=>{
    const m=(l||'').match(/(\d+(?:\.\d+)?\s*(?:GB|MB))/i);
    return m?m[1].replace(/\s+/g,'').trim():'';
  };

  // ── Build URL+filename pairs ──────────────────────────────────────────────
  // Each 'pair' = { rawFilename, size, url, urlType }
  // Strategy: for each URL, look backwards to find the owning filename.
  //   Skip consecutive URLs going backwards (they belong to same slot).
  //   If a 'Size :' / 'File Size:' line is found, extract size and keep looking.
  //   Skip metadata/promo lines.
  //   Use first real file descriptor line as the filename.
  //   Also look forward: consecutive URLs after this one share the same filename slot.
  const pairs=[];
  const processedUrlIdx=new Set(); // avoid double-processing URLs in forward scan

  for (let i=0;i<lines.length;i++) {
    if (processedUrlIdx.has(i)) continue;
    const line=lines[i];
    if (!isUrl(line)||isTgLink(line)||isYtLink(line)) continue;
    const cls=classifyUrl(line);
    if (cls==='Ignore') continue;

    // Walk backwards past consecutive URLs to find the owning filename
    let fc=null, fsz='';
    let j=i-1;
    // Skip consecutive URLs / TgLinks going backwards
    while(j>=0&&(isUrl(lines[j])||isTgLink(lines[j])||isYtLink(lines[j]))) j--;
    // Check for Size: line between filename and URL
    if (j>=0&&/^(?:File\s*)?Size\s*[:\-]/i.test(lines[j])) {
      fsz=extractSizeFromMeta(lines[j]);
      j--;
    }
    // Skip metadata / promo
    while(j>=0&&(isMetadataLine(lines[j])||isPromo(lines[j]))) j--;
    // Grab file descriptor
    if (j>=0&&isFileDesc(lines[j])) {
      fc=lines[j];
      // Merge if previous line is quality-only prefix like '1080p HEVC'
      if (/^(\d{3,4}p|4k|uhd)/i.test(fc)&&j>0&&isFileDesc(lines[j-1])) fc=lines[j-1]+' '+fc;
      if (!fsz) fsz=extractSizeFromMeta(fc);
    }
    // Reject 'CLICK HERE', 'TELEGRAM FILES' as filenames
    if (fc&&/\b(click\s+here|telegram\s+files?|drive\s+links?|join|credits?)\b/i.test(fc)) fc=null;

    // Collect this URL + any immediately following consecutive URLs (same file slot)
    pairs.push({url:line, rawFilename:fc||'', size:fsz, urlType:cls});
    processedUrlIdx.add(i);
    let k=i+1;
    // URL-first format (Screenshot 2): URL on line N, filename on line N+1
    // If we found no filename looking backwards, check the NEXT non-blank line
    if (!fc && k < lines.length) {
      // Skip any consecutive URLs first
      let fwdIdx = k;
      while (fwdIdx < lines.length && isUrl(lines[fwdIdx])) fwdIdx++;
      if (fwdIdx < lines.length && isFileDesc(lines[fwdIdx])) {
        // Found a filename line AFTER the URL — this is URL-first format
        const fwdFc = lines[fwdIdx];
        pairs[pairs.length - 1].rawFilename = fwdFc;
        if (!pairs[pairs.length - 1].size) pairs[pairs.length - 1].size = extractSizeFromMeta(fwdFc);
      }
    }
    while(k<lines.length&&isUrl(lines[k])&&!isTgLink(lines[k])&&!isYtLink(lines[k])) {
      const cls2=classifyUrl(lines[k]);
      if (cls2!=='Ignore') {
        pairs.push({url:lines[k], rawFilename:fc||'', size:fsz, urlType:cls2});
        processedUrlIdx.add(k);
      }
      k++;
    }
  }
  if (!pairs.length) return null;

  // ── Extract master title — 5 strategies ──────────────────────────────────
  // Strategy 0: detect numbered-list batch format and warn
  // e.g. "1. Movie Title (2023)\nhttps://...\n2. Movie 2 (2022)\nhttps://..."
  const numberedListLines = lines.filter(l => /^\d+[\.)\-]\s+.{5,}/.test(l) && !isUrl(l));
  const _isBatchList = numberedListLines.length >= 2;
  // (caller can check parsed._isBatchList to re-split if needed)

  // Strategy 1: first line that is not URL / promo / metadata and has a meaningful clean title
  // Skip codec/quality-ONLY single-line titles (AV1, 4K, HEVC, etc.)
  // Also skip pure language-list lines, size lines, and channel-hub watermarks.
  const TECH_ONLY_RE = /^\s*(AV1|HEVC|AVC|4K|UHD|2160p|1080p|720p|480p|360p|HDR|HDR10|DV|HLG|SDR|4K\.\.\.+)\s*$/i;
  // Lines that are ONLY a language list (e.g. "Telugu | Tamil | Hindi" OR just "Telugu | Tamil")
  const LANG_ONLY_RE = /^(?:(?:Telugu|Tamil|Hindi|Malayalam|Kannada|Bengali|Marathi|English|Japanese|Korean|Chinese|Arabic|Turkish|Spanish|French|German|Punjabi|Odia|Gujarati|Urdu|Multi|Dual)[,|\s&+]+){1,}(?:Telugu|Tamil|Hindi|Malayalam|Kannada|Bengali|Marathi|English|Japanese|Korean|Chinese|Arabic|Turkish|Spanish|French|German|Punjabi|Odia|Gujarati|Urdu|Multi|Dual)\s*$/i;
  // Single language word on its own line (e.g. just "Telugu")
  const SINGLE_LANG_RE = /^(?:Telugu|Tamil|Hindi|Malayalam|Kannada|Bengali|Marathi|English|Japanese|Korean|Chinese|Arabic|Turkish|Spanish|French|German|Punjabi|Odia|Gujarati|Urdu|Multi|Dual)\s*$/i;
  // Lines that look like a pure quality/platform descriptor without a real title
  const META_ONLY_RE = /^\s*(?:\d{3,4}p|4K|UHD|HDR|WEB[-\s]?DL|WEBRip|BluRay|HEVC|x26[45])\b/i;
  let masterTitle='';
  for (const line of lines) {
    if (isUrl(line)||isPromo(line)||isMetadataLine(line)) continue;
    if (TECH_ONLY_RE.test(line)) continue;
    if (LANG_ONLY_RE.test(line)) continue;   // skip language combo lines
    if (SINGLE_LANG_RE.test(line)) continue; // skip lone language words
    if (META_ONLY_RE.test(line) && line.length < 40) continue; // skip short quality-only lines
    const c=cleanTitleForApi(line);
    if (c.length>=3&&!isJunkTitle(line)) { masterTitle=line; break; }
  }

  const firstFn=pairs[0]?.rawFilename||'';
  if (!masterTitle||isJunkTitle(masterTitle)||TECH_ONLY_RE.test(masterTitle)) {
    masterTitle=firstFn;
  } else if (firstFn) {
    const fnSeries=/\bs\d{1,2}e\d{1,3}\b|\bs\d{1,2}\b/i.test(firstFn);
    const ttSeries=/\bs\d{1,2}e\d{1,3}\b|\bs\d{1,2}\b/i.test(masterTitle);
    if (fnSeries&&!ttSeries) masterTitle=firstFn;
  }

  // Fallback: extract from streaming URL slug
  if (!masterTitle||isJunkTitle(masterTitle)||cleanTitleForApi(masterTitle).length<2) {
    for (const line of lines) {
      if (!isUrl(line)) continue;
      const slug=extractTitleFromStreamingUrl(line);
      if (slug&&slug.length>=3) { masterTitle=slug; break; }
    }
  }

  const fullText=lines.join(' ');
  const year=extractYear([masterTitle,firstFn,fullText]);
  const {season,episode}=extractSeasonEpisode(fullText);
  const contentType=detectContentType(fullText);
  const isSeries=contentType==='series'||contentType==='anime'||season!==null;

  // ────────────────────────────────────────────────────────────────
  // TITLE CLEAN: The golden rule of filename parsing:
  //   Everything BEFORE the first quality/resolution/codec/platform tag = the title.
  // ────────────────────────────────────────────────────────────────
  let cleanedTitle = masterTitle;

  // Step 1: Split at first tech token
  if (/[._]/.test(cleanedTitle)) {
    const spaced = cleanedTitle.replace(/[._]/g, ' ');
    const TECH_TOKEN_RE = /\b(2160p|1080p|720p|480p|360p|4K|UHD|WEB[-\s]?DL|WEBRip|BluRay|BDRip|HDRip|REMUX|HEVC|x265|x264|AV1|AVC|AMZN|NF|DSNP|ZEE5|SUNNXT|JIOHS|TK|SS|AHA|ARTL|HMAX|HOTSTAR|CRKL|PCOK|DPLS|DDPd?|AAC|DTS|FLAC|DD5|DD2|HDR|SDR|DV|HLG)\b/i;
    const techMatch = TECH_TOKEN_RE.exec(spaced);
    if (techMatch && techMatch.index > 3) {
      cleanedTitle = spaced.substring(0, techMatch.index);
    } else {
      cleanedTitle = spaced;
    }
  }

  // Step 2: Cut at year — only if the year is NOT part of the actual title name.
  // Safe to cut when preceded by space/dot/dash/underscore. NOT when preceded by a letter
  // (e.g. "2001: A Space Odyssey" — do NOT cut at 2001).
  if (year) {
    const yStr = String(year);
    const yi   = cleanedTitle.indexOf(yStr);
    if (yi > 3) {
      const charBefore = cleanedTitle[yi - 1] || '';
      // Only cut when preceded by a separator, not by a word character
      if (/[\s.\-_(]/.test(charBefore)) {
        const candidate = cleanedTitle.substring(0, yi).trim();
        // Protect numeric titles: if cutting at year would leave us empty
        // BUT the title STARTS with a 4-digit number that is NOT the release year,
        // keep the full string (e.g. "2012 2009" → title="2012", year=2009).
        if (candidate.length < 1) {
          const numericStart = cleanedTitle.match(/^(\d{1,4})(?:[\s._(\[|])/);
          if (numericStart) {
            const n = parseInt(numericStart[1], 10);
            if (n !== year) cleanedTitle = String(n); // e.g. "2012" the movie
            // else: year IS the title (standalone year) — leave cleanedTitle as-is
          }
        } else {
          cleanedTitle = candidate;
        }
      }
    }
  }

  // Step 3: Cut at S01/season tag
  // Apply O→0 normalization first (handles channels that write SO1, SO2 etc.)
  const cleanedForSTag = cleanedTitle.replace(/\bS([Oo])(\d)/gi, 'S0$2');
  const sTag = cleanedForSTag.match(/\bS\d{1,2}\b/i);
  if (sTag && sTag.index > 2) cleanedTitle = cleanedTitle.substring(0, sTag.index);

  cleanedTitle=cleanedTitle
    // ── Strip @channel handles and brand watermarks first ──────────────
    .replace(/^@[A-Za-z0-9_]+\s*/g, '')
    .replace(/^(?:Name|Title)\s*[:\-]\s*/i, '')
    .replace(/\s*(HOiCHOi|Hoichoi)\s*(RAW|Unlimited|Original)\s*[A-Za-z0-9]*\s*$/i, '')
    .replace(/\s*(JoyMaa|JanaSeksPyaar|PodMereUreJabo|RoserGolla|MosirJANA|LiCKW33D|PodMere[A-Za-z]+)\s*$/i, '')
    .replace(/\b(Benzmovies|NaMovies|Friday4KPopcorn|Malli4U\s*Official|Malli4UOfficial|SPiDEY|LRTX|DS4K|LiCKW33D)\b/gi, '')
    // Language words (must strip before other passes)
    .replace(/\b(telugu|tamil|hindi|malayalam|kannada|bengali|english|marathi|japanese|korean|chinese|arabic|turkish|spanish|french|german|punjabi|dual|multi)\b/gi,'')
    // Codecs — dot AND space variants
    .replace(/\bH[.\s]+26[45]\b/gi,'')
    .replace(/\bx26[45]\b/gi,'')
    // File extensions
    .replace(/\.(mkv|mp4|avi|mov|ts|m2ts|zip|rar)\b/gi,'')
    .replace(/\b(mkv|mp4|avi|m2ts)\b/gi,'')
    .replace(/\bS\d{1,2}\s*E\d{1,3}\b/gi,'').replace(/\bSeason\s*\d+\b/gi,'')
    .replace(/\bSeason\s*\d+\s*[-–to]+\s*\d+\b/gi,'')  // Strip season ranges: "Season 1-5"
    .replace(/\bS\d{1,2}\s*[-–]\s*S\d{1,2}\b/gi,'')    // Strip pack ranges: "S01-S04"
    .replace(/\bEpisode\s*\d+\b/gi,'').replace(/\bEp\s*\d+\b/gi,'')
    .replace(/\b(\d{1,2})x\d{2,3}\b/gi,'')
    .replace(/\b(2160p|1080p|720p|480p|360p|4[Kk]|UHD|WEB[-.]?DL|HDRip|BluRay|BDRip|WEBRip|HEVC|x265|x264|AVC|AV1|HDR|HDR10P|REMUX|REPACK|PROPER|SDR|HLG|DV)\b/gi,'')
    .replace(/\bH\s+26[45]\b/gi,'')
    .replace(/\b(IMAX|Remastered|Anniversary|Director.?s?\s*Cut|Extended\s*Cut|Special\s*Edition|Theatrical\s*Cut|Uncut|Unrated|Open\s*Matte|Hybrid|Fan\s*Edit|Edition)\b/gi,'')
    .replace(/\b(AMZN|NF|DSNP|ZEE5|SUN\s*NXT|SUNNXT|JIOHS|ETVWIN|AHA|ARTL|HMAX|SONY|HOTSTAR|APPLE|TVNZ|CRKL|PCOK|DPLS)\b/gi,'')
    .replace(/\b(DDP\d[._\s]\d|AAC\d[._\s]\d|DTS|DD[+P]?|AC3|TrueHD|Atmos|FLAC|MP3|DDP5|DD5|DD2)\b/gi,'')
    .replace(/\b(Rahul4K|JeRi|TK\s*\d+\s*\d+|ATV|ETV|DE3PM|DUDU|iP0|iP[12]|JHS|MSD4K|MKV4U|MKV4K|DHD|YTS|YIFY|RARBG|PSA|FGT|NTG|EVO|ION10|CMRG|FLUX|TEPES|SiGMA|ROCCaT|SPARKS|VEXT|ULTRAHDCLUB|SMURF|OFT|mkvcage|AGAT|MZABI|MRTRJ|MRN|TOMMY|GalaxyTV|Pahe|HONE|QxR)\b/gi,'')
    .replace(/\b(ManoramaMax|EtvWin|NaMovies|TamilBlasters|Isaimini|Kuttymovies|TamilRockers|Movierulz|HDHub4u|Filmyzilla|Cinemavilla|Tamilgun)\b/gi,'')
    .replace(/\b(AAC|DDP|DD|AC3|DTS)\s+\d\s+\d\b/gi,'')
    .replace(/\bH\s*26[45]\b/gi,'')
    .replace(/\b(mkv|mp4|avi|m2ts)\b/gi,'')
    .replace(/\bE\d{2,3}\b/gi,'')
    .replace(/\b(Combined|Complete|Pack|Collection|Boxset|Trilogy|4K\.REMUX|COMPLETE)\b/gi,'')
    .replace(/\.(mkv|mp4|avi|mov|ts|m2ts|zip|rar)\b/gi,'')
    .replace(/[\[\(][^\]\)]*[\]\)]/g,'').replace(/#[a-zA-Z0-9_]+/g,'')
    .replace(/[._\-]+/g,' ').replace(/\s+/g,' ')
    // ── Stray standalone digits left from season ranges like "1-5" → "5" ──────────
    // ── Generic release-group trailer (final pass) ─────────────────────────
    .replace(/\s+[A-Z][a-z]{1,3}[A-Z][a-zA-Z0-9]{2,14}$/, '')   // CamelCase: "TamilMV"
    .replace(/\s+[A-Z]{3,12}(?:\d+[Kk]?)?$/, '')                  // ALL-CAPS: "TEAMX"
    .replace(/[\(\[\-\u2013\u2014\s]+$/,'').trim();

  cleanedTitle=stripEmojis(cleanedTitle).trim();
  // Final guard: if cleaned title is empty or junk, but the rawTitle starts with a
  // pure-number that is NOT a 4-digit release year (like "300", "9", "1917"), use that number as title.
  // This handles movies whose entire title IS a number (300, 1917, 1408, etc.).
  let _usedNumericFallback = false;
  if (!cleanedTitle || cleanedTitle.length < 2 || isJunkTitle(cleanedTitle)) {
    const _numericM = (masterTitle || '').trim().match(/^(\d{1,4})(?:[\s._(\[|])/);
    if (_numericM) {
      const _n = parseInt(_numericM[1], 10);
      if (_n < 1900 || _n > 2099) {
        cleanedTitle = String(_n); _usedNumericFallback = true; // e.g. "300", "9"
      } else if (year && year !== _n) {
        cleanedTitle = String(_n); _usedNumericFallback = true; // e.g. "1917" (released 2019)
      }
    }
  }
  // Do NOT wipe a valid numeric-fallback title via isJunkTitle
  // Single-letter title fallback: movies titled with just one letter (e.g. "V" 2020 Telugu)
  if ((!cleanedTitle || cleanedTitle.length < 2) && year) {
    const _slM = (masterTitle || '').trim().match(/^([A-Z])(?:\s+\(|\s+\[|\.|\s+\d{4})/);
    if (_slM) { cleanedTitle = _slM[1]; _usedNumericFallback = true; }
  }
  if (!_usedNumericFallback && (!cleanedTitle || cleanedTitle.length < 1 || isJunkTitle(cleanedTitle))) {
    return null;
  }

  // Language detection — multi-source
  const audioLang=extractAudioTracks(emojiStripped);
  const inlineLang=detectLanguage(fullText);
  let language=audioLang||inlineLang||'';
  if (!language&&/\bDUAL\b/i.test(fullText)) language='Multi';
  const allLanguages=detectAllLanguages(fullText);

  // Build download slots
  const fileMap={};
  for (const pair of pairs) {
    const rawFn=pair.rawFilename||masterTitle;
    let quality=normalizeQuality(rawFn);
    let size=extractSize(rawFn);
    const hdr=detectHDR(rawFn);
    const codec=detectCodec(rawFn);

    if (!size&&rawFn!==masterTitle) size=extractSize(masterTitle);
    if (!size) size=extractSize(fullText);
    if (quality==='HD'&&rawFn!==masterTitle) { const mq=normalizeQuality(masterTitle); if(mq!=='HD') quality=mq; }
    if (quality==='HD') { const mq=normalizeQuality(fullText); if(mq!=='HD') quality=mq; }

    const fileLangs=detectAllLanguages(rawFn);
    const fileLang=fileLangs.length?(fileLangs.filter(l=>l!=='Multi').join(', ')||'Multi'):language;

    const {season:ds,episode:de}=extractSeasonEpisode(rawFn);
    const fs=ds??season, fe=de??episode;
    // Prefer size from inline filename; fall back to pair's extracted size
    if (!size&&pair.size) size=pair.size;
    const key=`${quality}__${size||'nosize'}__S${fs??''}E${fe??''}`;

    const audio = extractAudio(rawFn) || extractAudio(fullText) || null;
    if (!fileMap[key]) fileMap[key]={quality,size,hdr,codec,audio,filename:stripEmojis(rawFn).trim()||cleanedTitle,language:fileLang,season:fs,episode:fe,links:[]};
    if (!fileMap[key].links.find(l=>l.url===pair.url)) {
      fileMap[key].links.push({host:detectHost(pair.url),url:pair.url,isFast:/gdflix|hubcloud|gdlink/i.test(pair.url)});
    }
  }

  const downloads=Object.values(fileMap);
  if (!downloads.length) return null;

  const QO=['4K','1080p','720p','480p','360p','HD'];
  const bestQuality=QO.find(q=>downloads.some(d=>d.quality===q))||'HD';

  // ── Extract IMDB / TMDB IDs embedded in message text ──────────────────────
  // e.g. "tt1234567" in any line → imdbId
  // e.g. "tmdb:1234567" or "themoviedb.org/movie/1234567" → tmdbId
  let imdbId = null;
  let tmdbIdHint = null;
  for (const line of lines) {
    if (!imdbId) {
      const im = line.match(/\b(tt\d{7,10})\b/);
      if (im) imdbId = im[1];
    }
    if (!tmdbIdHint) {
      // e.g. "tmdb:12345" or "TMDB: 12345" or "themoviedb.org/movie/12345" or "themoviedb.org/tv/12345"
      const tm = line.match(/(?:tmdb[:\s#]+|themoviedb\.org\/(?:movie|tv)\/)([0-9]{3,9})/i);
      if (tm) tmdbIdHint = tm[1];
    }
    if (imdbId && tmdbIdHint) break;
  }

  return {title:cleanedTitle,rawTitle:masterTitle,year,language,languages:allLanguages,quality:bestQuality,contentType,isSeries,season,episode,downloads,messageId,date:msgDate||null,imdbId,tmdbIdHint,_isBatchList};
}

module.exports = {
  parseMessageBlock,classifyUrl,stripEmojis,cleanTitleForApi,normalizeQuality,
  extractSize,toMB,detectHost,detectLanguage,detectAllLanguages,detectContentType,
  extractSeasonEpisode,detectCodec,detectHDR,extractAudio,isJunkTitle,isMetadataLine,
  extractTitleFromStreamingUrl,
  parseManualInput,
};

// ─── MANUAL INPUT PARSER ────────────────────────────────────────────────────
// Parses a single raw filename/paste line into a structured entry.
// Returns { title, year, quality, size, codec, hdr, audio, language, season, episode, type }
function parseManualInput(line) {
  if (!line || !line.trim()) return null;
  const raw = line.trim();

  // Extract size  e.g. 1.2GB, 800MB, 1,200 MB
  const sizeMatch = raw.match(/(\d[\d,.]*\s*(?:GB|MB))/i);
  const size = sizeMatch ? sizeMatch[1].replace(/\s/g, '') : '';

  // Extract quality
  const quality = normalizeQuality(raw) || 'HD';

  // Extract codec, HDR, audio from filename
  const codec = detectCodec(raw) || 'Other';
  const hdr   = detectHDR(raw)   || null;
  const audio = extractAudio(raw) || null;

  // Extract season / episode
  const { season, episode } = extractSeasonEpisode(raw);

  // Extract language
  const language = detectAllLanguages(raw).filter(l => l !== 'Multi').join(', ') || '';

  // Extract year  (4-digit between 1900-2099, not part of resolution like 1080)
  const yearMatch = raw.match(/(?<!\d)(19\d{2}|20\d{2})(?!\d)/);
  const year = yearMatch ? parseInt(yearMatch[1]) : null;

  // Detect type from filename cues
  let type = 'movie';
  if (season != null || /\bS\d{1,2}\b|\bSeason\b|\bEpisode\b|\bE\d{2,}\b/i.test(raw)) type = 'series';
  if (/\banime\b/i.test(raw)) type = 'anime';

  // Strip all noise to get title
  let title = raw
    .replace(/(\d[\d,.]*\s*(?:GB|MB))/gi, '')     // size
    .replace(/\b(4K|UHD|2160p|1080p|720p|480p|360p|HD|SD)\b/gi, '')  // quality
    .replace(/\b(HEVC|H\.?265|x265|AVC|H\.?264|x264|AV1|VP9)\b/gi, '') // codec
    .replace(/\b(TRUEHD|DTS[-.\s]?HD|DTS[-.\s]?X|DTS|ATMOS|EAC3|AC3|AAC|FLAC|MP3|DD[P+]?)\b/gi, '') // audio
    .replace(/\b(HDR10\+?|DOLBY[\s.]?VISION|HLG|SDR|HDR)\b/gi, '') // hdr
    .replace(/S\d{1,2}E\d{1,3}|Season\s*\d+|Episode\s*\d+/gi, '') // season/ep
    .replace(/\[(.*?)\]|\{(.*?)\}|\((.*?)\)/g, '')  // bracketed tags
    .replace(/(?<!\d)(19\d{2}|20\d{2})(?!\d)/g, '') // year
    .replace(/[._\-]+/g, ' ')                        // dots/underscores
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Remove trailing noise words
  title = title.replace(/\s*(BluRay|WEB-?DL|WEBRip|DVDRip|HDTV|Blu-?Ray|Remux|Extended|Theatrical|Directors\.?Cut)\s*/gi, ' ').trim();
  title = cleanTitleForApi(title) || title;

  return { title, year, quality, size, codec, hdr, audio, language, season, episode, type, raw };
}
