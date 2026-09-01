const FREE_DICTIONARY_ENDPOINT = "https://api.dictionaryapi.dev/api/v2/entries/en/";
const WIKTIONARY_ENDPOINT = "https://en.wiktionary.org/api/rest_v1/page/definition/";
const WIKTIONARY_LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";
const TATOEBA_ENDPOINT = "https://api.tatoeba.org/v1/sentences";
const TATOEBA_SOURCE_URL = "https://tatoeba.org/en/sentences/show/";
const DEFAULT_LICENSE = "CC BY 2.0 FR";
const MAX_RESPONSE_BYTES = 512 * 1024;

export interface DictionaryResult {
  status: "complete" | "not_found" | "unavailable" | "aborted";
  dictionary: Record<string, unknown> | null;
  reason?: string;
}

export interface ExampleResult {
  status: "complete" | "not_found" | "unavailable";
  examples: Array<Record<string, unknown>>;
}

type FetchOptions = { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal };

export async function lookupDictionary(
  term: string,
  { fetchImpl = fetch, timeoutMs = 8_000, signal }: FetchOptions = {},
): Promise<DictionaryResult> {
  if (typeof fetchImpl !== "function") return { status: "unavailable", dictionary: null, reason: "fetch_unavailable" };
  if (signal?.aborted) return abortedDictionaryResult();

  const totalBudget = clampTimeout(timeoutMs);
  const startedAt = Date.now();
  const primaryBudget = Math.max(1, Math.min(3_000, Math.floor(totalBudget * 0.45)));
  const primary = await lookupFreeDictionary(term, { fetchImpl, timeoutMs: primaryBudget, signal });
  if (primary.status === "complete" || signal?.aborted) return signal?.aborted ? abortedDictionaryResult() : primary;

  const remainingBudget = Math.max(1, totalBudget - (Date.now() - startedAt));
  const fallback = await lookupWiktionary(term, { fetchImpl, timeoutMs: remainingBudget, signal });
  if (fallback.status === "complete" || fallback.status === "not_found" || signal?.aborted) {
    return signal?.aborted ? abortedDictionaryResult() : fallback;
  }
  return {
    status: "unavailable",
    dictionary: null,
    reason: [primary.reason, fallback.reason].filter(Boolean).join("+") || "providers_unavailable",
  };
}

async function lookupFreeDictionary(term: string, options: Required<Pick<FetchOptions, "fetchImpl" | "timeoutMs">> & Pick<FetchOptions, "signal">): Promise<DictionaryResult> {
  try {
    const response = await options.fetchImpl(`${FREE_DICTIONARY_ENDPOINT}${encodeURIComponent(term)}`, {
      headers: { Accept: "application/json", "Api-User-Agent": "PaperLex/1.0 (private academic vocabulary application)" },
      signal: requestSignal(options.signal, options.timeoutMs),
    });
    if (response.status === 404) return { status: "not_found", dictionary: null };
    if (!response.ok) return { status: "unavailable", dictionary: null, reason: `free_dictionary_http_${response.status || "error"}` };
    const dictionary = mapDictionaryPayload(await readBoundedJson(response));
    return dictionary ? { status: "complete", dictionary } : { status: "not_found", dictionary: null };
  } catch (error) {
    if (options.signal?.aborted) return abortedDictionaryResult();
    return { status: "unavailable", dictionary: null, reason: `free_dictionary_${classifyFailure(error)}` };
  }
}

async function lookupWiktionary(term: string, options: Required<Pick<FetchOptions, "fetchImpl" | "timeoutMs">> & Pick<FetchOptions, "signal">): Promise<DictionaryResult> {
  const candidates = wiktionaryCandidates(term);
  let lastReason = "";
  let remainingMs = options.timeoutMs;
  for (const [index, candidate] of candidates.entries()) {
    if (options.signal?.aborted) return abortedDictionaryResult();
    const candidateBudget = Math.max(1, Math.floor(remainingMs / (candidates.length - index)));
    const startedAt = Date.now();
    try {
      const response = await options.fetchImpl(`${WIKTIONARY_ENDPOINT}${encodeURIComponent(candidate)}`, {
        headers: { Accept: "application/json", "Api-User-Agent": "PaperLex/1.0 (private academic vocabulary application)" },
        signal: requestSignal(options.signal, candidateBudget),
      });
      remainingMs = Math.max(1, remainingMs - (Date.now() - startedAt));
      if (response.status === 404) continue;
      if (!response.ok) {
        lastReason = `wiktionary_http_${response.status || "error"}`;
        continue;
      }
      const dictionary = mapWiktionaryPayload(await readBoundedJson(response), candidate);
      if (dictionary) return { status: "complete", dictionary };
    } catch (error) {
      if (options.signal?.aborted) return abortedDictionaryResult();
      lastReason = `wiktionary_${classifyFailure(error)}`;
      remainingMs = Math.max(1, remainingMs - (Date.now() - startedAt));
    }
  }
  return lastReason
    ? { status: "unavailable", dictionary: null, reason: lastReason }
    : { status: "not_found", dictionary: null };
}

export function mapDictionaryPayload(payload: unknown): Record<string, unknown> | null {
  if (!Array.isArray(payload) || !payload.length) return null;
  const entries = payload.slice(0, 3) as Array<Record<string, unknown>>;
  const first = entries[0] || {};
  const phonetics = entries.flatMap((entry) => Array.isArray(entry.phonetics) ? entry.phonetics : []) as Array<Record<string, unknown>>;
  const phonetic = first.phonetic || phonetics.find((item) => item?.text)?.text || "";
  const audioCandidate = String(phonetics.find((item) => item?.audio)?.audio || "");
  const audioUrl = audioCandidate.startsWith("//") ? `https:${audioCandidate}` : audioCandidate;
  const meanings: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    for (const meaning of Array.isArray(entry.meanings) ? entry.meanings as Array<Record<string, unknown>> : []) {
      const definitions = (Array.isArray(meaning.definitions) ? meaning.definitions as Array<Record<string, unknown>> : [])
        .filter((item) => item?.definition)
        .slice(0, 3)
        .map((item) => ({
          definition: boundedText(item.definition, 2_000),
          example: boundedText(item.example, 2_000),
          synonyms: (Array.isArray(item.synonyms) ? item.synonyms : []).slice(0, 8).map((value) => boundedText(value, 120)).filter(Boolean),
        }));
      if (definitions.length) meanings.push({ partOfSpeech: boundedText(meaning.partOfSpeech, 80), definitions });
      if (meanings.length >= 6) break;
    }
    if (meanings.length >= 6) break;
  }
  if (!meanings.length) return null;
  return {
    source: "Free Dictionary API",
    sourceUrl: "https://dictionaryapi.dev/",
    phonetic: boundedText(phonetic, 200),
    audioUrl: /^https:\/\//.test(audioUrl) ? audioUrl : "",
    origin: boundedText(first.origin, 2_000),
    meanings,
  };
}

export function mapWiktionaryPayload(payload: unknown, term: string): Record<string, unknown> | null {
  const payloadObject = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const entries = Array.isArray(payloadObject.en) ? payloadObject.en as Array<Record<string, unknown>> : [];
  const meanings: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const definitions: Array<Record<string, unknown>> = [];
    for (const item of Array.isArray(entry.definitions) ? entry.definitions as Array<Record<string, unknown>> : []) {
      const definition = htmlToText(item.definition).slice(0, 2_000);
      if (!definition) continue;
      const parsedExamples = Array.isArray(item.parsedExamples) ? item.parsedExamples as Array<Record<string, unknown>> : [];
      const rawExamples = Array.isArray(item.examples) ? item.examples : [];
      const example = htmlToText(parsedExamples[0]?.example || rawExamples[0] || "").slice(0, 2_000);
      definitions.push({ definition, example, synonyms: [] });
      if (definitions.length === 3) break;
    }
    if (definitions.length) meanings.push({ partOfSpeech: boundedText(entry.partOfSpeech, 80).toLocaleLowerCase("en"), definitions });
    if (meanings.length === 6) break;
  }
  if (!meanings.length) return null;
  const canonicalTerm = String(term || "").trim().replace(/\s+/gu, "_");
  return {
    source: "Wiktionary",
    sourceUrl: `https://en.wiktionary.org/wiki/${encodeURIComponent(canonicalTerm)}`,
    license: "CC BY-SA 4.0",
    licenseUrl: WIKTIONARY_LICENSE_URL,
    adaptationNotice: "HTML表記をPaperLexで読みやすく整形",
    phonetic: "",
    audioUrl: "",
    origin: "",
    meanings,
  };
}

export async function lookupExamples(
  term: string,
  { fetchImpl = fetch, timeoutMs = 5_000, signal }: FetchOptions = {},
): Promise<ExampleResult> {
  const query = new URLSearchParams({ lang: "eng", q: term, sort: "relevance", "showtrans:lang": "jpn", limit: "3" });
  try {
    const response = await fetchImpl(`${TATOEBA_ENDPOINT}?${query}`, {
      headers: { Accept: "application/json", "User-Agent": "PaperLex/1.0" },
      signal: requestSignal(signal, timeoutMs),
    });
    if (response.status === 404) return { status: "not_found", examples: [] };
    if (!response.ok) return { status: "unavailable", examples: [] };
    const examples = mapTatoebaPayload(await readBoundedJson(response));
    return examples.length ? { status: "complete", examples } : { status: "not_found", examples: [] };
  } catch {
    return { status: "unavailable", examples: [] };
  }
}

export function mapTatoebaPayload(payload: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray((payload as { data?: unknown })?.data) ? (payload as { data: Array<Record<string, unknown>> }).data : [];
  const examples: Array<Record<string, unknown>> = [];
  const seenTexts = new Set<string>();
  for (const row of rows) {
    const id = row.id;
    const text = boundedText(row.text, 1_000);
    const author = boundedText(row.owner, 100);
    if (row.lang !== "eng" || row.is_unapproved === true || !Number.isSafeInteger(id) || Number(id) <= 0 || !text || !author || seenTexts.has(text)) continue;
    seenTexts.add(text);
    const japanese = flattenTranslations(row.translations).find((translation) =>
      translation?.lang === "jpn" && translation?.is_unapproved !== true && Number.isSafeInteger(translation?.id)
      && Number(translation.id) > 0 && boundedText(translation?.text, 1_000) && boundedText(translation?.owner, 100));
    examples.push({
      text,
      translation: japanese ? boundedText(japanese.text, 1_000) : "",
      source: "Tatoeba",
      sourceUrl: `${TATOEBA_SOURCE_URL}${id}`,
      author,
      license: boundedText(row.license, 80) || DEFAULT_LICENSE,
      translationSourceUrl: japanese ? `${TATOEBA_SOURCE_URL}${japanese.id}` : "",
      translationAuthor: japanese ? boundedText(japanese.owner, 100) : "",
      translationLicense: japanese ? boundedText(japanese.license, 80) || DEFAULT_LICENSE : "",
    });
    if (examples.length === 3) break;
  }
  return examples;
}

function wiktionaryCandidates(term: string): string[] {
  const raw = String(term || "").trim();
  const spaced = raw.replace(/[-‐‑–—]+/gu, " ").replace(/\s+/gu, " ").trim();
  return [...new Set([raw, spaced].filter(Boolean))];
}

function htmlToText(value: unknown): string {
  return decodeHtmlEntities(String(value ?? "")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/giu, " ")
    .replace(/<br\s*\/?\s*>/giu, " ")
    .replace(/<[^>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const named = new Map([["amp", "&"], ["apos", "'"], ["gt", ">"], ["lt", "<"], ["nbsp", " "], ["quot", '"']]);
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (entity, decimal, hexadecimal, name) => {
    if (name) return named.get(name.toLocaleLowerCase("en")) ?? entity;
    const codePoint = Number.parseInt(decimal || hexadecimal, hexadecimal ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) return entity;
    return String.fromCodePoint(codePoint);
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw responseTooLargeError();
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw responseTooLargeError();
  return JSON.parse(body);
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(clampTimeout(timeoutMs));
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function clampTimeout(value: number): number {
  return Math.max(1, Math.min(60_000, Math.trunc(Number(value) || 8_000)));
}

function flattenTranslations(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => Array.isArray(item) ? flattenTranslations(item) : [item as Record<string, unknown>]);
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function responseTooLargeError(): Error & { code?: string } {
  const error: Error & { code?: string } = new Error("Dictionary response is too large");
  error.code = "RESPONSE_TOO_LARGE";
  return error;
}

function classifyFailure(error: unknown): string {
  const candidate = error as { code?: string; name?: string };
  if (candidate?.code === "RESPONSE_TOO_LARGE") return "response_too_large";
  if (candidate?.name === "TimeoutError") return "timeout";
  if (error instanceof SyntaxError) return "invalid_json";
  return "network_error";
}

function abortedDictionaryResult(): DictionaryResult {
  return { status: "aborted", dictionary: null, reason: "aborted" };
}
