const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Module = require('node:module');
const path = require('node:path');
const { parseMessageBlock } = require('../utils/parser');
const paste = `The Demon Hunter (2025)
The Demon Hunter (2025) 1080p JIOHS WEB-DL 8bit x264 [Telugu + Tamil + Hindi (AAC 2.0)] ESub.mkv - [2.31 GB]
https://gdflix.dev/file/N7ty2aFXhlae2hJ
The Demon Hunter (2025) 1080p JIOHS WEB-DL HEVC [Telugu + Tamil + Hindi (AAC 2.0)] ESub.mkv - [1.77 GB]
https://gdflix.dev/file/VNOtWIAGYQDC4jV
The Demon Hunter (2025) 720p JIOHS WEB-DL 8bit x264 [Telugu + Tamil + Hindi (AAC 2.0)] ESub.mkv - [1.07 GB]
https://gdflix.dev/file/Fx3vP2ZROtt66JN
The Demon Hunter (2025) 720p JIOHS WEB-DL HEVC [Telugu + Tamil + Hindi (AAC 2.0)] ESub.mkv - [717 MB]
https://gdflix.dev/file/WQ3XVdPqgn7KFcX`;
function renderDownloads(downloads) {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/watch.js'), 'utf8');
  const sandbox = { document: { addEventListener() {}, getElementById() { return { addEventListener() {} }; } }, window: {}, console, URL, Set, Map, Array, String, Number, Math, Object, RegExp, parseInt, parseFloat };
  vm.runInNewContext(source, sandbox, { filename: 'watch.js' });
  return sandbox.buildDownloadSection(downloads, 'Multi', 'movie');
}
test('watch page renders four distinct rows with correct size, codec and URL', () => {
  const parsed = parseMessageBlock(paste);
  const html = renderDownloads(parsed.downloads);
  assert.equal((html.match(/class="dl-row"/g) || []).length, 4);
  for (const size of ['2.31GB', '1.77GB', '1.07GB', '717MB']) assert.ok(html.includes(size), 'missing size ' + size);
  for (const id of ['N7ty2aFXhlae2hJ', 'VNOtWIAGYQDC4jV', 'Fx3vP2ZROtt66JN', 'WQ3XVdPqgn7KFcX']) assert.ok(html.includes(id), 'missing URL ' + id);
  assert.ok(html.includes('AVC')); assert.ok(html.includes('HEVC'));
});
test('bulk route preserves four variants and skips repeated import', async () => {
  let saved = null;
  const movieModel = { async findOne() { return saved; }, async create(data) { saved = { ...data, async save() {} }; return saved; } };
  const routes = {};
  const router = new Proxy({}, { get(_target, method) { return (route, ...handlers) => { if (method === 'post') routes[route] = handlers[handlers.length - 1]; }; } });
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'express') return { Router: () => router };
    if (request === '../middleware/auth') return (_req, _res, next) => next();
    if (request === 'axios') return { get: async () => { throw new Error('offline in isolated test'); } };
    if (request === '../models/Movie') return movieModel;
    if (request === '../utils/tmdbSearch') return { searchTMDB: async () => null, searchOMDB: async () => null };
    if (request === '../pipeline_full') return { recomputeAggregates(doc) { doc.formats = [...new Set(doc.downloads.map(d => d.quality))]; } };
    return originalLoad.call(this, request, parent, isMain);
  };
  let handler;
  try { const routePath = require.resolve('../routes/import'); delete require.cache[routePath]; require('../routes/import'); handler = routes['/bulk']; }
  finally { Module._load = originalLoad; }
  assert.equal(typeof handler, 'function');
  async function invoke() {
    let status = 200, body;
    const res = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
    await handler({ body: { messages: [{ id: 101, text: paste }] } }, res);
    return { status, body };
  }
  const first = await invoke();
  assert.equal(first.status, 200); assert.equal(first.body.successCount, 1);
  assert.equal(saved.downloads.length, 4);
  assert.deepEqual([...saved.downloads.map(d => d.size)].sort(), ['1.07GB', '1.77GB', '2.31GB', '717MB'].sort());
  assert.deepEqual([...saved.downloads.map(d => d.codec)].sort(), ['H.264', 'H.264', 'HEVC', 'HEVC'].sort());
  const second = await invoke();
  assert.equal(second.status, 200); assert.equal(saved.downloads.length, 4);
  assert.equal(second.body.duplicateCount, 1);
});
