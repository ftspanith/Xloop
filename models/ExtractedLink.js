// models/ExtractedLink.js
// Stores individually extracted links from telegram_export.json.
// Using a proper collection (not PipelineCache) so there's no 16MB limit.
// 32k+ links = 32k+ documents — MongoDB handles this with no issues.
'use strict';
const mongoose = require('mongoose');

const ExtractedLinkSchema = new mongoose.Schema({
  messageId:   Number,
  title:       String,
  year:        Number,
  contentType: String,
  isSeries:    Boolean,
  season:      mongoose.Schema.Types.Mixed,
  episode:     mongoose.Schema.Types.Mixed,
  language:    String,
  quality:     String,
  size:        String,
  filename:    String,
  host:        String,
  url:         { type: String, index: true },
  bypassedUrl: String,
  isFast:      Boolean,
  imdbId:      String,
  tmdbIdHint:  mongoose.Schema.Types.Mixed,
  date:        mongoose.Schema.Types.Mixed,
  uploadBatch: { type: String, index: true }, // groups links by upload session
}, { timestamps: false });

ExtractedLinkSchema.index({ uploadBatch: 1, host: 1 });

module.exports = mongoose.models.ExtractedLink || mongoose.model('ExtractedLink', ExtractedLinkSchema);
