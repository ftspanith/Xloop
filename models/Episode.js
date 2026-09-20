const mongoose = require('mongoose');

const LinkSchema = new mongoose.Schema({
  host:   { type: String },
  url:    { type: String },
  isFast: { type: Boolean, default: false }
}, { _id: false });

const DownloadSchema = new mongoose.Schema({
  quality: { type: String },
  size:    { type: String },
  links:   [LinkSchema]
}, { _id: false });

const EpisodeSchema = new mongoose.Schema({
  seriesId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Series', required: true },
  season:      { type: Number, required: true, default: 1 },
  episode:     { type: Number, required: true },
  title:       { type: String, default: '' },
  thumbnail:   { type: String, default: '' },
  duration:    { type: String, default: '' },
  streamEmbed: { type: String, default: '' },
  downloads:   [DownloadSchema]
}, { timestamps: true });

module.exports = mongoose.model('Episode', EpisodeSchema);
