import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMergeConfig, renderMergeFields } from '../shared/merge-fields';

const cfg = parseMergeConfig(JSON.stringify({
  openings: { 'font-of-web': 'You signed up for Font of Web.', default: 'Hello from Fudge.' },
}));

test('greets by first name, or with a bare "Hi," when there is none', () => {
  assert.equal(renderMergeFields('{{greeting}}', cfg, 'Ana', null, false), 'Hi Ana,');
  assert.equal(renderMergeFields('{{ greeting }}', cfg, '  ', null, false), 'Hi,');
  assert.equal(renderMergeFields('{{greeting}}', cfg, undefined, null, false), 'Hi,');
});

test('picks the opening for the segment, falling back to default', () => {
  assert.equal(renderMergeFields('{{opening}}', cfg, null, 'font-of-web', false), 'You signed up for Font of Web.');
  assert.equal(renderMergeFields('{{opening}}', cfg, null, 'fudge', false), 'Hello from Fudge.');
  assert.equal(renderMergeFields('{{opening}}', {}, null, 'fudge', false), '');
});

test('escapes values in HTML only', () => {
  assert.equal(renderMergeFields('<p>{{greeting}}</p>', cfg, 'A<b>', null, true), '<p>Hi A&lt;b&gt;,</p>');
  assert.equal(renderMergeFields('{{greeting}}', cfg, 'A<b>', null, false), 'Hi A<b>,');
});

test('ignores bad merge JSON', () => {
  assert.deepEqual(parseMergeConfig('{not json'), {});
  assert.deepEqual(parseMergeConfig(null), {});
});
