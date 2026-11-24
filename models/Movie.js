const mongoose = require('mongoose');

const AudioTrackSchema = new mongoose.Schema({
  codec: { type: String, default: '' },
  channels: { type: String, default: '' },
  language: { type: String, default: '' },
}, { _id: false });

const LinkSchema = new mongoose.Schema({
  host: { type: String }, // GDFlix, HubCloud, FlipRes, TeraBox
  url:  { type: String },
  isFast: { type: Boolean, default: false }
}, { _id: false });

const DownloadSchema = new mongoose.Schema({
  season:   { type: Number },
  episode:  { type: Number },
  quality:  { type: String },
  size:     { type: String },
  filename: { type: String },
  language: { type: String },
  codec:    { type: String },  // AV1, HEVC, H.264, Other
  hdr:      { type: String },  // Dolby Vision, HDR10+, HDR10, HDR, SDR
  audio:    { type: String },  // Atmos, TrueHD, DTS:X, DTS-HD MA, DTS, EAC3, DD, AAC, FLAC
  source:   { type: String },  // WEB-DL, WEBRip, BluRay, REMUX, HDRip, DVD, CAM
  container:{ type: String },  // MKV, MP4, WEBM, AVI, M2TS, etc.
  bitDepth: { type: String },  // 8-bit, 10-bit, 12-bit, etc.
  audioChannels: { type: String }, // 2.0, 5.1, 7.1
  audioTracks: { type: [AudioTrackSchema], default: [] },
  isRepack: { type: Boolean, default: false },
  releaseType: { type: String, default: 'Original' }, // Original, Repack, Proper
  isIMAX: { type: Boolean, default: false },
  aspectRatio: { type: String, default: '' },
  languageType: { type: String, enum: ['Single', 'Dual', 'Multi', ''], default: '' },
  languageCount: { type: Number, default: 0 },
  sourceDate: { type: String, default: '' },
  fileYear:  { type: Number, default: null },
  links:    [LinkSchema]
}, { _id: false });


const MovieSchema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true },
  tmdbId:      { type: String, default: '' },
  imdbId:      { type: String, default: '' },
  type:        { type: String, enum: ['movie', 'series', 'anime'], default: 'movie' },
  totalSeasons:{ type: Number, default: 0 },
  seasonPosters:{ type: mongoose.Schema.Types.Mixed, default: {} }, // { s1: url, s2: url, ... }
  seasonYears:  { type: mongoose.Schema.Types.Mixed, default: {} }, // { s1: 2019, s2: 2020, ... }
  poster:        { type: String, default: '' },
  posterFallback:{ type: String, default: '' },  // OMDB high-res fallback
  backdrop:      { type: String, default: '' },
  description: { type: String, default: '' },
  genre:       [{ type: String }],
  year:        { type: Number },
  rating:      { type: Number, default: 0, min: 0, max: 10 },
  quality:     { type: String, default: '1080p' },
  language:    { type: String, default: '' },
  duration:    { type: String, default: '' },
  runtimeMinutes: { type: Number, default: null },
  certification: { type: String, default: '' }, // CBFC certificate: U, U/A, A, S
  isIMAX: { type: Boolean, default: false },
  aspectRatio: { type: String, default: '' },
  languageType: { type: String, enum: ['Single', 'Dual', 'Multi', ''], default: '' },
  isFeatured:  { type: Boolean, default: false },
  isTrending:  { type: Boolean, default: false },
  streamEmbed: { type: String, default: '' },
  formats:     [{ type: String }],
  codecs:      [{ type: String }],
  languages:   [{ type: String }],
  downloads:   [DownloadSchema],
  views:       { type: Number, default: 0 },
  telegramMessageIds: [{ type: Number }],
  _healAttempted: { type: Boolean, default: false },  // set true when no TMDB/OMDB data found — skip in future healer runs
  _importMeta: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

MovieSchema.index(
  { title: 'text', description: 'text' },
  { language_override: 'dummy_text_lang' }
);

// Compound indexes for the most common query patterns
MovieSchema.index({ type: 1, createdAt: -1 });   // all list pages (default sort)
MovieSchema.index({ type: 1, rating:    -1 });   // top-rated
MovieSchema.index({ type: 1, views:     -1 });   // trending
MovieSchema.index({ type: 1, year:      -1 });   // year filter
MovieSchema.index({ tmdbId: 1 });                 // importer dedup lookups
MovieSchema.index({ title: 1 });                  // importer title dedup lookups
MovieSchema.index({ type: 1, updatedAt: -1 });    // dashboard recent content query

module.exports = mongoose.model('Movie', MovieSchema);
