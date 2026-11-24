'use strict';

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function dateValueToDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const milliseconds = Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(raw + 'T00:00:00.000Z');
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateKeyInTimezone(value, timezone = DEFAULT_TIMEZONE) {
  const date = dateValueToDate(value);
  if (!date) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return values.year && values.month && values.day
      ? values.year + '-' + values.month + '-' + values.day
      : null;
  } catch (_) {
    return null;
  }
}

function titleMatches(entry, query) {
  const wanted = normalizeTitle(query);
  if (wanted.length < 3) return false;
  const fields = [entry?.title, entry?.rawTitle, entry?.filename]
    .filter(value => typeof value === 'string' && value.trim());
  return fields.some(value => {
    const candidate = normalizeTitle(value);
    return candidate ? (' ' + candidate + ' ').includes(' ' + wanted + ' ') : false;
  });
}

/**
 * Return entries selected by a pipeline scope.
 * Daily scope intentionally uses the original Telegram message date only;
 * it does not fall back to upload/DB timestamps, which could promote old
 * messages merely because they were re-uploaded today.
 */
function filterEntriesByScope(entries, options = {}) {
  if (!Array.isArray(entries)) throw new TypeError('Pipeline entries must be an array');
  const scope = String(options.scope || 'all').trim().toLowerCase();
  const titleFilter = String(options.titleFilter || '').trim();
  const timezone = String(options.timezone || DEFAULT_TIMEZONE);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());

  if (!['all', 'daily', 'title'].includes(scope)) {
    throw new Error('Invalid scope. Use all, daily, or title.');
  }
  if (scope === 'title' && normalizeTitle(titleFilter).length < 3) {
    throw new Error('Title scope requires a title filter of at least 3 characters.');
  }

  if (scope === 'all') {
    return { entries: [...entries], total: entries.length, matched: entries.length, missingDate: 0 };
  }

  if (scope === 'title') {
    const selected = entries.filter(entry => titleMatches(entry, titleFilter));
    return { entries: selected, total: entries.length, matched: selected.length, missingDate: 0 };
  }

  const todayKey = dateKeyInTimezone(now, timezone);
  if (!todayKey) throw new Error('Could not determine today\'s date for daily pipeline scope.');
  let missingDate = 0;
  const selected = entries.filter(entry => {
    const messageDate = entry?.date ?? entry?.messageDate ?? entry?.message_date ?? entry?.date_unixtime;
    if (messageDate == null || messageDate === '') {
      missingDate++;
      return false;
    }
    return dateKeyInTimezone(messageDate, timezone) === todayKey;
  });
  return { entries: selected, total: entries.length, matched: selected.length, missingDate };
}

module.exports = {
  DEFAULT_TIMEZONE,
  normalizeTitle,
  dateKeyInTimezone,
  titleMatches,
  filterEntriesByScope,
};
