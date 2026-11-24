'use strict';
const mongoose = require('mongoose');

const AudioTrackSchema = new mongoose.Schema({
  codec: { type: String, default: '' },
  channels: { type: String, default: '' },
  language: { type: String, default: '' },
}, { _id: false });

// ExtractedLink — persistent store for links uploaded by scrape-and-upload.js.
// This is the bridge between the local scraper and the Vercel pipeline:
//   1. scrape-and-upload.js → POST /api/scrape/save-extracted → saves here
//   2. pipeline_full.js (Vercel) → reads from here to run phaseImport
//   3. routes/orchestrator.js → reads from here for /import-batch
const extractedLinkSchema = new mongoose.Schema({
  url:         { type: String, required: true },
  messageId:   { type: Number, default: null },
  host:        { type: String, default: 'Other' },
  title:       { type: String, default: '' },
  rawTitle:    { type: String, default: '' },
  year:        { type: Number, default: null },
  messageYear: { type: Number, default: null },
  yearCandidates: { type: [Number], default: [] },
  quality:     { type: String, default: 'HD' },
  size:        { type: String, default: '' },
  language:    { type: String, default: '' },
  season:      { type: Number, default: null },
  episode:     { type: Number, default: null },
  type:        { type: String, default: 'movie' },
  filename:    { type: String, default: '' },
  codec:       { type: String, default: '' },
  hdr:         { type: String, default: '' },
  audio:       { type: String, default: '' },
  source:      { type: String, default: '' },
  container:   { type: String, default: '' },
  bitDepth:    { type: String, default: '' },
  audioChannels:{ type: String, default: '' },
  fileYear:    { type: Number, default: null },
  audioTracks: { type: [AudioTrackSchema], default: [] },
  isRepack:    { type: Boolean, default: false },
  releaseType: { type: String, default: 'Original' },
  isIMAX:      { type: Boolean, default: false },
  aspectRatio: { type: String, default: '' },
  languageType:{ type: String, enum: ['Single', 'Dual', 'Multi', ''], default: '' },
  languageCount:{ type: Number, default: 0 },
  runtimeMinutes:{ type: Number, default: null },
  duration:    { type: String, default: '' },
  certification:{ type: String, default: '' },
  bypassedUrl: { type: String, default: '' },
  isSeries:    { type: Boolean, default: false },
  contentType: { type: String, default: '' },
  date:        { type: String, default: '' },
  imdbId:      { type: String, default: '' },
  tmdbIdHint:  { type: Number, default: null },
  sourceAccount:{ type: String, enum: ['1','2',''], default: '' },
  uploadBatch: { type: String, default: '' },
}, {
  timestamps: true,
  collection: 'extractedlinks',
});

// Index on url for fast dedup checks during chunked uploads
extractedLinkSchema.index({ url: 1 });
// Index on uploadBatch for fast batch cleanup
extractedLinkSchema.index({ uploadBatch: 1 });

module.exports = mongoose.models.ExtractedLink
  || mongoose.model('ExtractedLink', extractedLinkSchema);
