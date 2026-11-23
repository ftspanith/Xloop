'use strict';

// These are offline schema-contract tests. They intentionally do not connect
// to MongoDB, seed data, or write to any database.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Movie = require('../models/Movie');
const ExtractedLink = require('../models/ExtractedLink');

test('readiness contracts run without opening a MongoDB connection', () => {
  assert.equal(mongoose.connection.readyState, 0);
});

test('Movie requires a title and accepts only supported content types', () => {
  const missingTitle = new Movie({});
  assert.ok(missingTitle.validateSync().errors.title);

  const validMovie = new Movie({ title: 'Xloop contract fixture', type: 'movie' });
  assert.equal(validMovie.validateSync(), undefined);

  const invalidType = new Movie({ title: 'Invalid fixture', type: 'documentary' });
  assert.ok(invalidType.validateSync().errors.type);
});

test('Movie download links preserve the original URL and host metadata', () => {
  const originalUrl = 'https://gdflix.example/file/AbC123?token=keep-this';
  const movie = new Movie({
    title: 'Link preservation fixture',
    downloads: [{
      quality: '1080p',
      links: [{ host: 'GDFlix', url: originalUrl, isFast: true }]
    }]
  });

  assert.equal(movie.validateSync(), undefined);
  assert.equal(movie.downloads[0].links[0].url, originalUrl);
  assert.equal(movie.downloads[0].links[0].host, 'GDFlix');
  assert.equal(movie.downloads[0].links[0].isFast, true);
});

test('ExtractedLink requires a URL and retains upload/account metadata', () => {
  const missingUrl = new ExtractedLink({ title: 'Missing URL fixture' });
  assert.ok(missingUrl.validateSync().errors.url);

  const link = new ExtractedLink({
    url: 'https://hubcloud.example/s/UniqueId?download=1',
    host: 'HubCloud',
    title: 'Account two fixture',
    sourceAccount: '2',
    uploadBatch: 'readiness-test-batch'
  });

  assert.equal(link.validateSync(), undefined);
  assert.equal(link.sourceAccount, '2');
  assert.equal(link.uploadBatch, 'readiness-test-batch');
  assert.equal(link.url, 'https://hubcloud.example/s/UniqueId?download=1');
});

test('ExtractedLink rejects unsupported source-account values', () => {
  const link = new ExtractedLink({
    url: 'https://example.test/file/1',
    sourceAccount: '3'
  });

  assert.ok(link.validateSync().errors.sourceAccount);
});

test('schema checks leave the MongoDB connection closed', () => {
  assert.equal(mongoose.connection.readyState, 0);
});
