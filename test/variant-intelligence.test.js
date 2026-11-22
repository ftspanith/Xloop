const test = require('node:test');
const assert = require('node:assert/strict');
const { sizeToBytes, titleKey, analyzeVariantSet } = require('../utils/variant-intelligence');

test('parses binary file sizes and normalizes title/year', () => {
  assert.equal(sizeToBytes('2.19 GB'), Math.round(2.19 * 1024 ** 3));
  assert.equal(titleKey({title:"Charlie's Angels",year:2019}), titleKey({title:"Charlies Angels 2019"}));
});

test('ranks source and resolution rather than blindly choosing largest file', () => {
  const result = analyzeVariantSet([
    {title:'Example Film',year:2020,quality:'1080p',source:'WEB-DL',codec:'x264',size:'2.19 GB',language:'Telugu, Hindi',audio:'AAC 2.0',url:'https://a/1'},
    {title:'Example Film',year:2020,quality:'1080p',source:'BluRay',codec:'x264',size:'2 GB',language:'Telugu, Hindi',audio:'AAC 2.0',url:'https://a/2'}
  ]);
  assert.equal(result.ranked[0].source,'BluRay');
  assert.equal(result.ranked.length,2);
});

test('flags near-identical sizes for review without deleting either link', () => {
  const result = analyzeVariantSet([
    {title:'Film',year:2021,quality:'1080p',codec:'HEVC',audio:'DDP 5.1',language:'Telugu',size:'6 GB',url:'https://a/1'},
    {title:'Film',year:2021,quality:'1080p',codec:'HEVC',audio:'DDP 5.1',language:'Telugu',size:'6.02 GB',url:'https://b/2'}
  ]);
  assert.equal(result.nearDuplicates.length,1);
  assert.equal(result.uniqueVariants,2);
});

test('reports exact duplicate URLs across account imports', () => {
  const result = analyzeVariantSet([
    {title:'Film',url:'https://same/link'},
    {title:'Film',url:'https://same/link'}
  ]);
  assert.equal(result.exactUrlDuplicates,1);
  assert.equal(result.uniqueVariants,1);
});
