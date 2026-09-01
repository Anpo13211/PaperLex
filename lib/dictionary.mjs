const FREE_DICTIONARY_ENDPOINT = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const WIKTIONARY_ENDPOINT = 'https://en.wiktionary.org/api/rest_v1/page/definition/';
const WIKTIONARY_LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
const MAX_RESPONSE_BYTES = 512 * 1024;

export async function lookupDictionary(term, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { status: 'unavailable', dictionary: null, reason: 'fetch_unavailable' };
  }
  if (signal?.aborted) return abortedResult();

  const totalBudget = clampTimeout(timeoutMs);
  const startedAt = Date.now();
  const primaryBudget = Math.max(1, Math.min(3_000, Math.floor(totalBudget * 0.45)));
  const primary = await lookupFreeDictionary(term, {
    fetchImpl,
    timeoutMs: primaryBudget,
    signal,
  });
  if (primary.status === 'complete' || signal?.aborted) return signal?.aborted ? abortedResult() : primary;

  const remainingBudget = Math.max(1, totalBudget - (Date.now() - startedAt));
  const fallback = await lookupWiktionary(term, {
    fetchImpl,
    timeoutMs: remainingBudget,
    signal,
  });
  if (fallback.status === 'complete' || fallback.status === 'not_found' || signal?.aborted) {
    return signal?.aborted ? abortedResult() : fallback;
  }

  return {
    status: 'unavailable',
    dictionary: null,
    reason: [primary.reason, fallback.reason].filter(Boolean).join('+') || 'providers_unavailable',
  };
}

async function lookupFreeDictionary(term, { fetchImpl, timeoutMs, signal }) {
  try {
    const response = await fetchImpl(`${FREE_DICTIONARY_ENDPOINT}${encodeURIComponent(term)}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'PaperLex/0.1' },
      signal: requestSignal(signal, timeoutMs),
    });

    if (response.status === 404) return { status: 'not_found', dictionary: null };
    if (!response.ok) {
      return { status: 'unavailable', dictionary: null, reason: `free_dictionary_http_${response.status || 'error'}` };
    }

    const payload = await readBoundedJson(response);
    const dictionary = mapDictionaryPayload(payload);
    return dictionary
      ? { status: 'complete', dictionary }
      : { status: 'not_found', dictionary: null };
  } catch (error) {
    if (signal?.aborted) return abortedResult();
    return { status: 'unavailable', dictionary: null, reason: `free_dictionary_${classifyFailure(error)}` };
  }
}

async function lookupWiktionary(term, { fetchImpl, timeoutMs, signal }) {
  const candidates = wiktionaryCandidates(term);
  let lastReason = '';

  for (const [index, candidate] of candidates.entries()) {
    if (signal?.aborted) return abortedResult();
    const candidatesLeft = candidates.length - index;
    const candidateBudget = Math.max(1, Math.floor(timeoutMs / candidatesLeft));
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(`${WIKTIONARY_ENDPOINT}${encodeURIComponent(candidate)}`, {
        headers: {
          Accept: 'application/json',
          'Api-User-Agent': 'PaperLex/0.1 (personal academic vocabulary application)',
        },
        signal: requestSignal(signal, candidateBudget),
      });
      timeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt));

      if (response.status === 404) continue;
      if (!response.ok) {
        lastReason = `wiktionary_http_${response.status || 'error'}`;
        continue;
      }

      const payload = await readBoundedJson(response);
      const dictionary = mapWiktionaryPayload(payload, candidate);
      if (dictionary) return { status: 'complete', dictionary };
    } catch (error) {
      if (signal?.aborted) return abortedResult();
      lastReason = `wiktionary_${classifyFailure(error)}`;
      timeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    }
  }

  return lastReason
    ? { status: 'unavailable', dictionary: null, reason: lastReason }
    : { status: 'not_found', dictionary: null };
}

export function mapDictionaryPayload(payload) {
  if (!Array.isArray(payload) || !payload.length) return null;
  const entries = payload.slice(0, 3);
  const first = entries[0] || {};
  const phonetics = entries.flatMap((entry) => Array.isArray(entry.phonetics) ? entry.phonetics : []);
  const phonetic = first.phonetic || phonetics.find((item) => item?.text)?.text || '';
  const audioCandidate = phonetics.find((item) => item?.audio)?.audio || '';
  const audioUrl = audioCandidate.startsWith('//') ? `https:${audioCandidate}` : audioCandidate;
  const meanings = [];

  for (const entry of entries) {
    for (const meaning of Array.isArray(entry.meanings) ? entry.meanings : []) {
      const definitions = (Array.isArray(meaning.definitions) ? meaning.definitions : [])
        .filter((item) => item?.definition)
        .slice(0, 3)
        .map((item) => ({
          definition: boundedText(item.definition, 2_000),
          example: boundedText(item.example, 2_000),
          synonyms: (Array.isArray(item.synonyms) ? item.synonyms : []).slice(0, 8).map((value) => boundedText(value, 120)).filter(Boolean),
        }));
      if (definitions.length) {
        meanings.push({
          partOfSpeech: boundedText(meaning.partOfSpeech, 80),
          definitions,
        });
      }
      if (meanings.length >= 6) break;
    }
    if (meanings.length >= 6) break;
  }

  if (!meanings.length) return null;
  return {
    source: 'Free Dictionary API',
    sourceUrl: 'https://dictionaryapi.dev/',
    phonetic: boundedText(phonetic, 200),
    audioUrl: /^https:\/\//.test(audioUrl) ? audioUrl : '',
    origin: boundedText(first.origin, 2_000),
    meanings,
  };
}

export function mapWiktionaryPayload(payload, term) {
  const entries = Array.isArray(payload?.en) ? payload.en : [];
  const meanings = [];

  for (const entry of entries) {
    const definitions = [];
    for (const item of Array.isArray(entry?.definitions) ? entry.definitions : []) {
      const definition = htmlToText(item?.definition).slice(0, 2_000);
      if (!definition) continue;
      const parsedExamples = Array.isArray(item?.parsedExamples) ? item.parsedExamples : [];
      const rawExamples = Array.isArray(item?.examples) ? item.examples : [];
      const example = htmlToText(parsedExamples[0]?.example || rawExamples[0] || '').slice(0, 2_000);
      definitions.push({ definition, example, synonyms: [] });
      if (definitions.length === 3) break;
    }
    if (definitions.length) {
      meanings.push({
        partOfSpeech: boundedText(entry?.partOfSpeech, 80).toLocaleLowerCase('en'),
        definitions,
      });
    }
    if (meanings.length === 6) break;
  }

  if (!meanings.length) return null;
  const canonicalTerm = String(term || '').trim().replace(/\s+/gu, '_');
  return {
    source: 'Wiktionary',
    sourceUrl: `https://en.wiktionary.org/wiki/${encodeURIComponent(canonicalTerm)}`,
    license: 'CC BY-SA 4.0',
    licenseUrl: WIKTIONARY_LICENSE_URL,
    adaptationNotice: 'HTML表記をPaperLexで読みやすく整形',
    phonetic: '',
    audioUrl: '',
    origin: '',
    meanings,
  };
}

function wiktionaryCandidates(term) {
  const raw = String(term || '').trim();
  const spaced = raw.replace(/[-‐‑–—]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return [...new Set([raw, spaced].filter(Boolean))];
}

function htmlToText(value) {
  return decodeHtmlEntities(String(value ?? '')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/giu, ' ')
    .replace(/<br\s*\/?\s*>/giu, ' ')
    .replace(/<[^>]*>/gu, ' '))
    .replace(/\s+/gu, ' ')
    .trim();
}

function decodeHtmlEntities(value) {
  const named = new Map([
    ['amp', '&'],
    ['apos', "'"],
    ['gt', '>'],
    ['lt', '<'],
    ['nbsp', ' '],
    ['quot', '"'],
  ]);
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (entity, decimal, hexadecimal, name) => {
    if (name) return named.get(name.toLocaleLowerCase('en')) ?? entity;
    const codePoint = Number.parseInt(decimal || hexadecimal, hexadecimal ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
      return entity;
    }
    return String.fromCodePoint(codePoint);
  });
}

async function readBoundedJson(response) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw responseTooLargeError();
  }
  if (typeof response.text !== 'function') return response.json();
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw responseTooLargeError();
  return JSON.parse(body);
}

function requestSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(clampTimeout(timeoutMs));
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function clampTimeout(value) {
  return Math.max(1, Math.min(60_000, Math.trunc(Number(value) || 8_000)));
}

function boundedText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function responseTooLargeError() {
  const error = new Error('Dictionary response is too large');
  error.code = 'RESPONSE_TOO_LARGE';
  return error;
}

function classifyFailure(error) {
  if (error?.code === 'RESPONSE_TOO_LARGE') return 'response_too_large';
  if (error?.name === 'TimeoutError') return 'timeout';
  if (error instanceof SyntaxError) return 'invalid_json';
  return 'network_error';
}

function abortedResult() {
  return { status: 'aborted', dictionary: null, reason: 'aborted' };
}
