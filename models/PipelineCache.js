// models/PipelineCache.js
// Stores the last successfully extracted/bypassed links from the pipeline.
// This persists between Vercel Lambda invocations (unlike /tmp which is ephemeral).
// Skip Scraper reads from here instead of the filesystem.

'use strict';
const mongoose = require('mongoose');

const PipelineCacheSchema = new mongoose.Schema({
  key:       { type: String, required: true, unique: true }, // 'bypassed_links' | 'extracted_links' | '_pipeline_running'
  data:      { type: mongoose.Schema.Types.Mixed, default: null }, // the array of links (optional for status flag)
  count:     { type: Number, default: 0 },
  savedAt:   { type: Date, default: Date.now },
  running:   { type: Boolean, default: false },  // pipeline running flag
  updatedAt: { type: Date, default: Date.now },  // when running flag was last set
});

module.exports = mongoose.models.PipelineCache || mongoose.model('PipelineCache', PipelineCacheSchema);
