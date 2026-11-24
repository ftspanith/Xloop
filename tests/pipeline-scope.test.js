'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dateKeyInTimezone,
  filterEntriesByScope,
  titleMatches,
} = require('../utils/pipelineScope');

test('all scope preserves the complete source batch', () => {
  const entries = [{ title: 'One' }, { title: 'Two' }];
  const result = filterEntriesByScope(entries, { scope: 'all' });
  assert.deepEqual(result.entries, entries);
  assert.equal(result.matched, 2);
});

test('daily scope uses Asia/Kolkata local message date across UTC midnight', () => {
  const entries = [
    { title: 'Late night post', date: '2026-11-23T19:00:00Z' }, // 00:30 IST on Nov 24
    { title: 'Previous day', date: '2026-11-23T17:00:00Z' }, // 22:30 IST on Nov 23
    { title: 'Next day', date: '2026-11-24T19:00:00Z' }, // 00:30 IST on Nov 25
    { title: 'No original date', createdAt: '2026-11-24T10:00:00Z' },
  ];
  const result = filterEntriesByScope(entries, {
    scope: 'daily',
    timezone: 'Asia/Kolkata',
    now: new Date('2026-11-24T12:00:00Z'),
  });
  assert.deepEqual(result.entries.map(entry => entry.title), ['Late night post']);
  assert.equal(result.missingDate, 1);
});

test('daily scope understands Telegram Unix timestamps', () => {
  const timestamp = Math.floor(new Date('2026-11-24T02:00:00Z').getTime() / 1000);
  assert.equal(dateKeyInTimezone(timestamp, 'Asia/Kolkata'), '2026-11-24');
  const result = filterEntriesByScope([{ title: 'Unix date', date_unixtime: String(timestamp) }], {
    scope: 'daily',
    timezone: 'Asia/Kolkata',
    now: new Date('2026-11-24T12:00:00Z'),
  });
  assert.equal(result.matched, 1);
});

test('title scope matches only the selected title, raw title or filename', () => {
  const entries = [
    { title: 'Robo (2010)', filename: 'Robo.2010.Telugu.1080p.mkv' },
    { title: 'Enthiran', rawTitle: 'Robo Telugu Dubbed' },
    { title: 'Robot (2019)' },
    { title: 'Other Movie', filename: 'Another.Movie.2022.mkv' },
  ];
  const result = filterEntriesByScope(entries, { scope: 'title', titleFilter: 'robo' });
  assert.equal(result.matched, 2);
  assert.deepEqual(result.entries.map(entry => entry.title), ['Robo (2010)', 'Enthiran']);
  assert.equal(titleMatches({ filename: 'Robot.2019.1080p.mkv' }, 'Robo'), false);
});

test('title scope rejects dangerously broad short search terms', () => {
  assert.throws(
    () => filterEntriesByScope([{ title: 'AB Movie' }], { scope: 'title', titleFilter: 'AB' }),
    /at least 3 characters/
  );
});

test('unknown scope is rejected instead of silently importing everything', () => {
  assert.throws(
    () => filterEntriesByScope([{ title: 'One' }], { scope: 'weekly' }),
    /Invalid scope/
  );
});
