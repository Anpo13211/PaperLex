import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { appleDefinitionDetail, automaticExamplesForDetail } from "../public/definition-format.js";
import { lookupDictionary, mapDictionaryPayload, mapTatoebaPayload, mapWiktionaryPayload } from "../worker/enrichment.ts";
import { handleApi, hasAuthenticatedUser, secretMatches, type Env } from "../worker/index.ts";
import { cleanTerm, normalizeTerm } from "../worker/normalize.ts";
import { D1VocabularyStore } from "../worker/store.ts";
import { SQLiteD1 } from "./sqlite-d1.ts";

const migration = fs.readFileSync(new URL("../drizzle/0000_eminent_banshee.sql", import.meta.url), "utf8");
const appSource = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const indexSources = [
  fs.readFileSync(new URL("../index.html", import.meta.url), "utf8"),
  fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8"),
];
const dictionaryLookup = async () => ({ status: "complete" as const, dictionary: { source: "fixture", phonetic: "/test/", audioUrl: "", origin: "", meanings: [{ partOfSpeech: "adjective", definitions: [{ definition: "short-lived", example: "an ephemeral cache", synonyms: [] }] }] } });
const exampleLookup = async () => ({ status: "complete" as const, examples: [{ text: "All dreams are ephemeral.", translation: "", source: "Tatoeba", sourceUrl: "https://tatoeba.org/en/sentences/show/1", author: "fixture", license: "CC BY 2.0 FR" }] });

const hostedImproveDefinition =
  "im･prove | ɪmprúːv | 動詞 他動詞1 〈人･事が〉〈物･事〉を改善する "
  + "2 〈土地･建物〉の価値を高める. 3 〈時間など〉を活用する.";
const hostedElucidateDefinition =
  "e･lu･ci･date | ɪlúːsɪdèɪt | 動詞他動詞自動詞｟かたく｠ "
  + "(〈難解な事〉を)解明する, はっきりと説明する, 明らかにする(clarify). "
  + "e･lú･ci･dà･tor | -tər | 名詞説明する人. "
  + "e･lú･ci･da･tò･ry | -dətɔ̀ːri|-dèɪt(ə)ri | 形容詞説明的な, 物事を明確にする.";
const hostedUnderscoreDefinition =
  "ùnder･scóre動詞他動詞1 …を強調する, 明白にする(｟主に英｠ underline). "
  + "2 …に下線を引く(｟主に英｠ underline). 名詞 | -́--̀ | C下線, アンダーライン.";

test("hosted detail formatting exposes the Apple pronunciation fallback", () => {
  const detail = appleDefinitionDetail(hostedImproveDefinition);

  assert.equal(detail.pronunciation, "ɪmprúːv");
});

test("hosted detail formatting exposes sequential display markers", () => {
  const detail = appleDefinitionDetail(hostedImproveDefinition);

  assert.deepEqual(detail.senses.map(({ displayMarker }: { displayMarker: string }) => displayMarker), ["1", "2", "3"]);
});

test("hosted Japanese formatting separates meanings, parts of speech and derivatives", () => {
  const elucidate = appleDefinitionDetail(hostedElucidateDefinition);
  assert.equal(elucidate.senses.length, 1);
  assert.deepEqual(elucidate.derivatives.map(({ displayHeadword }: { displayHeadword: string }) => displayHeadword), ["elucidator", "elucidatory"]);

  const underscore = appleDefinitionDetail(hostedUnderscoreDefinition);
  assert.deepEqual(underscore.groups.map(({ partOfSpeech }: { partOfSpeech: string[] }) => partOfSpeech), [["動詞", "他動詞"], ["名詞"]]);
  assert.deepEqual(underscore.groups.map(({ senses }: { senses: Array<{ text: string }> }) => senses.map(({ text }) => text)), [
    ["…を強調する, 明白にする(underline).", "…に下線を引く(underline)."],
    ["下線, アンダーライン."],
  ]);
});

test("hosted unstructured headings are rendered only once", () => {
  const dense = appleDefinitionDetail("アプリオリ ①第一の意味。②第二の意味。");
  assert.equal(dense.lead, "アプリオリ");
  assert.equal(dense.groups[0].intro, "");
});

test("hosted detail keeps automatic examples in the canonical section order", () => {
  assert.match(appSource, /ui\.detailContent\.append\(apple\)[\s\S]+automaticExamplesSection\(word\)[\s\S]+englishDictionarySection\(word\)/u);
  assert.doesNotMatch(appSource, /dictionaryHasExamples/u);
});

test("hosted detail keeps corpus examples when an English definition has its own example", () => {
  const corpusExamples = [{ text: "The result improved." }];
  const word = {
    dictionary: { meanings: [{ definitions: [{ definition: "To become better.", example: "It improved." }] }] },
    examples: corpusExamples,
  };

  assert.deepEqual(automaticExamplesForDetail(word), corpusExamples);
});

test("hosted Japanese sense list keeps explicit accessibility semantics", () => {
  assert.match(appSource, /const list = element\('ol', 'apple-sense-list'\);\s+list\.setAttribute\('role', 'list'\);/u);
  assert.match(appSource, /renderAppleDerivatives\(parsed\.derivatives\)/u);
  assert.match(appSource, /element\('h5', 'apple-derived-headword'/u);
  assert.match(appSource, /if \(group\.showMarkers\)[\s\S]+`語義 \$\{index \+ 1\}:`/u);
  assert.doesNotMatch(appSource, /sense\.label/u);
});

test("hosted add-dialog cancel controls bypass required-field validation", () => {
  for (const source of indexSources) {
    const cancelButtons = [...source.matchAll(/<button\b[^>]*\bvalue="cancel"[^>]*>/gu)].map(([tag]) => tag);
    assert.equal(cancelButtons.length, 2);
    assert.ok(cancelButtons.every((button) => /\bformnovalidate\b/u.test(button)));
    const saveButton = source.match(/<button\b[^>]*\bid="addSubmitButton"[^>]*>/u)?.[0] || "";
    assert.match(saveButton, /\btype="submit"/u);
    assert.doesNotMatch(saveButton, /\bformnovalidate\b/u);
    const termInput = source.match(/<input\b[^>]*\bid="termInput"[^>]*>/u)?.[0] || "";
    assert.match(termInput, /\brequired\b/u);
  }
});

test("normalization and provider payload mapping are compatible", () => {
  assert.equal(cleanTerm("  A\nPriori  "), "A Priori");
  assert.equal(normalizeTerm("A PRIORI"), "a priori");
  const dictionary = mapDictionaryPayload([{ phonetic: "/test/", meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "a test", example: "the test", synonyms: ["trial"] }] }] }]);
  assert.equal(dictionary?.source, "Free Dictionary API");
  const examples = mapTatoebaPayload({ data: [{ id: 7, lang: "eng", text: "A test.", owner: "alice", translations: [[{ id: 8, lang: "jpn", text: "テスト。", owner: "bob" }]] }] });
  assert.equal(examples[0].translation, "テスト。");
});

test("hosted normalization strips PDF punctuation exactly like the local edition", () => {
  // 文末で選ぶと「suffice.」になり、辞書が引けずに意味なしで保存されていた。
  assert.equal(cleanTerm("suffice."), "suffice");
  assert.equal(cleanTerm("“suffice”"), "suffice");
  assert.equal(cleanTerm("(suffice),"), "suffice");
  assert.equal(cleanTerm("suffice[12]"), "suffice");
  assert.equal(cleanTerm("suffice†"), "suffice");
  assert.equal(cleanTerm("suf\u00ADfice"), "suffice");
  assert.equal(normalizeTerm("Suffice."), "suffice");
});

test("hosted normalization keeps abbreviations, compounds and possessives intact", () => {
  assert.equal(cleanTerm("e.g."), "e.g.");
  assert.equal(cleanTerm("Ph.D."), "Ph.D.");
  assert.equal(cleanTerm("a-priori"), "a-priori");
  assert.equal(cleanTerm("state-of-the-art"), "state-of-the-art");
  assert.equal(cleanTerm("Occam's razor"), "Occam's razor");
  assert.equal(cleanTerm("C++"), "C++");
});

test("a word saved from the phone reaches the store under its cleaned term", async (context) => {
  const db = new SQLiteD1(migration);
  context.after(() => db.close());
  const store = new D1VocabularyStore(db, undefined, { dictionary: dictionaryLookup, examples: exampleLookup });

  const captured = await store.capture({ term: " “suffice.” ", sourceApp: "PaperLex web" });

  assert.equal(captured.created, true);
  assert.equal(captured.word.term, "suffice");
  const stored = await store.listWords();
  assert.deepEqual(stored.map(({ term }) => term), ["suffice"]);
});

test("dictionary falls back to attributed Wiktionary definitions and retries hyphenated terms", async () => {
  const requested: string[] = [];
  const apiUserAgents: string[] = [];
  const result = await lookupDictionary("a-priori", {
    fetchImpl: async (input, init) => {
      const url = String(input);
      requested.push(url);
      apiUserAgents.push(new Headers(init?.headers).get("Api-User-Agent") || "");
      if (url.startsWith("https://api.dictionaryapi.dev/")) return new Response("", { status: 404 });
      if (url.endsWith("/a-priori")) return new Response("", { status: 404 });
      return Response.json({ en: [{ partOfSpeech: "Adverb", definitions: [{ definition: "Known <b>independently</b> of &quot;experience&quot;.", parsedExamples: [{ example: "It is known <i>a priori</i>." }] }] }] });
    },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.dictionary?.source, "Wiktionary");
  assert.equal(result.dictionary?.license, "CC BY-SA 4.0");
  assert.equal(result.dictionary?.licenseUrl, "https://creativecommons.org/licenses/by-sa/4.0/");
  assert.equal(result.dictionary?.adaptationNotice, "HTML表記をPaperLexで読みやすく整形");
  assert.match(String(result.dictionary?.sourceUrl), /a_priori$/);
  const meanings = result.dictionary?.meanings as Array<{ definitions: Array<{ definition: string; example: string }> }>;
  assert.equal(meanings[0].definitions[0].definition, 'Known independently of "experience".');
  assert.equal(meanings[0].definitions[0].example, "It is known a priori .");
  assert.equal(requested.length, 3);
  assert.match(requested[2], /a%20priori$/);
  assert.ok(apiUserAgents.every((value) => value.startsWith("PaperLex/")));
});

test("dictionary bounds provider responses and honors an already-aborted caller", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  assert.deepEqual(await lookupDictionary("pending", {
    signal: controller.signal,
    fetchImpl: async () => { called = true; return new Response(); },
  }), { status: "aborted", dictionary: null, reason: "aborted" });
  assert.equal(called, false);

  const oversized = await lookupDictionary("large", {
    fetchImpl: async () => new Response("{}", { status: 200, headers: { "Content-Length": String(600 * 1024) } }),
  });
  assert.equal(oversized.status, "unavailable");
  assert.match(String(oversized.reason), /response_too_large/);
  assert.equal(mapWiktionaryPayload({ fr: [] }, "mot"), null);
});

test("D1 store captures, deduplicates, edits, exports and imports", async (context) => {
  const db = new SQLiteD1(migration);
  context.after(() => db.close());
  let tick = 0;
  const store = new D1VocabularyStore(db, () => new Date(Date.UTC(2026, 8, 1, 0, 0, tick++)), { dictionary: dictionaryLookup, examples: exampleLookup });
  const first = await store.capture({ term: "ephemeral", appleDefinition: "短命の", context: "ephemeral state", sourceApp: "Preview" });
  const second = await store.capture({ term: "Ephemeral", sourceApp: "Preview" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.word.encounterCount, 2);
  assert.equal(second.word.encounters?.length, 2);
  assert.equal((second.word.dictionary?.meanings as Array<{ definitions: Array<{ definition: string }> }>)[0].definitions[0].definition, "short-lived");
  assert.equal(second.word.examples[0].text, "All dreams are ephemeral.");
  const edited = await store.updateWord(first.word.id, { status: "learning", customMeaning: "一時的な", tags: ["paper"] });
  assert.equal(edited?.customMeaning, "一時的な");
  const backup = await store.exportBackup();
  const targetDb = new SQLiteD1(migration);
  context.after(() => targetDb.close());
  const target = new D1VocabularyStore(targetDb, undefined, { dictionary: dictionaryLookup, examples: exampleLookup });
  assert.deepEqual(await target.importBackup(backup), { imported: 1, encounters: 2 });
  assert.equal((await target.listWords())[0].encounterCount, 2);
});

test("browser APIs require a signed-in identity while capture and import use narrow tokens", async () => {
  const db = new SQLiteD1(migration);
  const env = {
    DB: db,
    ASSETS: { fetch: async () => new Response("asset") },
    PAPERLEX_CAPTURE_TOKEN: "capture-secret",
    PAPERLEX_IMPORT_TOKEN: "import-secret",
  } satisfies Env;
  const identitylessHeaders = { "OAI-Sites-Authorization": "Bearer identityless-fixture" };
  const identitylessConfig = await handleApi(new Request("https://paperlex.example/api/config", { headers: identitylessHeaders }), env);
  assert.equal(identitylessConfig.status, 401);
  const identitylessWords = await handleApi(new Request("https://paperlex.example/api/words", { headers: identitylessHeaders }), env);
  assert.equal(identitylessWords.status, 401);
  const config = await handleApi(new Request("https://paperlex.example/api/config", {
    headers: { "oai-authenticated-user-id": "owner-fixture" },
  }), env);
  assert.deepEqual(await config.json(), { requiresLogin: false, authentication: "private-site" });
  assert.equal(hasAuthenticatedUser(new Request("https://paperlex.example", { headers: { "oai-authenticated-user-id": "owner-fixture" } })), true);
  assert.equal(hasAuthenticatedUser(new Request("https://paperlex.example", { headers: identitylessHeaders })), false);
  const unauthorized = await handleApi(new Request("https://paperlex.example/api/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ term: "test" }) }), env);
  assert.equal(unauthorized.status, 401);
  const identitylessCapture = await handleApi(new Request("https://paperlex.example/api/capture", {
    method: "POST",
    headers: {
      ...identitylessHeaders,
      "Content-Type": "application/json",
      "X-PaperLex-Token": "capture-secret",
    },
    body: JSON.stringify({ term: "" }),
  }), env);
  assert.equal(identitylessCapture.status, 400);
  const identitylessImport = await handleApi(new Request("https://paperlex.example/api/import", {
    method: "POST",
    headers: {
      ...identitylessHeaders,
      "Content-Type": "application/json",
      "X-PaperLex-Import-Token": "import-secret",
    },
    body: JSON.stringify({ format: "paperlex-backup", version: 1, words: [] }),
  }), env);
  assert.equal(identitylessImport.status, 200);
  assert.deepEqual(await identitylessImport.json(), { imported: 0, encounters: 0 });
  const crossOrigin = await handleApi(new Request("https://paperlex.example/api/capture", { method: "POST", headers: { "Content-Type": "application/json", "X-PaperLex-Token": "capture-secret", Origin: "https://attacker.example" }, body: JSON.stringify({ term: "test" }) }), env);
  assert.equal(crossOrigin.status, 403);
  assert.equal(secretMatches("capture-secret", "capture-secret"), true);
  assert.equal(secretMatches("wrong", "capture-secret"), false);
  db.close();
});
