'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const adminDir = path.join(__dirname, '..', 'public', 'admin');

test('inline JavaScript on admin pages parses without syntax errors', () => {
  const files = fs.readdirSync(adminDir).filter(file => file.endsWith('.html'));
  const failures = [];

  for (const file of files) {
    const html = fs.readFileSync(path.join(adminDir, file), 'utf8');
    const scriptTag = /<script\\b([^>]*)>([\\s\\S]*?)<\\/script>/gi;
    let match;
    let index = 0;

    while ((match = scriptTag.exec(html))) {
      const attributes = match[1] || '';
      const source = match[2] || '';
      if (/\\bsrc\\s*=/.test(attributes) || !source.trim()) continue;

      const type = attributes.match(/\\btype\\s*=\\s*["']([^"']+)["']/i)?.[1] || '';
      if (type && !/(?:java|ecma)script/i.test(type)) continue;
      if (/\\btype\\s*=\\s*["']module["']/i.test(attributes)) continue;

      index += 1;
      try {
        new vm.Script(source, { filename: file + ':inline-script-' + index });
      } catch (error) {
        failures.push(file + ' inline script ' + index + ': ' + error.message);
      }
    }
  }

  assert.deepEqual(failures, [], failures.join('\\n'));
});
