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
  const s = String(str).toUpperCase();
  // Highest resolution first; avoid matching digits embedded in release-group names.
  if (/(?:4320P|7680X4320|(?<![A-Z0-9])8K\b)/.test(s)) return '8K';
  if (/(?:2160P|3840X2160|(?<![A-Z0-9])4K\b|\bUHD\b)/.test(s)) return '4K';
  if (/(?:1440P|2560X1440|(?<![A-Z0-9])2K\b|\bQHD\b)/.test(s)) return '1440p';
  if (/(?:1080P|1920X1080)/.test(s)) return '1080p';
  if (/(?:720P|1280X720)/.test(s)) return '720p';
  if (/(?:576P|720X576)/.test(s)) return '576p';
  if (/(?:540P|960X540)/.test(s)) return '540p';
  if (/(?:480P|854X480|720X480)/.test(s)) return '480p';
  if (/(?:360P|640X360)/.test(s)) return '360p';
  if (/(?:240P|426X240)/.test(s)) return '240p';
  if (/\b(?:SD|CAMRip)\b/.test(s)) return 'SD';
  return 'HD';
}

// ─── SIZE ────────────────────────────────────────────────────────────────────
function extractSize(str) {
  if (str == null) return '';
  const value = String(str).replace(/[\u00a0]/g, ' ');
  // Decimal/binary units, comma decimals, grouped thousands, and spaced
  // thousands (some Telegram captions use "1 200 MB").
  const match = value.match(/(?:^|[^\d])((?:\d{1,3}(?:[ ,]\d{3})+|\d+)(?:[.,]\d+)?)\s*(TB|GB|MB|KB|TiB|GiB|MiB|KiB)\b/i);
  if (!match) return '';
  let amount = match[1].replace(/\s/g, '');
  if (amount.includes(',')) {
    if (!amount.includes('.') && /,\d{1,2}$/.test(amount)) amount = amount.replace(',', '.');
    else amount = amount.replace(/,/g, '');
  }
  const unit = match[2].toUpperCase().replace(/IB$/, 'B');
  return amount + unit;
}

// ─── STREAMING URL// ─── STREAMING URL// ─── STREAMING URL → TITLE SLUG ──────────────────────────────────────────────
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

// Provider families are matched by their actual registrable host labels, not
// by a substring anywhere in the URL. This accepts new subdomains and TLD
// rotations without accidentally allowing "notgdflix.example.com".
const PROVIDER_FAMILIES = {
  gdflix: 'GDFlix', gdlink: 'GDFlix', gdtot: 'GDFlix',
  extralink: 'GDFlix', neolinks: 'GDFlix', gtlinks: 'GDFlix',
  hubcloud: 'HubCloud', drivehub: 'HubCloud',
  tmbcloud: 'TMBCloud',
};

function getProviderDomain(value) {
  try {
    const raw = String(value || '').trim();
    const hostname = (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      ? new URL(raw).hostname
      : raw.split(/[\/:?#]/, 1)[0]).toLowerCase().replace(/^www\./, '');
    const labels = hostname.split('.').filter(Boolean);
    if (labels.length < 2) return null;
    // Explicit regional suffixes only; don't trust lookalike domains.
    const compoundSuffixes = new Set([
      'co.in', 'com.in', 'net.in', 'co.uk', 'org.uk', 'com.au', 'net.au',
      'co.nz', 'com.sg', 'com.my', 'com.ph', 'com.pk', 'com.bd', 'com.ng',
      'co.za', 'com.br', 'com.mx', 'com.tr', 'com.tw', 'com.hk', 'co.id',
      'com.vn', 'co.kr',
    ]);
    const compound = compoundSuffixes.has(labels.slice(-2).join('.'));
    const brandIndex = labels.length - (compound ? 3 : 2);
    if (brandIndex < 0) return null;
    const brand = labels[brandIndex];
    const category = PROVIDER_FAMILIES[brand];
    if (!category) return null;
    return { brand, category, domain: labels.slice(brandIndex).join('.') };
  } catch (_) {
    return null;
  }
}

function isKnownProviderHost(value) {
  return !!getProviderDomain(value);
}

// Keep the repository's existing canonical domains stable. Only genuinely new
// TLD rotations fall back to a default host, while mirror subdomains collapse
// to the same root domain that older imports already used.
const KNOWN_PROVIDER_DOMAINS = new Set([
  'gdflix.dev', 'gdflix.to', 'gdflix.one', 'gdflix.link', 'gdflix.net',
  'gdflix.dad', 'gdflix.cfd', 'gdflix.io', 'gdlink.dev',
  'gdtot.dad', 'gdtot.one', 'gdtot.sbs', 'extralink.cfd',
  'neolinks.sbs', 'gtlinks.me',
  'hubcloud.foo', 'hubcloud.one', 'hubcloud.art', 'hubcloud.cx',
  'hubcloud.lol', 'hubcloud.bz', 'hubcloud.club', 'hubcloud.in',
  'hubcloud.to', 'hubcloud.work', 'hubcloud.zone', 'hubcloud.dev',
  'hubcloud.me', 'hubcloud.best',
  'drivehub.dev', 'drivehub.to', 'drivehub.in', 'drivehub.online',
  'tmbcloud.dev', 'tmbcloud.online', 'tmbcloud.lol',
]);

function normalizeGdflixUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    const provider = getProviderDomain(parsed.hostname);
    if (!provider) return value;
    if (KNOWN_PROVIDER_DOMAINS.has(provider.domain)) {
      parsed.hostname = provider.domain;
    } else if (provider.brand === 'gdflix' || provider.brand === 'gdlink') {
      parsed.hostname = 'gdflix.dev';
    } else if (provider.brand === 'hubcloud' || provider.brand === 'drivehub') {
      parsed.hostname = 'hubcloud.one';
    } else if (provider.brand === 'tmbcloud') {
      parsed.hostname = 'tmbcloud.dev';
    } else {
      parsed.hostname = provider.domain;
    }
    return parsed.toString();
  } catch (_) {
    return value;
  }
}
// ─── URL CLASSIFIER ──────────────────────────────────────────────────────────
const DIRECT_RE = [
  /gdflix\.(dev|to|one|link|net|dad|cfd|io)/i, /gdlink\.dev/i,
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
  if (/mediainfo|media\.info|mfinfo/i.test(url)) return 'Ignore';
  const provider = getProviderDomain(url);
  if (provider) return provider.category;
  if (PASTE_RE.some(r=>r.test(url)))     return 'Paste';
  if (SHORTLINK_RE.some(r=>r.test(url))) return 'Shortlink';
  if (/gdflix\.|gdlink\.dev|gdtot\./i.test(url))   return 'GDFlix';
  if (/hubcloud\.|drivehub\./i.test(url))           return 'HubCloud';
  if (/filepress\.|fpgo\.xyz/i.test(url))           return 'FilePress';
  if (/tmbcloud\./i.test(url))                      return 'TMBCloud';
  if (/drivenext\./i.test(url))                     return 'DriveNext';
  if (/dtflix\.ink|dotflix\.wtf/i.test(url))        return 'DTFlix';
  if (/extralink\.cfd|neolinks\.sbs|gtlinks\.me/i.test(url)) return 'GDFlix'; // GDFlix mirror links
  if (/filebee\.xyz/i.test(url))                    return 'FileBee';
  if (/streamtape\.(com|co)/i.test(url))            return 'StreamTape';
  if (/mixdrop\.(co|to|ag)/i.test(url))             return 'MixDrop';
  if (/dood\.(la|so|pm|to|watch|re)/i.test(url))   return 'DoodStream';
  if (/buzzheavier\.com/i.test(url))                return 'BuzzHeavier';
  if (/pixeldrain\.com\/u\//i.test(url))            return 'PixelDrain';
  if (/1fichier\.com/i.test(url))                   return '1Fichier';
  if (/files\.catbox\.moe/i.test(url))              return 'CatBox';
  if (DIRECT_RE.some(r=>r.test(url)))   return 'Direct';
  if (/\/(file|download|d|dl|f)\/[a-zA-Z0-9_\-]{4,}/i.test(url)) return 'Direct';
  if (/\.(mkv|mp4|avi|zip|rar|m2ts|ts|mov)(\?.*)?$/i.test(url))  return 'Direct';
  return 'Download';
}
function detectHost(url) {
  const c = classifyUrl(url);
  return (c==='Ignore'||c==='Paste'||c==='Download') ? 'Download' : c;
}

// Parse one explicitly numbered audio-track row. A generic DUAL/MULTI marker
// is deliberately not enough evidence to invent track details.
function parseExplicitAudioTrackLine(line) {
  const value = String(line || '').trim();
  const match = value.match(/^(?:AUDIO\s+)?TRACK\s*#?\s*(\d{1,2})\s*[:.)-]\s*(.+)$/i)
    || value.match(/^(?:#\s*)?(\d{1,2})\s*[-.)|:]\s*(.+)$/i);
  if (!match) return null;

  const payload = match[2].trim();
  const codec = extractAudio(payload);
  if (!codec) return null;

  const channels = detectAudioChannels(payload) || '';
  const languages = [...new Set((detectAllLanguages(payload) || []).filter(language => language && language !== 'Multi'))];
  // Codec alone is too weak: require an explicit channel layout or one language.
  if (!channels && languages.length !== 1) return null;
  return {
    codec,
    channels,
    language: languages.length === 1 ? languages[0] : '',
  };
}

function isAudioTrackSectionHeader(line) {
  return /^AUDIO\s+TRACKS?\b(?:\s*\(\s*\d+\s*\))?\s*[:=-]?\s*$/i.test(String(line || '').trim());
}

// ─── METADATA LINE DETECTOR ───────────────────────────────────────────────────
// Returns true for lines that are channel/format headers, NOT real title/filename lines
function isMetadataLine(line) {
  const metadataText = String(line || '').trim();
  if (/^(?:Runtime|Run\s*time|Duration|Length|Aspect\s*Ratio|Screen\s*Ratio|AR|CBFC|Censor(?:ship)?|Certificate|Certification|Format)(?:\s*[:=]\s*|\s+)\S/i.test(metadataText)) return true;
  const s = (line || '').trim();
  if (!s) return false;
  if (isAudioTrackSectionHeader(s) || parseExplicitAudioTrackLine(s)) return true;
  // Pure hashtag-only lines: '#NF_WEBDL #MULTI_AUDIO'
  if (/^(#[A-Za-z0-9_]+(?:\s+#[A-Za-z0-9_]+)*)\s*$/.test(s)) return true;
  // Mixed bullet+hashtag: '~.  #DUAL_AUDIO'
  if (/^[~\-•*._\s]+#[A-Za-z0-9_]+/i.test(s) && !/\.(mkv|mp4|avi|zip)\b/i.test(s)) return true;
  // Section headers: 'DRIVE LINKS:', 'TELEGRAM FILES:'
  if (/^(DRIVE\s+LINKS?|TELEGRAM\s+FILES?|HEVC\s*$|AVC\s*$)\s*[:#]?/i.test(s)) return true;
  // Runtime, aspect ratio and CBFC certification metadata lines
  if (/^(?:Run\s*time|Runtime|Duration|Length|Aspect\s*Ratio|Screen\s*Ratio|AR|CBFC(?:\s+Rating)?|Censor(?:ship)?|Certificate|Certification)\s*[:=]/i.test(s)) return true;
  // Size / File Size lines
  if (/^(?:File\s*)?Size\s*[:].*/i.test(s) && /\d/.test(s)) return true;
  // Quality metadata: 'Quality: 2160p DV HDR'
  if (/^Quality\s*:/i.test(s) && s.length < 80) return true;
  // Audio track detail lines
  if (/^(Audio\s*:|#?(Hindi|Tamil|Telugu|Malayalam|Kannada|Bengali|English)\s*:)/i.test(s)) return true;
  if (/^@\d+Kbps|@\d+\s*KB/i.test(s)) return true;
  // Subtitle/NOTE lines
  if (/^Subtitles?\s*:/i.test(s)) return true;
  if (/^NOTE[:\s-]/i.test(s) && s.length < 200) return true;
  // Named link labels (Telegram text_link entities: sit between filename and URL)
  if (/^(GDFLIX|HubCloud|FilePress|TMBCloud|DTFlix|DriveNext|FileBee|PixelDrain|StreamTape|MixDrop|DoodStream|BuzzHeavier|CatBox|1Fichier|mnmcloud)$/i.test(s)) return true;
  if (/^(Cloud\s+Link|index\s+Link|Drive\s+Link|Backup\s+Link|Direct\s+Link|Main\s+Link|Alt\.?\s+Link|Mirror\s+Link|Fast\s+Link)$/i.test(s)) return true;
  if (/^[\-\s]*(Download|Cloud|Drive|Backup|Mirror|Direct|Main|Alt)\s*[|\-\/]\s*(GDFLIX|HubCloud|FilePress|Drive|Cloud|Direct|Index)/i.test(s)) return true;
  // Expandable section headers
  if (/^(SHOTS?|MEDIAINFO|SCREENSHOTS?|SAMPLE|PREVIEW|TRAILER)\s*$/i.test(s)) return true;
  // Credit/ripped-by lines
  if (/^(Ripped\s+By|Encoded\s+By|Uploaded\s+By|Credits?\s+To|Source\s+Info)\s*[:\-]/i.test(s)) return true;
  if (/^@[A-Za-z0-9_]{3,}$/.test(s)) return true;
  // Click Here / Join etc.
  if (/^(CLICK\s+HERE|JOIN\s+NOW|CREDITS?\s*:?|SUBSCRIBE|BACKUP\s+CHANNEL)\s*$/i.test(s)) return true;
  // Quality-only format lines
  if (/^(DOLBY\s+VISION|SDR|HLG|HDR|AVC|HEVC)\b/i.test(s) && !/\.(mkv|mp4|avi|zip)\b/i.test(s) && s.length < 60) return true;
  return false;
}

// ─── LINK LABEL DETECTOR ─────────────────────────────────────────────────────
// Named link labels appear between filename and URL in Telegram text_link messages
function isLinkLabel(line) {
  const s = (line || '').trim();
  if (!s || s.length > 100) return false;
  if (/^(GDFLIX|HubCloud|FilePress|TMBCloud|DTFlix|DriveNext|FileBee|PixelDrain|StreamTape|MixDrop|DoodStream|BuzzHeavier|CatBox|1Fichier|mnmcloud)$/i.test(s)) return true;
  if (/^[\-\s]*(Download|Cloud|Drive|Backup|Mirror|Direct|Main|Alt)\s*[|\-\/]\s*\S+$/i.test(s)) return true;
  if (/^(Cloud|index|Drive|Backup|Mirror|Direct|Main|Alt|Fast|Slow)\s+(Link|Download|DL)$/i.test(s)) return true;
  if (/^(SHOTS?|MEDIAINFO|SCREENSHOTS?|SAMPLE|PREVIEW)$/i.test(s)) return true;
  return false;
}

// ─── LANGUAGE ────────────────────────────────────────────────────────────────
const LANG_MAP = [
  { name:'Telugu', re:/(?:\b|(?<=\W|^))(telugu|tel|tl|తెలుగు)(?:\b|(?=\W|$))/i },
  { name:'Tamil', re:/(?:\b|(?<=\W|^))(tamil|tam|tk|தமிழ்)(?:\b|(?=\W|$))/i },
  { name:'Hindi', re:/(?:\b|(?<=\W|^))(hindi|hin|हिन्दी|हिंदी)(?:\b|(?=\W|$))/i },
  { name:'Malayalam', re:/(?:\b|(?<=\W|^))(malayalam|mal|ml|മലയാളം)(?:\b|(?=\W|$))/i },
  { name:'Kannada', re:/(?:\b|(?<=\W|^))(kannada|kan|kn|ಕನ್ನಡ)(?:\b|(?=\W|$))/i },
  { name:'Bengali', re:/(?:\b|(?<=\W|^))(bengali|ben|bang|bn|বাংলা)(?:\b|(?=\W|$))/i },
  { name:'English', re:/(?:\b|(?<=\W|^))(english|eng)(?:\b|(?=\W|$))/i },
  { name:'Marathi', re:/(?:\b|(?<=\W|^))(marathi|mar|मराठी)(?:\b|(?=\W|$))/i },
  { name:'Punjabi', re:/(?:\b|(?<=\W|^))(punjabi|pun|pan|ਪੰਜਾਬੀ)(?:\b|(?=\W|$))/i },
  { name:'Japanese', re:/(?:\b|(?<=\W|^))(japanese|jpn|jap)(?:\b|(?=\W|$))/i },
  { name:'Korean', re:/(?:\b|(?<=\W|^))(korean|kor)(?:\b|(?=\W|$))/i },
  { name:'Chinese', re:/(?:\b|(?<=\W|^))(chinese|chi|zho|mandarin|cantonese)(?:\b|(?=\W|$))/i },
  { name:'Arabic', re:/(?:\b|(?<=\W|^))(arabic|ara|عربي|عربى)(?:\b|(?=\W|$))/i },
  { name:'Turkish', re:/(?:\b|(?<=\W|^))(turkish|tur)(?:\b|(?=\W|$))/i },
  { name:'Spanish', re:/(?:\b|(?<=\W|^))(spanish|spa)(?:\b|(?=\W|$))/i },
  { name:'French', re:/(?:\b|(?<=\W|^))(french|fre|fra)(?:\b|(?=\W|$))/i },
  { name:'German', re:/(?:\b|(?<=\W|^))(german|ger|deu)(?:\b|(?=\W|$))/i },
  { name:'Portuguese', re:/(?:\b|(?<=\W|^))(portuguese|por)(?:\b|(?=\W|$))/i },
  { name:'Russian', re:/(?:\b|(?<=\W|^))(russian|rus)(?:\b|(?=\W|$))/i },
  { name:'Italian', re:/(?:\b|(?<=\W|^))(italian|ita)(?:\b|(?=\W|$))/i },
  { name:'Dutch', re:/(?:\b|(?<=\W|^))(dutch|nld|dut)(?:\b|(?=\W|$))/i },
  { name:'Polish', re:/(?:\b|(?<=\W|^))(polish|pol)(?:\b|(?=\W|$))/i },
  { name:'Thai', re:/(?:\b|(?<=\W|^))(thai|tha)(?:\b|(?=\W|$))/i },
  { name:'Vietnamese', re:/(?:\b|(?<=\W|^))(vietnamese|vie)(?:\b|(?=\W|$))/i },
  { name:'Indonesian', re:/(?:\b|(?<=\W|^))(indonesian|ind|bahasa)(?:\b|(?=\W|$))/i },
  { name:'Malay', re:/(?:\b|(?<=\W|^))(malay|msa)(?:\b|(?=\W|$))/i },
  { name:'Filipino', re:/(?:\b|(?<=\W|^))(filipino|tagalog|tgl)(?:\b|(?=\W|$))/i },
  { name:'Persian', re:/(?:\b|(?<=\W|^))(persian|farsi|fas|per)(?:\b|(?=\W|$))/i },
  { name:'Hebrew', re:/(?:\b|(?<=\W|^))(hebrew|heb)(?:\b|(?=\W|$))/i },
  { name:'Greek', re:/(?:\b|(?<=\W|^))(greek|ell|gre)(?:\b|(?=\W|$))/i },
  { name:'Ukrainian', re:/(?:\b|(?<=\W|^))(ukrainian|ukr)(?:\b|(?=\W|$))/i },
  { name:'Urdu', re:/(?:\b|(?<=\W|^))(urdu|urd|اردو)(?:\b|(?=\W|$))/i },
  { name:'Nepali', re:/(?:\b|(?<=\W|^))(nepali|nep)(?:\b|(?=\W|$))/i },
  { name:'Sinhala', re:/(?:\b|(?<=\W|^))(sinhala|sin)(?:\b|(?=\W|$))/i },
  { name:'Gujarati', re:/(?:\b|(?<=\W|^))(gujarati|guj|ગુજરાતી)(?:\b|(?=\W|$))/i },
  { name:'Odia', re:/(?:\b|(?<=\W|^))(odia|oriya|ori|ଓଡ଼ିଆ)(?:\b|(?=\W|$))/i },
  { name:'Assamese', re:/(?:\b|(?<=\W|^))(assamese|asm|অসমীয়া)(?:\b|(?=\W|$))/i },
  { name:'Bhojpuri', re:/(?:\b|(?<=\W|^))(bhojpuri|bho)(?:\b|(?=\W|$))/i },
  { name:'Swedish', re:/(?:\b|(?<=\W|^))(swedish|swe)(?:\b|(?=\W|$))/i },
  { name:'Norwegian', re:/(?:\b|(?<=\W|^))(norwegian|nor)(?:\b|(?=\W|$))/i },
  { name:'Danish', re:/(?:\b|(?<=\W|^))(danish|dan)(?:\b|(?=\W|$))/i },
  { name:'Finnish', re:/(?:\b|(?<=\W|^))(finnish|fin)(?:\b|(?=\W|$))/i },
  { name:'Czech', re:/(?:\b|(?<=\W|^))(czech|ces|cze)(?:\b|(?=\W|$))/i },
  { name:'Hungarian', re:/(?:\b|(?<=\W|^))(hungarian|hun)(?:\b|(?=\W|$))/i },
  { name:'Romanian', re:/(?:\b|(?<=\W|^))(romanian|ron|rum)(?:\b|(?=\W|$))/i },
  { name:'Bulgarian', re:/(?:\b|(?<=\W|^))(bulgarian|bul)(?:\b|(?=\W|$))/i },
  { name:'Croatian', re:/(?:\b|(?<=\W|^))(croatian|hrv)(?:\b|(?=\W|$))/i },
  { name:'Serbian', re:/(?:\b|(?<=\W|^))(serbian|srp)(?:\b|(?=\W|$))/i },
  { name:'Swahili', re:/(?:\b|(?<=\W|^))(swahili|swa)(?:\b|(?=\W|$))/i },
  { name:'Multi', re:/(?:\b|(?<=\W|^))(multi(?:[.\-_]?audio)?|tri[.\-_]?audio)(?:\b|(?=\W|$))/i },
];
const CHAN_LANG = [
  {re:/telugu|tg4u|tollywood/i, lang:'Telugu'},
  {re:/tamil|kollywood/i,       lang:'Tamil'},
  {re:/hindi|bolly/i,           lang:'Hindi'},
  {re:/mallu|malayalam/i,       lang:'Malayalam'},
  {re:/kannada|sandalwood/i,    lang:'Kannada'},
  {re:/anime|manga|jpn/i,       lang:'Japanese'},
  {re:/korean|kdrama/i,         lang:'Korean'},
  {re:/spanish|espanol|latino/i, lang:'Spanish'},
  {re:/portuguese|brasileiro/i, lang:'Portuguese'},
  {re:/russian/i,               lang:'Russian'},
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


// Normalize language names before classifying the number of actual audio languages.
// "Multi"/"Dual" are labels, not languages; they never inflate the language count.
function normalizeLanguageList(values) {
  const raw = Array.isArray(values)
    ? values
    : String(values || '').split(/[,|+/&]|\band\b/i);
  const found = new Set();
  const specific = LANG_MAP.filter(entry => entry.name !== 'Multi');
  for (const value of raw) {
    const token = String(value || '').trim();
    if (!token) continue;
    for (const { name, re } of specific) {
      if (re.test(token)) found.add(name);
    }
  }
  return [...found];
}

function classifyLanguages(values, markerText = '') {
  const languages = normalizeLanguageList(values);
  const text = String(markerText || (Array.isArray(values) ? values.join(' ') : values) || '');
  const hasMultiMarker = /\b(?:multi(?:[.\s_-]?audio)?|tri[.\s_-]?audio)\b/i.test(text);
  const hasDualMarker = /\b(?:dual(?:[.\s_-]?audio)?|bilingual)\b/i.test(text);
  const languageType = hasMultiMarker || languages.length >= 3 ? 'Multi'
    : hasDualMarker || languages.length === 2 ? 'Dual'
    : languages.length === 1 ? 'Single' : '';
  return { languages, languageCount: languages.length, languageType };
}

function detectReleaseMetadata(text) {
  const value = String(text || '');
  const isRepack = /\b(?:RE[\s._-]?PACK|RE[\s._-]?RIP|RERIP)\b/i.test(value);
  const isProper = !isRepack && /\bPROPER\b/i.test(value);
  return {
    isRepack,
    releaseType: isRepack ? 'Repack' : isProper ? 'Proper' : 'Original',
  };
}

function extractAspectRatio(text) {
  const value = String(text || '');
  const ratio = '(?:1\\.(?:33|37|43|50|66|78|85|90)|2\\.(?:00|20|35|39|40|76)|16|4)\\s*:\\s*(?:1|9|3)';
  const labelled = value.match(new RegExp('(?:aspect[\\s._-]*ratio|screen[\\s._-]*ratio|\\bAR\\b)\\s*[:=\\-]?\\s*(' + ratio + ')', 'i'));
  const match = labelled || value.match(new RegExp('\\b(' + ratio + ')\\b', 'i'));
  return match ? match[1].replace(/\s+/g, '') : null;
}

function formatRuntimeMinutes(totalMinutes) {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return '';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? (minutes ? hours + 'h ' + minutes + 'm' : hours + 'h') : totalMinutes + ' min';
}

function extractRuntime(text) {
  const value = String(text || '');
  const labelled = value.match(/(?:runtime|run[\s._-]*time|duration|length)\s*[:=\-]?\s*([^\n|]{1,40})/i);
  if (!labelled) return { runtimeMinutes: null, duration: '' };
  const raw = labelled[1].trim();
  let minutes = null;
  let match = raw.match(/^(\d{1,2})\s*h(?:ours?|rs?)?\s*(?:(\d{1,2})\s*m(?:in(?:utes?)?)?)?/i);
  if (match) minutes = Number(match[1]) * 60 + Number(match[2] || 0);
  if (minutes == null) {
    match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (match) minutes = Number(match[1]) * 60 + Number(match[2]) + (match[3] ? Math.round(Number(match[3]) / 60) : 0);
  }
  if (minutes == null) {
    match = raw.match(/^(\d{2,3})\s*(?:m|min|mins|minutes)\b/i);
    if (match) minutes = Number(match[1]);
  }
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1000) {
    return { runtimeMinutes: null, duration: '' };
  }
  return { runtimeMinutes: minutes, duration: formatRuntimeMinutes(minutes) };
}

function extractCertification(text) {
  const value = String(text || '');
  const match = value.match(/(?:CBFC(?:\s+Rating)?|CENSOR(?:SHIP)?|CERT(?:IFICATE|IFICATION)?|CERT\.)\s*[:=\-]?\s*(U\s*[\/.-]?\s*A|U\.?A\.?|U|A|S)(?:\s*[-( ]?\s*(7|13|16)\s*\+?\)?)?/i);
  if (!match) return null;
  const base = /^U\s*[\/.-]?\s*A$/i.test(match[1]) || /^U\.?A\.?$/i.test(match[1])
    ? 'U/A' : match[1].toUpperCase();
  return base + (match[2] ? ' ' + match[2] + '+' : '');
}

function extractMediaMetadata(text) {
  const value = String(text || '');
  const release = detectReleaseMetadata(value);
  const runtime = extractRuntime(value);
  return {
    ...release,
    isIMAX: /\bIMAX\b/i.test(value),
    aspectRatio: extractAspectRatio(value),
    runtimeMinutes: runtime.runtimeMinutes,
    duration: runtime.duration,
    certification: extractCertification(value),
  };
}

// ─── Platform/release-group → language inference ────────────────────────────
// Infers language from known OTT platform names and release group tags
// embedded in filenames where no explicit language word is present.
function inferLanguageFromPlatform(text) {
  if (!text) return '';
  // Telugu OTTs and release groups
  // Telugu OTT platforms (source) + Telugu rip/release groups
  // SUNNXT  = Sun NXT (Telugu/Tamil OTT platform)
  // NaMovies, Benzmovies, TeluguDrives, MoviesWorld, Malli4U = Telugu rip groups
  if (/\b(SUNNXT|SUN\s*NXT|NaMovies|Benzmovies|TeluguDrives|MoviesWorld|Malli4U)\b/i.test(text)) return 'Telugu';
  // Tamil rip groups + OTTs
  if (/\b(TamilBlasters|Isaimini|Kuttymovies|TamilRockers|Movierulz|Tamilgun|Cinemavilla|Tamilyogi)\b/i.test(text)) return 'Tamil';
  // Malayalam OTT platforms
  if (/\b(ManoramaMAX|ManoramaMax|EtvWin)\b/i.test(text)) return 'Malayalam';
  return '';
}

function detectLanguage(str) {
  const langs = detectAllLanguages(str);
  if (!langs.length) return '';
  const spec = langs.filter(l=>l!=='Multi');
  return spec.length ? spec.join(', ') : 'Multi';
}

// ─── CODEC ───────────────────────────────────────────────────────────────────
function detectCodec(fn) {
  const s = String(fn || '').toUpperCase();
  if (/(?:\bAV1\b|AOMEDIA VIDEO 1)/.test(s)) return 'AV1';
  if (/(?:\bVP9\b|V\.P9)/.test(s)) return 'VP9';
  if (/(?:\bVP8\b|V\.P8)/.test(s)) return 'VP8';
  if (/(?:HEVC|H[ ._-]?265|X265|\bH265\b)/.test(s)) return 'HEVC';
  if (/(?:\bAVC\b|H[ ._-]?264|X264|\bH264\b)/.test(s)) return 'H.264';
  if (/(?:MPEG[ ._-]?2|\bMPG2\b)/.test(s)) return 'MPEG-2';
  if (/(?:MPEG[ ._-]?4|\bMP4V\b)/.test(s)) return 'MPEG-4';
  if (/\bXVID\b/.test(s)) return 'Xvid';
  if (/\bDIVX\b/.test(s)) return 'DivX';
  if (/\bPRORES(?:\s?(?:422|4444)(?:\s?HQ)?)?\b/.test(s)) return 'ProRes';
  if (/\bTHEORA\b/.test(s)) return 'Theora';
  if (/(?:\bVC[ ._-]?1\b|WMV3)/.test(s)) return 'VC-1';
  return 'Other';
}

// ─── CONTAINER / FILE FORMAT ─────────────────────────────────────────────────
function detectContainer(filename) {
  const s = String(filename || '').toUpperCase();
  const ext = s.match(/\.(MKV|MP4|M4V|WEBM|AVI|MOV|M4P|MPEG|MPG|TS|M2TS|WMV|FLV|OGV|3GP)(?:$|[?#\s])/);
  if (ext) {
    const formats = { M4V: 'MP4', M4P: 'MP4', MPG: 'MPEG', M2TS: 'M2TS' };
    return formats[ext[1]] || ext[1];
  }
  if (/\bMATROSKA\b/.test(s)) return 'MKV';
  if (/\bWEBM\b/.test(s)) return 'WEBM';
  return null;
}

// ─── HDR ─────────────────────────────────────────────────────────────────────
function detectBitDepth(fn) {
  const s = String(fn || '').toUpperCase();
  const m = s.match(/(?:\b(8|10|12|14|16)\s*[- ]?BIT\b|\b(8|10|12|14|16)BIT\b)/);
  return m ? `${m[1] || m[2]}-bit` : null;
}

function detectAudioChannels(fn) {
  const s = String(fn || '').toUpperCase();
  // Check immersive layouts before shorter prefixes (e.g. 5.1.2 before 5.1).
  const m = s.match(/(?<!\d)(11\.1\.8|9\.1\.8|9\.1\.6|9\.1\.4|7\.2\.4|7\.2\.2|7\.1\.8|7\.1\.6|7\.1\.4|7\.1\.2|5\.2\.4|5\.1\.6|5\.1\.4|5\.1\.2|3\.1\.2|7\.2|5\.2|7\.1|6\.1|5\.1|4\.1|4\.0|3\.1|3\.0|2\.1|2\.0|1\.0)(?!\d)/);
  if (m) return m[1];
  if (/\b(?:STEREO|2CH)\b/.test(s)) return '2.0';
  if (/\b(?:MONO|1CH)\b/.test(s)) return '1.0';
  return null;
}

function detectHDR(fn) {
  const s=(fn||'').toUpperCase();
  if (/DOLBY\s*VISION|\bDOVI\b|\.DV\.|\bDV\b/.test(s)) return 'Dolby Vision';
  if (/HDR10\+|HDR10P/.test(s))               return 'HDR10+';
  if (/HDR10/.test(s))                         return 'HDR10';
  if (/\bHDR\b/.test(s))                       return 'HDR';
  if (/HLG/.test(s))                           return 'HLG';
  if (/\bSDR\b/.test(s))                       return 'SDR';
  return null;
}

// ─── SOURCE ───────────────────────────────────────────────────────────────────
function detectSource(fn) {
  const s = String(fn || '').toUpperCase();
  // Most specific disc/source labels must win when multiple tags are present.
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
  return null;
}

// ─── AUDIO ───────────────────────────────────────────────────────────────────
// Detects audio codec/format from a filename or message text.
// Returns a short label string or null.
function extractAudio(fn) {
  const s = String(fn || '').toUpperCase();
  const hasAtmos = /DOLBY[\s._-]*ATMOS|\bATMOS\b/.test(s);
  let codec = null;

  // Match the most specific names first so family labels do not hide subtypes.
  if (/TRUEHD/.test(s)) codec = 'TrueHD';
  else if (/DTS[.\s_-]?X\b/.test(s)) codec = 'DTS:X';
  else if (/DTS[.\s_-]?HD[.\s_-]?(?:MA|MASTER[.\s_-]*AUDIO)\b/.test(s)) codec = 'DTS-HD MA';
  else if (/DTS[.\s_-]?HD[.\s_-]?(?:HRA|HR|HIGH[.\s_-]*RESOLUTION[.\s_-]*AUDIO)\b/.test(s)) codec = 'DTS-HD HRA';
  else if (/DTS[.\s_-]?HD\b/.test(s)) codec = 'DTS-HD';
  else if (/DTS[.\s_-]?ES\b/.test(s)) codec = 'DTS-ES';
  else if (/DTS[.\s_-]?96[./\s_-]?24\b/.test(s)) codec = 'DTS 96/24';
  else if (/DTS[.\s_-]?EXPRESS\b/.test(s)) codec = 'DTS Express';
  else if (/DOLBY[.\s_-]*DIGITAL[.\s_-]*EX|\bDD[.\s_-]*EX\b/.test(s)) codec = 'DD-EX';
  else if (/E[.\s_-]?AC[.\s_-]?3[.\s_-]*JOC\b|\bDDP[.\s_-]*JOC\b|DOLBY[.\s_-]*DIGITAL[.\s_-]*PLUS[.\s_-]*JOC/.test(s)) codec = 'EAC3 JOC';
  else if (/E[.\s_-]?AC[.\s_-]?3|\bDDP(?:\+|\d+(?:\.\d+)?)?|\bDD\+|DOLBY[.\s_-]*DIGITAL[.\s_-]*PLUS/.test(s)) codec = 'EAC3';
  else if (/\bAC[.\s_-]?3\b|\bDD(?=\d|[.\s_-]|$)|\bDOLBY[.\s_-]*DIGITAL\b/.test(s)) codec = 'DD';
  else if (/\bAC[.\s_-]?4\b/.test(s)) codec = 'AC4';
  else if (/\bMPEG[.\s_-]*H(?:\s*3D)?\b/.test(s)) codec = 'MPEG-H';
  else if (/\bAURO[.\s_-]?3D\b/.test(s)) codec = 'Auro-3D';
  else if (/\bHE[.\s_-]?AAC(?:[.\s_-]?V?2)?\b|\bHEAAC(?:V?2)?\b/.test(s)) codec = /V?2\b/.test(s) ? 'HE-AAC v2' : 'HE-AAC';
  else if (/\bAAC[.\s_-]?LC\b/.test(s)) codec = 'AAC-LC';
  else if (/\bAAC\b/.test(s)) codec = 'AAC';
  else if (/\bFLAC\b/.test(s)) codec = 'FLAC';
  else if (/\bOPUS\b/.test(s)) codec = 'Opus';
  else if (/\bALAC\b/.test(s)) codec = 'ALAC';
  else if (/\bLPCM\b/.test(s)) codec = 'LPCM';
  else if (/\bPCM\b/.test(s)) codec = 'PCM';
  else if (/\bVORBIS\b/.test(s)) codec = 'Vorbis';
  else if (/\bMP3\b|MPEG[.\s_-]*1[.\s_-]*LAYER[.\s_-]*III|MPEG[.\s_-]*AUDIO[.\s_-]*LAYER[.\s_-]*3/.test(s)) codec = 'MP3';
  else if (/\bMP2\b|MPEG[.\s_-]*1[.\s_-]*LAYER[.\s_-]*II|MPEG[.\s_-]*AUDIO[.\s_-]*LAYER[.\s_-]*2/.test(s)) codec = 'MP2';
  else if (/\bMLP\b/.test(s)) codec = 'MLP';
  else if (/\bWMA[.\s_-]*LOSSLESS\b/.test(s)) codec = 'WMA Lossless';
  else if (/\bWMA[.\s_-]*PRO\b/.test(s)) codec = 'WMA Pro';
  else if (/\bWMA\b/.test(s)) codec = 'WMA';
  else if (/\bATRAC(?:3(?:PLUS)?|ADVANCED[.\s_-]*LOSSLESS)?\b/.test(s)) codec = 'ATRAC';
  else if (/\bDRA\b/.test(s)) codec = 'DRA';
  else if (/\bREALAUDIO\b|\bREAL[.\s_-]*AUDIO\b/.test(s)) codec = 'RealAudio';
  else if (/\bSPEEX\b/.test(s)) codec = 'Speex';
  else if (/\bAMR[.\s_-]*(?:WB|NB)\b/.test(s)) codec = s.match(/\bAMR[.\s_-]*(?:WB|NB)\b/)[0].replace(/[.\s_-]+/g, '-');

  if (hasAtmos) return codec ? codec + ' Atmos' : 'Atmos';
  return codec;
}

// ─── SIZE → MB ───────────────────────────────────────────────────────────────
// Converts a size string like "1.5 GB" or "800MB" to a float in MB.
function toMB(s) {
  if (!s) return 0;
  const match = String(s).trim().match(/([\d,.]+)\s*(TB|GB|MB|KB)\b/i);
  if (!match) return parseFloat(s) || 0;
  let amount = match[1];
  if (amount.includes(',')) {
    if (!amount.includes('.') && /,\d{1,2}$/.test(amount)) amount = amount.replace(',', '.');
    else amount = amount.replace(/,/g, '');
  }
  const factors = { TB: 1024 * 1024, GB: 1024, MB: 1, KB: 1 / 1024 };
  return Number(amount) * factors[match[2].toUpperCase()];
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
    const TECH_TOKEN_RE = /\b(4320p|2160p|1440p|1080p|720p|576p|540p|480p|360p|240p|4K|UHD|WEB[-\s]?DL|WEBRip|BluRay|BDRip|HDRip|REMUX|HEVC|x265|x264|VP9|VP8|MPEG[ ._-]?[24]|Xvid|DivX|ProRes|Theora|VC[ ._-]?1|AV1|VP9|VP8|AVC|DVDRip|DVDScr|DVDBD|DVD5|DVD9|\bDVD\b|AMZN|NF|DSNP|ZEE5|SUNNXT|JIOHS|TK|SS|AHA|ARTL|HMAX|HOTSTAR|CRKL|PCOK|DPLS|DDPd?|AAC|DTS|FLAC|DD5|DD2|HDR|SDR|DV|HLG)\b/i;
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
    .replace(/\b(4320p|2160p|1440p|1080p|720p|576p|540p|480p|360p|240p|4[Kk]|UHD|WEB[\s._-]*DL|WEB[\s._-]*RIP|HDRip|HDTV|BluRay|BD[\s._-]*Rip|WEBRip|HEVC|x265|x264|VP9|VP8|MPEG[ ._-]?[24]|Xvid|DivX|ProRes|Theora|VC[ ._-]?1|H\.265|H\.264|H[\s._-]*265|H[\s._-]*264|MPEG[\s._-]?[24]|AVC|HDR|HDR10P|DV|Remux|HLG|SDR|AV1|FLAC|AAC|DDP|DTS|Atmos|DD5|DD2|DVD[\s._-]*Rip|DVD[\s._-]*Scr|DVDBD|DVD5|DVD9|\bDVD\b)\b/gi,'')
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

// Generic leftovers from Telegram headings should never outrank a descriptive
// filename. Keep this separate from isJunkTitle so catalogue titles containing
// these words (for example "The Movie") remain valid.
function isGenericTitleCandidate(value) {
  return /^(?:movie|film|video|clip|show|series|episode|season|trailer|teaser|sample|test|unknown|untitled|hd|fhd|uhd|4k|8k|1080p|720p|480p)$/i
    .test(stripEmojis(String(value || '')).trim());
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
    const QUALITY_RE = /\b(4320p|2160p|1440p|1080p|720p|576p|540p|480p|360p|240p|4[Kk]|UHD|WEB[-_.]?DL|WEBRip|HDRip|BluRay|BDRip|REMUX|HEVC|x265|x264|VP9|VP8|MPEG[ ._-]?[24]|Xvid|DivX|ProRes|Theora|VC[ ._-]?1|AVC|AV1|VP9|VP8|AMZN|NF|DSNP|ZEE5|SUNNXT|JIOHS|AHA|HMAX|HOTSTAR|CRKL|PCOK|DPLS)\b/i;
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

function extractYearCandidates(sources) {
  const years = [];
  for (const source of sources || []) {
    const year = extractYear([source]);
    if (year && !years.includes(year)) years.push(year);
  }
  return years;
}

// ─── MASTER PARSER ───────────────────────────────────────────────────────────
function parseMessageBlock(rawText, messageId, msgDate) {
  if (!rawText||typeof rawText!=='string') return null;
  const emojiStripped=stripEmojis(rawText);

  // Normalize bare URLs
  const normalized=emojiStripped
    .replace(/^[A-Z0-9 _\-]{1,15}:\s*(https?:\/\/)/gim,'$1')
    // Telegram exports often omit schemes; provider subdomains and TLDs rotate.
    .replace(
      /(?<![A-Z0-9/:@.-])((?:[A-Z0-9-]+\.)*(?:gdflix|gdlink|gdtot|extralink|neolinks|gtlinks|hubcloud|drivehub|tmbcloud)\.[A-Z]{2,}(?:\.[A-Z]{2,})?)(?::\d+)?(\/[^\s<>"']*)?/gi,
      (match, host, path = '') => 'https://' + host + path
    )
    .replace(/(?<![:/])\b(dtflix\.ink\/\S*)/gi,'https://$1')
    .replace(/(?<![:/])\b(filepress\.in\/\S+)/gi,'https://$1');

  // Expand inline markdown hyperlinks  // Expand inline markdown hyperlinks: [Label](URL) → URL (discard host-name labels)
  // Telegram sends hyperlinks in this format when exported/forwarded.
  // If label is a known download host (GDFlix, HubCloud…) → discard label, keep URL only.
  // If label looks like a real title/filename → keep label, then URL on next line.
  const HOST_LABEL_RE = /^(GDFlix|HubCloud|GDLink|TeraBox|GoFile|PixelDrain|Google\s*Drive|1Fichier|FilePress|StreamTape|Download|Link\s*\d*|Mirror\s*\d*|Server\s*\d*|Click\s*Here|Direct\s*Link|Backup\s*Link|CDN\s*\d*)$/i;
  const expandedLines = [];
  for (const rawLine of normalized.split('\n').map(l => l.trim()).filter(l => l.length > 0)) {
    const hyperlinkRe = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
    let hadLink = false;
    // Collect all hyperlinks in this line + any surrounding text
    let pos = 0, parts = [];
    let m;
    const re2 = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
    while ((m = re2.exec(rawLine)) !== null) {
      hadLink = true;
      const before = rawLine.slice(pos, m.index).trim();
      if (before) parts.push({ type: 'text', val: before });
      const label = m[1].trim();
      const url   = m[2].trim();
      if (!HOST_LABEL_RE.test(label)) parts.push({ type: 'text', val: label });
      parts.push({ type: 'url', val: url });
      pos = m.index + m[0].length;
    }
    const after = rawLine.slice(pos).trim();
    if (after) parts.push({ type: 'text', val: after });

    if (hadLink) {
      for (const p of parts) expandedLines.push(p.val);
    } else {
      expandedLines.push(rawLine);
    }
  }
  const lines = expandedLines;
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
    if (!l||isUrl(l)||isMetadataLine(l)||isPromo(l)||isTgLink(l)||isLinkLabel(l)) return false;
    const _fl = l.trim();
    return (
      /\.(mkv|mp4|avi|zip|rar|m2ts|mov)\b/i.test(_fl)||
      /\b(4320p|2160p|1440p|1080p|720p|576p|540p|480p|360p|240p|4[Kk]\b|UHD)\b/i.test(_fl)||
      /\b\d+(?:\.\d+)?\s*(?:GB|MB)\b/i.test(_fl)
    ) && _fl.length > 3;
  };

  // Collect track rows tightly associated with this file only. Stop at the
  // nearest title/file boundary so one variant cannot inherit another's audio.
  const collectAudioTracksForPair = (filenameIndex, urlIndex) => {
    const anchorIndex = filenameIndex >= 0 ? filenameIndex : urlIndex;
    if (anchorIndex < 0) return [];
    const found = [];

    // Audio-track rows may appear immediately before the filename.
    for (let scan = anchorIndex - 1, steps = 0; scan >= 0 && steps < 12; scan--, steps++) {
      const line = String(lines[scan] || '').trim();
      const track = parseExplicitAudioTrackLine(line);
      if (track) { found.unshift(track); continue; }
      if (isAudioTrackSectionHeader(line) || isMetadataLine(line)) continue;
      break;
    }

    // Or immediately after the filename and before its download link.
    if (filenameIndex >= 0 && urlIndex > filenameIndex) {
      for (let scan = filenameIndex + 1; scan < urlIndex; scan++) {
        const line = String(lines[scan] || '').trim();
        const track = parseExplicitAudioTrackLine(line);
        if (track) { found.push(track); continue; }
        if (isAudioTrackSectionHeader(line) || isMetadataLine(line) || isSizeLine(line)) continue;
        if (isUrl(line) || isLinkLabel(line)) continue;
        if (isFileDesc(line)) break;
        break;
      }
    }

    const unique = [];
    const seen = new Set();
    for (const track of found) {
      const key = [track.codec, track.channels, track.language].join('|').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(track);
    }
    // Store multiple audio only when at least two distinct explicit tracks matched.
    return unique.length >= 2 ? unique.slice(0, 8) : [];
  };

  // ── Helper: extract size from a 'Size :' or 'File Size:' line ─────────────
  const extractSizeFromMeta = l => extractSize(l || '');
  const isSizeLine = line => {
    const value = String(line || '').trim();
    if (/^(?:File\s*)?Size\s*[:=\-]/i.test(value)) return true;
    if (!extractSize(value)) return false;
    return /^[\s\[\](){}|,:;=\-]*(?:File\s*)?(?:Size\s*[:=\-]?\s*)?\d[\d.,\s]*\s*(?:TB|GB|MB|KB|TiB|GiB|MiB|KiB)[\s\[\](){}|,:;=\-]*$/i.test(value);
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
  const consumedSizeLineIdx=new Set(); // post-URL sizes belong to the preceding file

  for (let i=0;i<lines.length;i++) {
    if (processedUrlIdx.has(i)) continue;
    const line=lines[i];
    if (!isUrl(line)||isTgLink(line)||isYtLink(line)) continue;
    const cls=classifyUrl(line);
    if (cls==='Ignore') continue;

    // Walk backwards past consecutive URLs / link labels to find the owning filename
    let fc=null, fsz='';
    let j=i-1;
    // Skip consecutive URLs / Telegram links / named labels going backwards.
    while(j>=0&&(isUrl(lines[j])||isTgLink(lines[j])||isYtLink(lines[j])||isLinkLabel(lines[j]))) j--;

    // Search a bounded context window. Size labels and descriptive metadata
    // often sit between the filename and its download URL.
    const scanStart = Math.max(0, j - 14);
    for (let scan=j; scan>=scanStart; scan--) {
      const candidate = lines[scan];
      if (!fsz && isSizeLine(candidate) && !consumedSizeLineIdx.has(scan)) fsz = extractSizeFromMeta(candidate);
      // A standalone size line also satisfies the broad "file descriptor"
      // heuristic (because it contains GB/MB); never let it replace filename.
      if (isSizeLine(candidate)) continue;
      if (isMetadataLine(candidate) || isPromo(candidate) || isLinkLabel(candidate)) continue;
      if (isFileDesc(candidate)) {
        fc = candidate;
        if (!fsz) fsz = extractSize(candidate);
        if (/^(\d{3,4}p|4k|uhd)/i.test(fc) && scan > 0 && isFileDesc(lines[scan - 1])) {
          fc = lines[scan - 1] + ' ' + fc;
          if (!fsz) fsz = extractSize(fc);
        }
        break;
      }
      // Do not wander across a previous title/file block.
      if (scan !== j) break;
    }

    // Sizes may also be placed after the filename and before the URL.
    if (fc && !fsz) {
      const fnLineIdx = lines.lastIndexOf(fc, i - 1);
      if (fnLineIdx >= 0) {
        // Some channels place the size label just before the filename.
        for (let scan=fnLineIdx - 1; scan >= Math.max(0, fnLineIdx - 8); scan--) {
          if (isUrl(lines[scan]) || isFileDesc(lines[scan])) break;
          if (consumedSizeLineIdx.has(scan)) continue;
          if (isSizeLine(lines[scan])) { fsz = extractSizeFromMeta(lines[scan]); if (fsz) break; }
          if (!isMetadataLine(lines[scan])) break;
        }
        // Other channels place it after the filename and before the URL.
        if (!fsz) {
          for (let scan=fnLineIdx + 1; scan < i; scan++) {
            if (isUrl(lines[scan])) break;
            if (consumedSizeLineIdx.has(scan)) continue;
            if (isSizeLine(lines[scan])) { fsz = extractSizeFromMeta(lines[scan]); if (fsz) break; }
          }
        }
      }
    }
    // Some Telegram posts put the size after the URL button/link. Stop at the
    // next filename so one quality variant cannot inherit another's size.
    if (!fsz) {
      for (let scan=i + 1; scan < Math.min(lines.length, i + 10); scan++) {
        if (isSizeLine(lines[scan])) {
          fsz = extractSizeFromMeta(lines[scan]);
          if (fsz) consumedSizeLineIdx.add(scan);
          if (fsz) break;
        }
        if (isFileDesc(lines[scan])) break;
      }
    }
    // Reject junk as filenames
    if (fc&&/\b(click\s+here|telegram\s+files?|drive\s+links?|join|credits?)\b/i.test(fc)) fc=null;

    // Collect this URL + any immediately following consecutive URLs (same file slot)
    pairs.push({url:line, rawFilename:fc||'', size:fsz, urlType:cls});
    processedUrlIdx.add(i);
    let k=i+1;
    // URL-first format: URL on line N, filename on line N+1
    if (!fc && k < lines.length) {
      let fwdIdx = k;
      while (fwdIdx < lines.length && (isUrl(lines[fwdIdx])||isLinkLabel(lines[fwdIdx]))) fwdIdx++;
      if (fwdIdx < lines.length && isFileDesc(lines[fwdIdx])) {
        const fwdFc = lines[fwdIdx];
        pairs[pairs.length - 1].rawFilename = fwdFc;
        if (!pairs[pairs.length - 1].size) pairs[pairs.length - 1].size = extractSize(fwdFc);
        if (!pairs[pairs.length - 1].size) {
          for (let scan=fwdIdx + 1; scan < Math.min(lines.length, fwdIdx + 6) && !isUrl(lines[scan]); scan++) {
            if (isSizeLine(lines[scan])) { pairs[pairs.length - 1].size = extractSizeFromMeta(lines[scan]); if (pairs[pairs.length - 1].size) break; }
            if (isFileDesc(lines[scan])) break;
          }
        }
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
  const numberedListLines = lines.filter(l => /^\d+[\.)\-]\s+.{5,}/.test(l) && !isUrl(l) && !parseExplicitAudioTrackLine(l));
  const _isBatchList = numberedListLines.length >= 2;
  // (caller can check parsed._isBatchList to re-split if needed)

  // Strategy 1: first line that is not URL / promo / metadata and has a meaningful clean title
  // Skip codec/quality-ONLY single-line titles (AV1, 4K, HEVC, etc.)
  // Also skip pure language-list lines, size lines, and channel-hub watermarks.
  const TECH_ONLY_RE = /^\s*(AV1|HEVC|AVC|4K|UHD|4320p|2160p|1440p|1080p|720p|576p|540p|480p|360p|240p|HDR|HDR10|DV|HLG|SDR|4K\.\.\.+)\s*$/i;
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
  // Keep the title/message year (usually the show's first-air year) separate
  // from each filename year (often the year a later season was released).
  const messageYear = extractYear([masterTitle]);
  const fileYearCandidates = extractYearCandidates(pairs.map(pair => pair.rawFilename));
  const filenameYear = fileYearCandidates[0] || extractYear([firstFn]);
  const yearCandidates = [...new Set([messageYear, ...fileYearCandidates].filter(Boolean))];
  const year = messageYear || filenameYear || extractYear([fullText]);
  if (year && !yearCandidates.includes(year)) yearCandidates.push(year);
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
    const TECH_TOKEN_RE = /\b(4320p|2160p|1440p|1080p|720p|576p|540p|480p|360p|240p|4K|UHD|WEB[-\s]?DL|WEBRip|BluRay|BDRip|HDRip|REMUX|HEVC|x265|x264|VP9|VP8|MPEG[ ._-]?[24]|Xvid|DivX|ProRes|Theora|VC[ ._-]?1|AV1|VP9|VP8|AVC|AMZN|NF|DSNP|ZEE5|SUNNXT|JIOHS|TK|SS|AHA|ARTL|HMAX|HOTSTAR|CRKL|PCOK|DPLS|DDPd?|AAC|DTS|FLAC|DD5|DD2|HDR|SDR|DV|HLG)\b/i;
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
    .replace(/\b(4320p|2160p|1440p|1080p|720p|576p|540p|480p|360p|240p|4[Kk]|UHD|WEB[-.]?DL|HDRip|BluRay|BDRip|WEBRip|HEVC|x265|x264|VP9|VP8|MPEG[ ._-]?[24]|Xvid|DivX|ProRes|Theora|VC[ ._-]?1|AVC|AV1|VP9|VP8|HDR|HDR10P|REMUX|REPACK|RE[ ._-]?RIP|RERIP|PROPER|SDR|HLG|DV)\b/gi,'')
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
    // Replace dots/underscores with space, but preserve hyphens BETWEEN proper-case words
    // e.g. "Hanu-Man" keeps hyphen; "WEB-DL", "H.265" become spaces
    .replace(/[._]+/g,' ')                              // dots and underscores → space
    .replace(/(?<=[A-Z]{2,})-(?=[A-Z])/g,' ')          // UPPER-UPPER: WEB-DL → space
    .replace(/(?<=[0-9])-(?=[A-Z0-9])/g,' ')           // digit-UPPER: H264-NaMovies → space
    .replace(/(?<=[A-Z])-(?=[0-9])/g,' ')              // UPPER-digit: x265-3 → space
    .replace(/\s+/g,' ')
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
  // Platform/release-group inference (e.g. SUNNXT → Telugu, TamilBlasters → Tamil)
  const platformLang=inferLanguageFromPlatform(fullText);
  const detectedLanguages = detectAllLanguages(fullText);
  const languageInfo = classifyLanguages(detectedLanguages, fullText);
  const allLanguages = languageInfo.languages;
  const language = allLanguages.length
    ? allLanguages.join(', ')
    : (languageInfo.languageType || audioLang || inlineLang || platformLang || '');

  // Build download slots
  const fileMap={};
  for (const pair of pairs) {
    const rawFn=pair.rawFilename||masterTitle;
    const hasDedicatedFn = rawFn !== masterTitle;
    let quality=normalizeQuality(rawFn);
    // Size: only pull from rawFn itself (most accurate). Pair-extracted size is next.
    // Do NOT fall back to masterTitle or fullText when we have per-link filenames,
    // because that incorrectly assigns the same size to 1080p and 720p variants.
    let size=extractSize(rawFn);
    if (!size && pair.size) size=pair.size;
    // Only use fullText/masterTitle size when there's no dedicated filename at all
    // (i.e. the parser couldn't find a filename line near the URL)
    if (!size && !hasDedicatedFn) {
      // Try to find size near this URL's quality token in the full text
      // by searching for "quality … size" patterns in fullText
      const qualMatch = quality !== 'HD' ? new RegExp(`${quality}[^\\n]{0,60}?(\\d+(?:\\.\\d+)?\\s*(?:GB|MB))`, 'i').exec(fullText) : null;
      if (qualMatch) {
        size = qualMatch[1].replace(/\s+/g, '').trim();
      } else {
        // Last resort: any size in fullText (only when there are no per-link filenames at all)
        const anyPairHasFn = pairs.some(p => p.rawFilename && p.rawFilename !== masterTitle);
        if (!anyPairHasFn) size = extractSize(fullText);
      }
    }

    const hdr=detectHDR(rawFn);
    const codec=detectCodec(rawFn);

    if (quality==='HD'&&hasDedicatedFn) { const mq=normalizeQuality(masterTitle); if(mq!=='HD') quality=mq; }
    // When still HD: scan lines near this URL (within ±5 lines) for quality token
    // so different quality blocks in the same message don't bleed into each other.
    if (quality==='HD') {
      const urlLineIdx = lines.indexOf(pair.url);
      if (urlLineIdx >= 0) {
        const start = Math.max(0, urlLineIdx - 8);
        const nearby = lines.slice(start, urlLineIdx + 1).join(' ');
        const mq = normalizeQuality(nearby);
        if (mq !== 'HD') quality = mq;
      }
      // Last resort: fullText (only when no nearby quality found)
      if (quality==='HD') { const mq=normalizeQuality(fullText); if(mq!=='HD') quality=mq; }
    }

    const fileLangInfo = classifyLanguages(detectAllLanguages(rawFn), rawFn);
    const effectiveLangInfo = fileLangInfo.languageCount || fileLangInfo.languageType
      ? fileLangInfo
      : languageInfo;
    const fileLang = effectiveLangInfo.languages.length
      ? effectiveLangInfo.languages.join(', ')
      : (effectiveLangInfo.languageType || language);

    const pairLineIndex = lines.findIndex(line => String(line).trim() === String(pair.url || '').trim());
    const rawFilenameLineIndex = pairLineIndex >= 0
      ? lines.lastIndexOf(String(rawFn || '').trim(), pairLineIndex)
      : -1;
    const pairContextStart = rawFilenameLineIndex >= 0
      ? rawFilenameLineIndex
      : Math.max(0, pairLineIndex - 8);
    const pairContext = pairLineIndex >= 0
      ? lines.slice(pairContextStart, pairLineIndex + 1).join(' ')
      : '';
    const audioTracks = collectAudioTracksForPair(rawFilenameLineIndex, pairLineIndex);
    const fileContext = rawFn + ' ' + masterTitle + ' ' + pairContext;
    const releaseMeta = detectReleaseMetadata(fileContext);
    const fileAspectRatio = extractAspectRatio(rawFn) || extractAspectRatio(masterTitle) || extractAspectRatio(pairContext);
    const fileIsIMAX = /\bIMAX\b/i.test(fileContext);
    const {season:ds,episode:de}=extractSeasonEpisode(rawFn);
    const fs=ds??season, fe=de??episode;
    const fileYear = extractYear([rawFn]) || null;
    const fileIdentity = stripEmojis(rawFn).toLowerCase().replace(/\s+/g, ' ').trim();
    const key=`${quality}__${size||'nosize'}__${releaseMeta.releaseType}__S${fs??''}E${fe??''}__${fileIdentity||pair.url}`;

    // Audio/source details are sometimes posted as adjacent "Audio:" / "Source:"
    // lines instead of being embedded in the filename.
    const technicalContext = [rawFn, pairContext].filter(Boolean).join(' ');
    const audio = extractAudio(technicalContext) || null;
    const bitDepth = detectBitDepth(technicalContext);
    const audioChannels = detectAudioChannels(technicalContext);
    const source = detectSource(technicalContext) || null;
    const container = detectContainer(rawFn) || null;
    if (!fileMap[key]) fileMap[key]={
      quality,size,hdr,codec,container,audio,bitDepth,audioChannels,audioTracks,source,
      filename:stripEmojis(rawFn).trim()||cleanedTitle,
      language:fileLang, languages:effectiveLangInfo.languages,
      languageType:effectiveLangInfo.languageType, languageCount:effectiveLangInfo.languageCount,
      isRepack:releaseMeta.isRepack, releaseType:releaseMeta.releaseType,
      isIMAX:fileIsIMAX, aspectRatio:fileAspectRatio,
      season:fs,episode:fe,fileYear,links:[]
    };
    if (!fileMap[key].links.find(l=>l.url===pair.url)) {
      fileMap[key].links.push({host:detectHost(pair.url),url:normalizeGdflixUrl(pair.url),isFast:/gdflix\.dev|hubcloud|gdlink/i.test(pair.url)});
    }
  }

  const downloads=Object.values(fileMap);
  if (!downloads.length) return null;

  const QO=['8K','4K','1440p','1080p','720p','576p','540p','480p','360p','240p','SD','HD'];
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

  const mediaMetadata = extractMediaMetadata(fullText);
  return {
    title:cleanedTitle,rawTitle:masterTitle,year,messageYear,filenameYear,yearCandidates,language,languages:allLanguages,
    languageType:languageInfo.languageType, languageCount:languageInfo.languageCount,
    quality:bestQuality,contentType,isSeries,season,episode,downloads,messageId,
    date:msgDate||null,imdbId,tmdbIdHint,_isBatchList,
    isRepack:mediaMetadata.isRepack, releaseType:mediaMetadata.releaseType,
    isRepack:mediaMetadata.isRepack, releaseType:mediaMetadata.releaseType,
    isIMAX:mediaMetadata.isIMAX, aspectRatio:mediaMetadata.aspectRatio,
    runtimeMinutes:mediaMetadata.runtimeMinutes, duration:mediaMetadata.duration,
    certification:mediaMetadata.certification
  };
}

module.exports = {
  parseMessageBlock,classifyUrl,stripEmojis,cleanTitleForApi,normalizeQuality,
  extractSize,toMB,detectHost,detectLanguage,detectAllLanguages,detectContentType,
  extractSeasonEpisode,detectCodec,detectContainer,detectHDR,detectBitDepth,detectAudioChannels,extractAudio,detectSource,isJunkTitle,isGenericTitleCandidate,isMetadataLine,
  normalizeLanguageList,classifyLanguages,detectReleaseMetadata,extractAspectRatio,extractRuntime,extractCertification,extractMediaMetadata,
  extractTitleFromStreamingUrl, normalizeGdflixUrl, isKnownProviderHost,\n  extractYear, extractYearCandidates,
  parseManualInput,
};

// ─── MANUAL INPUT PARSER ────────────────────────────────────────────────────
// Parses a single raw filename/paste line into a structured entry.
// Returns { title, year, quality, size, codec, hdr, audio, language, season, episode, type }
function parseManualInput(line) {
  if (!line || !line.trim()) return null;
  const raw = line.trim();

  // Extract size  e.g. 1.2GB, 800MB, 1,200 MB
  // Reuse the canonical extractor so manual and quick-paste sizes stay consistent.
  const size = extractSize(raw);

  // Extract quality
  const quality = normalizeQuality(raw) || 'HD';

  // Extract codec, HDR, audio from filename
  const codec = detectCodec(raw) || 'Other';
  const container = detectContainer(raw) || null;
  const hdr   = detectHDR(raw)   || null;
  const audio = extractAudio(raw) || null;
  const source = detectSource(raw) || null;
  const audioChannels = detectAudioChannels(raw) || null;

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
    .replace(/\b(4K|UHD|4320p|2160p|1440p|1080p|720p|576p|540p|480p|360p|240p|HD|SD)\b/gi, '')  // quality
    .replace(/\b(HEVC|H\.?265|x265|AVC|H\.?264|x264|AV1|VP9)\b/gi, '') // codec
    .replace(/\b(TRUEHD|DTS[-.\s]?HD|DTS[-.\s]?X|DTS|ATMOS|EAC3|AC3|AAC|FLAC|MP3|DD[P+]?)\b/gi, '') // audio
    .replace(/\b(HDR10\+?|DOLBY[\s.]?VISION|HLG|SDR|HDR)\b/gi, '') // hdr
    .replace(/S\d{1,2}E\d{1,3}|Season\s*\d+|Episode\s*\d+/gi, '') // season/ep
    .replace(/\[(.*?)\]|\{(.*?)\}|\((.*?)\)/g, '')  // bracketed tags
    .replace(/(?<!\d)(19\d{2}|20\d{2})(?!\d)/g, '') // year
    .replace(/[._\-]+/g, ' ')                        // dots/underscores
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Remove source and edition markers from the manually parsed title.
  title = title.replace(/\s*(BluRay|WEB-?DL|WEBRip|DVDRip|DVD[ ._-]?[59]|DVD|HDTV|Blu-?Ray|Remux|REMUX|Extended|Theatrical|Directors\.?Cut)\s*/gi, ' ').trim();
  title = cleanTitleForApi(title) || title;

  return { title, year, quality, size, codec, container, hdr, audio, audioChannels, source, language, season, episode, type, raw };
}
