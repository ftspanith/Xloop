const mongoose = require('mongoose');

const SeriesSchema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true },
  poster:      { type: String, default: '' },
  backdrop:    { type: String, default: '' },
  description: { type: String, default: '' },
  genre:       [{ type: String }],
  year:        { type: Number },
  rating:      { type: Number, default: 0, min: 0, max: 10 },
  language:    { type: String, default: 'Hindi' },
  status:      { type: String, default: 'Ongoing', enum: ['Ongoing', 'Completed'] },
  totalSeasons:{ type: Number, default: 1 },
  isFeatured:  { type: Boolean, default: false },
  isTrending:  { type: Boolean, default: false },
  views:       { type: Number, default: 0 }
}, { timestamps: true });

SeriesSchema.index({ title: 'text', description: 'text' });

module.exports = mongoose.model('Series', SeriesSchema);
