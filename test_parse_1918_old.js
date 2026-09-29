const fs = require('fs');
const parser = require('./utils/parser');
// Mock cleanTitleForApi as it was BEFORE commit 35e6e984
parser.cleanTitleForApi = function(title) {
  if (!title) return '';
  const stripEmojis = parser.stripEmojis || function(s){return s;};
  let rawClean = stripEmojis(title);
  let cleaned = rawClean
    .replace(/\s*&\s*/g, ' and ')
    .replace(/^@[A-Za-z0-9_]+\s*/g, '')
    .replace(/\s*(HOiCHOi|Hoichoi)\s*(RAW|Unlimited|Original)\s*[A-Za-z0-9]*\s*$/i, '')
    .replace(/\s*(JoyMaa|JanaSeksPyaar|PodMereUreJabo|RoserGolla|MosirJANA|LiCKW33D|PodMere[A-Za-z]+)\s*$/i, '')
    .replace(/\b(Benzmovies|NaMovies|Friday4KPopcorn|Malli4U\s*Official|Malli4UOfficial|SPiDEY|LRTX|DS4K|LiCKW33D)\b/gi, '')
    .replace(/\b(telugu|tamil|hindi|malayalam|kannada|bengali|english|marathi|japanese|korean|chinese|arabic|turkish|spanish|french|german|punjabi|dual|multi)\b/gi,'')
    .replace(/\bH[.\s]+26[45]\b/gi,'').replace(/\bx26[45]\b/gi,'')
    .replace(/\.(mkv|mp4|avi|mov|ts|m2ts|zip|rar)\b/gi,'')
    .replace(/\b(mkv|mp4|avi|m2ts)\b/gi,'')
    .replace(/\bS\d{1,2}\s*E\d{1,3}\b/gi,'').replace(/\bSeason\s*\d+\b/gi,'')
    .replace(/\bSeason\s*\d+\s*[-–to]+\s*\d+\b/gi,'')
    .replace(/\bS\d{1,2}\s*[-–]\s*S\d{1,2}\b/gi,'')
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
    .replace(/(?:^|\s)\d{1,2}(?:\s|$)/g, ' ')
    .replace(/\s+[A-Z][a-z]{1,3}[A-Z][a-zA-Z0-9]{2,14}$/, '')
    .replace(/\s+[A-Z]{3,12}(?:\d+[Kk]?)?$/, '')
    .replace(/[\(\[\-\u2013\u2014\s]+$/,'')
    .trim();
  return cleaned || rawClean.trim();
};

const exportData = JSON.parse(fs.readFileSync('telegram_export.json', 'utf8'));
const msg = exportData.messages.find(m => m.id === 1918);
console.log(parser.parseMessageBlock(msg.text, msg.id, msg.date));
