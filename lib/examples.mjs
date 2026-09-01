const ENDPOINT = 'https://api.tatoeba.org/v1/sentences';
const SOURCE_URL = 'https://tatoeba.org/en/sentences/show/';
const DEFAULT_LICENSE = 'CC BY 2.0 FR';
const MAX_RESPONSE_BYTES = 512 * 1024;

export async function lookupExamples(term, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { status: 'unavailable', examples: [], reason: 'fetch_unavailable' };
  }

  const query = new URLSearchParams({
    lang: 'eng',
    q: String(term || '').trim(),
    sort: 'relevance',
    'showtrans:lang': 'jpn',
    limit: '3',
  });
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    const response = await fetchImpl(`${ENDPOINT}?${query}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'PaperLex/0.1',
      },
      signal: requestSignal,
    });

    if (response.status === 404) return { status: 'not_found', examples: [] };
    if (!response.ok) {
      return { status: 'unavailable', examples: [], reason: `http_${response.status || 'error'}` };
    }

    const payload = await readBoundedJson(response);
    if (!Array.isArray(payload?.data)) {
      return { status: 'unavailable', examples: [], reason: 'invalid_payload' };
    }
    const examples = mapTatoebaPayload(payload);
    return examples.length
      ? { status: 'complete', examples }
      : { status: 'not_found', examples: [] };
  } catch (error) {
    if (signal?.aborted) return { status: 'aborted', examples: [], reason: 'aborted' };
    return { status: 'unavailable', examples: [], reason: classifyFailure(error) };
  }
}

export function mapTatoebaPayload(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const examples = [];
  const seenTexts = new Set();

  for (const row of rows) {
    const id = row?.id;
    const text = boundedText(row?.text, 1_000);
    const author = boundedText(row?.owner, 100);
    if (
      row?.lang !== 'eng'
      || row?.is_unapproved === true
      || !Number.isSafeInteger(id)
      || id <= 0
      || !text
      || !author
      || seenTexts.has(text)
    ) {
      continue;
    }

    seenTexts.add(text);
    const japanese = flattenTranslations(row.translations)
      .find((translation) => translation?.lang === 'jpn'
        && translation?.is_unapproved !== true
        && Number.isSafeInteger(translation?.id)
        && translation.id > 0
        && boundedText(translation?.text, 1_000)
        && boundedText(translation?.owner, 100));

    examples.push({
      text,
      translation: japanese ? boundedText(japanese.text, 1_000) : '',
      source: 'Tatoeba',
      sourceUrl: `${SOURCE_URL}${id}`,
      author,
      license: boundedText(row.license, 80) || DEFAULT_LICENSE,
      translationSourceUrl: japanese ? `${SOURCE_URL}${japanese.id}` : '',
      translationAuthor: japanese ? boundedText(japanese.owner, 100) : '',
      translationLicense: japanese ? boundedText(japanese.license, 80) || DEFAULT_LICENSE : '',
    });

    if (examples.length === 3) break;
  }

  return examples;
}

function flattenTranslations(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => Array.isArray(item) ? flattenTranslations(item) : [item]);
}

async function readBoundedJson(response) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw responseTooLargeError();
  }

  if (typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw responseTooLargeError();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(body));
  }

  if (typeof response.text !== 'function') return response.json();
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw responseTooLargeError();
  }
  return JSON.parse(body);
}

function boundedText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function responseTooLargeError() {
  const error = new Error('Tatoeba response is too large');
  error.code = 'RESPONSE_TOO_LARGE';
  return error;
}

function classifyFailure(error) {
  if (error?.code === 'RESPONSE_TOO_LARGE') return 'response_too_large';
  if (error?.name === 'TimeoutError') return 'timeout';
  if (error instanceof SyntaxError) return 'invalid_json';
  return 'network_error';
}
