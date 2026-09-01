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
});

test('cleanTags trims, deduplicates, and bounds tags', () => {
  assert.deepEqual(cleanTags([' systems ', 'systems', '', 'database']), ['systems', 'database']);
  assert.equal(cleanTags(Array.from({ length: 30 }, (_, index) => `tag-${index}`)).length, 20);
});
