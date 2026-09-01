import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const htmlFiles = [
  ['local', new URL('../public/index.html', import.meta.url)],
  ['hosted entry', new URL('../hosted/index.html', import.meta.url)],
  ['hosted public copy', new URL('../hosted/public/index.html', import.meta.url)],
];

test('add-dialog cancel controls bypass required-field validation', () => {
  for (const [label, url] of htmlFiles) {
    const source = fs.readFileSync(url, 'utf8');
    const cancelButtons = [...source.matchAll(/<button\b[^>]*\bvalue="cancel"[^>]*>/gu)].map(([tag]) => tag);
    assert.equal(cancelButtons.length, 2, `${label}: expected close and cancel controls`);
    for (const button of cancelButtons) {
      assert.match(button, /\bformnovalidate\b/u, `${label}: cancel must skip required-field validation`);
    }

    const saveButton = source.match(/<button\b[^>]*\bid="addSubmitButton"[^>]*>/u)?.[0] || '';
    assert.match(saveButton, /\btype="submit"/u, `${label}: save must remain a submit control`);
    assert.doesNotMatch(saveButton, /\bformnovalidate\b/u, `${label}: save must keep required-field validation`);
    const termInput = source.match(/<input\b[^>]*\bid="termInput"[^>]*>/u)?.[0] || '';
    assert.match(termInput, /\brequired\b/u, `${label}: an empty save must remain invalid`);
  }
});
