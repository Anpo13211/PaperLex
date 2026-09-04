import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTags, cleanTerm, normalizeTerm, ValidationError } from '../lib/normalize.mjs';

test('cleanTerm normalizes width and whitespace without losing a phrase', () => {
  assert.equal(cleanTerm('  amortized\n  analysis  '), 'amortized analysis');
  assert.equal(cleanTerm('ＡＢＣ'), 'ABC');
  assert.equal(normalizeTerm('Ephemeral'), 'ephemeral');
});

test('cleanTerm rejects empty and oversized selections', () => {
  assert.throws(() => cleanTerm(' \n '), ValidationError);
  assert.throws(() => cleanTerm('x'.repeat(161)), /160/);
  assert.throws(() => cleanTerm('...'), ValidationError);
});

test('cleanTerm drops the punctuation PDFs leave around a selected word', () => {
  // 文末で選ぶと「suffice.」になり、辞書が引けずに意味なしで保存されていた。
  assert.equal(cleanTerm('suffice.'), 'suffice');
  assert.equal(cleanTerm('“suffice”'), 'suffice');
  assert.equal(cleanTerm('(suffice),'), 'suffice');
  assert.equal(cleanTerm('suffice…'), 'suffice');
  assert.equal(normalizeTerm('Suffice.'), 'suffice');
});

test('cleanTerm drops citation and footnote markers but keeps the word', () => {
  assert.equal(cleanTerm('suffice[12]'), 'suffice');
  assert.equal(cleanTerm('suffice[3, 7]'), 'suffice');
  assert.equal(cleanTerm('suffice*'), 'suffice');
  assert.equal(cleanTerm('suffice†'), 'suffice');
});

test('cleanTerm removes invisible characters and a dangling line-break hyphen', () => {
  assert.equal(cleanTerm('suf\u00ADfice'), 'suffice');
  assert.equal(cleanTerm('suffice\u200B'), 'suffice');
  assert.equal(cleanTerm('suf-'), 'suf');
});

test('cleanTerm keeps abbreviations, compounds and possessives intact', () => {
  assert.equal(cleanTerm('e.g.'), 'e.g.');
  assert.equal(cleanTerm('Ph.D.'), 'Ph.D.');
  assert.equal(cleanTerm('U.S.'), 'U.S.');
  assert.equal(cleanTerm('a-priori'), 'a-priori');
  assert.equal(cleanTerm('state-of-the-art'), 'state-of-the-art');
  assert.equal(cleanTerm("Occam's razor"), "Occam's razor");
  assert.equal(cleanTerm('C++'), 'C++');
});

test('cleanTags trims, deduplicates, and bounds tags', () => {
  assert.deepEqual(cleanTags([' systems ', 'systems', '', 'database']), ['systems', 'database']);
  assert.equal(cleanTags(Array.from({ length: 30 }, (_, index) => `tag-${index}`)).length, 20);
});
