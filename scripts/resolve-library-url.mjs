#!/usr/bin/env node

import fs from 'node:fs';
import { classifyCaptureBaseUrl, normalizeExternalLibraryUrl } from '../lib/library-url.mjs';

try {
  const [mode, value] = process.argv.slice(2);
  if (mode === '--library') {
    const normalized = normalizeExternalLibraryUrl(value || '');
    if (!normalized) throw new Error('Missing library URL.');
    process.stdout.write(normalized);
  } else if (mode === '--capture') {
    const config = JSON.parse(fs.readFileSync(value, 'utf8'));
    if (typeof config.token !== 'string' || config.token.length < 24) throw new Error('Invalid capture token.');
    const target = classifyCaptureBaseUrl(config.baseURL);
    if (target.kind === 'local' && config.token !== process.env.PAPERLEX_EXPECTED_CAPTURE_TOKEN) {
      throw new Error('Local capture token mismatch.');
    }
    process.stdout.write(target.kind === 'local' ? 'LOCAL' : target.url);
  } else {
    throw new Error('Usage: resolve-library-url.mjs --library URL | --capture FILE');
  }
} catch {
  process.exitCode = 1;
}
