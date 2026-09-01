import {
  appleDefinitionDetail,
  appleDefinitionPreview,
  automaticExamplesForDetail,
  partOfSpeechLabel,
} from './definition-format.js';

const CACHE_KEY = 'paperlex:last-words:v1';
const SYNC_INTERVAL_MS = 30_000;
const MAX_SYNC_RETRY_MS = 5 * 60_000;
const STATUS_LABELS = {
  new: '新着',
  learning: '学習中',
  mastered: '覚えた',
};

const state = {
  words: [],
  filter: 'all',
  search: '',
  sort: 'recent',
  offline: false,
  requiresLogin: false,
  selectedId: null,
  selectedWord: null,
  installPrompt: null,
};

const ui = {
  wordList: document.querySelector('#wordList'),
  emptyState: document.querySelector('#emptyState'),
  resultCount: document.querySelector('#resultCount'),
  searchInput: document.querySelector('#searchInput'),
  sortSelect: document.querySelector('#sortSelect'),
  filterButtons: [...document.querySelectorAll('[data-filter]')],
  totalStat: document.querySelector('#totalStat'),
  repeatStat: document.querySelector('#repeatStat'),
  learningStat: document.querySelector('#learningStat'),
  masteredStat: document.querySelector('#masteredStat'),
  offlineBanner: document.querySelector('#offlineBanner'),
  openAddButton: document.querySelector('#openAddButton'),
  emptyAddButton: document.querySelector('#emptyAddButton'),
  addDialog: document.querySelector('#addDialog'),
  addForm: document.querySelector('#addForm'),
  termInput: document.querySelector('#termInput'),
  contextInput: document.querySelector('#contextInput'),
  sourceInput: document.querySelector('#sourceInput'),
  addSubmitButton: document.querySelector('#addSubmitButton'),
  detailDialog: document.querySelector('#detailDialog'),
  detailTerm: document.querySelector('#detailTerm'),
  detailMeta: document.querySelector('#detailMeta'),
  detailPhonetic: document.querySelector('#detailPhonetic'),
  detailContent: document.querySelector('#detailContent'),
  closeDetailButton: document.querySelector('#closeDetailButton'),
  loginDialog: document.querySelector('#loginDialog'),
  loginForm: document.querySelector('#loginForm'),
  passwordInput: document.querySelector('#passwordInput'),
  loginError: document.querySelector('#loginError'),
  installButton: document.querySelector('#installButton'),
  toast: document.querySelector('#toast'),
};

let toastTimer;
let syncInFlight = null;
let lastWordsFingerprint = null;
let localMutationGeneration = 0;
let syncRetryDelay = SYNC_INTERVAL_MS;
let syncTimer = null;
let lastHandledSyncError = null;

bindEvents();
renderLoading();
initialize();

async function initialize() {
  try {
    const config = await request('/api/config');
    if (config.libraryUrl && new URLSearchParams(window.location.search).get('local') !== '1') {
      await openCanonicalLibrary(config.libraryUrl);
      return;
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    }
    state.requiresLogin = config.requiresLogin;
    await loadWords();
  } catch (error) {
    if (error instanceof AuthError) {
      showLogin();
      return;
    }
    loadCachedWords(error);
  }
}

async function openCanonicalLibrary(libraryUrl) {
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations?.() || [];
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if ('caches' in globalThis) {
      const cacheNames = await globalThis.caches.keys();
      await Promise.all(cacheNames
        .filter((name) => name.startsWith('paperlex-shell-'))
        .map((name) => globalThis.caches.delete(name)));
    }
  } catch {
    // Navigation still proceeds if browser cleanup is unavailable.
  }
  window.location.replace(libraryUrl);
}

function bindEvents() {
  ui.searchInput.addEventListener('input', () => {
    state.search = ui.searchInput.value.trim().toLocaleLowerCase('ja');
    render();
  });

  ui.sortSelect.addEventListener('change', () => {
    state.sort = ui.sortSelect.value;
    render();
  });

  for (const button of ui.filterButtons) {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      for (const candidate of ui.filterButtons) {
        candidate.classList.toggle('active', candidate === button);
      }
      render();
    });
  }

  ui.openAddButton.addEventListener('click', openAddDialog);
  ui.emptyAddButton.addEventListener('click', openAddDialog);
  ui.closeDetailButton.addEventListener('click', () => ui.detailDialog.close());

  ui.addForm.addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    await addWord();
  });

  ui.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await login();
  });

  ui.loginDialog.addEventListener('cancel', (event) => event.preventDefault());

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    ui.installButton.hidden = false;
  });

  ui.installButton.addEventListener('click', async () => {
    if (!state.installPrompt) return;
    await state.installPrompt.prompt();
    state.installPrompt = null;
    ui.installButton.hidden = true;
  });

  window.addEventListener('focus', () => refreshWords({ force: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshWords({ force: true });
  });
  window.addEventListener('online', () => refreshWords({ force: true }));
  window.addEventListener('offline', () => setOffline(true));

  scheduleSyncPoll();
}

async function loadWords() {
  return syncWords();
}

function refreshWords({ force = false } = {}) {
  if (force && syncTimer !== null) {
    window.clearTimeout(syncTimer);
    syncTimer = null;
  }
  if (document.visibilityState !== 'visible' || navigator.onLine === false) {
    scheduleSyncPoll();
    return;
  }

  syncWords({ announceCapture: true }).catch((error) => {
    if (error instanceof AuthError) {
      showLogin();
      return;
    }
    if (error === lastHandledSyncError) return;
    lastHandledSyncError = error;
    const wasOffline = state.offline;
    if (!wasOffline) {
      setOffline(true);
      showToast('同期できません。接続を確認してください。', true);
    }
    syncRetryDelay = Math.min(syncRetryDelay * 2, MAX_SYNC_RETRY_MS);
  }).finally(scheduleSyncPoll);
}

function scheduleSyncPoll() {
  if (syncTimer !== null) window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(runScheduledSync, syncRetryDelay);
}

function runScheduledSync() {
  syncTimer = null;
  if (document.visibilityState === 'visible' && navigator.onLine !== false) {
    refreshWords();
  } else {
    scheduleSyncPoll();
  }
}

async function syncWords({ announceCapture = false } = {}) {
  if (syncInFlight) return syncInFlight;
  const mutationGenerationAtStart = localMutationGeneration;

  syncInFlight = (async () => {
    const payload = await request('/api/words');
    lastHandledSyncError = null;
    syncRetryDelay = SYNC_INTERVAL_MS;
    if (state.offline) setOffline(false);
    if (mutationGenerationAtStart !== localMutationGeneration) return;

    const nextWords = Array.isArray(payload.words) ? payload.words : [];
    const nextFingerprint = wordsFingerprint(nextWords);
    const changed = lastWordsFingerprint === null || wordsFingerprint(state.words) !== nextFingerprint;
    const captureDelta = changed && announceCapture && lastWordsFingerprint !== null
      ? findCaptureDelta(state.words, nextWords)
      : null;

    if (!changed) return;

    state.words = nextWords;
    lastWordsFingerprint = nextFingerprint;
    persistCache();
    render();

    if (captureDelta?.type === 'new') {
      showToast(`「${captureDelta.word.term}」を追加しました。`);
    } else if (captureDelta?.type === 'repeat') {
      showToast(`「${captureDelta.word.term}」の${captureDelta.word.encounterCount}回目を記録しました。`);
    }
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

function loadCachedWords(error) {
  const cached = safeParse(localStorage.getItem(CACHE_KEY), []);
  state.words = Array.isArray(cached) ? cached : [];
  lastWordsFingerprint = wordsFingerprint(state.words);
  setOffline(true);
  render();
  if (!state.words.length) showToast(error?.message || 'サーバーに接続できません。', true);
}

function wordsFingerprint(words) {
  return JSON.stringify(words);
}

function findCaptureDelta(previousWords, nextWords) {
  const previousById = new Map(previousWords.map((word) => [word.id, word]));
  const deltas = [];

  for (const word of nextWords) {
    const previous = previousById.get(word.id);
    if (!previous) {
      deltas.push({ type: 'new', word });
    } else if (Number(word.encounterCount) > Number(previous.encounterCount)) {
      deltas.push({ type: 'repeat', word });
    }
  }

  return deltas.sort((left, right) => {
    const leftTime = Date.parse(left.word.lastSeenAt || left.word.updatedAt || left.word.createdAt) || 0;
    const rightTime = Date.parse(right.word.lastSeenAt || right.word.updatedAt || right.word.createdAt) || 0;
    return rightTime - leftTime;
  })[0] || null;
}

function setOffline(value) {
  state.offline = value;
  ui.offlineBanner.hidden = !value;
  if (ui.detailDialog.open && state.selectedWord?.id === state.selectedId) {
    renderDetail(state.selectedWord);
  }
}

function renderLoading() {
  ui.wordList.replaceChildren(...Array.from({ length: 4 }, () => element('div', 'loading-card')));
  ui.wordList.setAttribute('aria-busy', 'true');
}

function render() {
  const words = filteredWords();
  ui.wordList.setAttribute('aria-busy', 'false');
  ui.wordList.replaceChildren(...words.map(wordCard));
  ui.wordList.hidden = words.length === 0;
  ui.emptyState.hidden = words.length !== 0;
  ui.resultCount.textContent = state.words.length === words.length
    ? `${words.length}語`
    : `${state.words.length}語中 ${words.length}語`;

  ui.totalStat.textContent = String(state.words.length);
  ui.repeatStat.textContent = String(state.words.filter((word) => word.encounterCount > 1).length);
  ui.learningStat.textContent = String(state.words.filter((word) => word.status === 'learning').length);
  ui.masteredStat.textContent = String(state.words.filter((word) => word.status === 'mastered').length);
}

function filteredWords() {
  const search = state.search;
  const filtered = state.words.filter((word) => {
    if (state.filter === 'repeated' && word.encounterCount < 2) return false;
    if (!['all', 'repeated'].includes(state.filter) && word.status !== state.filter) return false;
    if (!search) return true;
    return searchableText(word).includes(search);
  });

  return filtered.sort((left, right) => {
    if (state.sort === 'oldest') return compareDate(left.createdAt, right.createdAt);
    if (state.sort === 'az') return compareTerm(left, right);
    if (state.sort === 'za') return compareTerm(right, left);
    if (state.sort === 'seen') return compareDate(right.lastSeenAt, left.lastSeenAt);
    if (state.sort === 'frequency') {
      return right.encounterCount - left.encounterCount || compareTerm(left, right);
    }
    return compareDate(right.createdAt, left.createdAt);
  });
}

function wordCard(word) {
  const card = element('article', 'word-card');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${word.term}の詳細を開く`);
  card.addEventListener('click', () => openDetail(word.id));
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openDetail(word.id);
    }
  });

  const top = element('div', 'word-card-top');
  const titleWrap = element('div', 'word-title-wrap');
  titleWrap.append(
    element('h3', 'word-title', word.term),
    element('p', 'word-phonetic', word.dictionary?.phonetic || '\u00a0'),
  );
  top.append(titleWrap, statusBadge(word.status));

  const definition = element('p', 'word-definition', bestDefinition(word));
  const footer = element('div', 'word-card-footer');
  const meta = element('span', 'word-meta');
  if (word.encounterCount > 1) {
    meta.append(element('span', 'repeat-badge', `↻ ${word.encounterCount}回`));
  } else {
    meta.append(element('span', 'source-badge', sourceLabel(word)));
  }
  const date = element('time', '', formatDate(word.lastSeenAt));
  date.dateTime = word.lastSeenAt;
  footer.append(meta, date);
  card.append(top, definition, footer);
  return card;
}

function statusBadge(status) {
  return element('span', `status-badge ${status}`, STATUS_LABELS[status] || STATUS_LABELS.new);
}

async function openDetail(id) {
  state.selectedId = id;
  const cachedWord = state.words.find((word) => word.id === id);
  if (cachedWord) renderDetail(cachedWord);
  ui.detailDialog.showModal();

  if (state.offline) return;
  try {
    const payload = await request(`/api/words/${id}`);
    if (state.selectedId === id) renderDetail(payload.word);
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderDetail(word, { preserveScroll = ui.detailDialog.open } = {}) {
  const scrollContainer = ui.detailContent.closest('.dialog-card');
  const previousScrollTop = preserveScroll ? scrollContainer?.scrollTop : null;
  state.selectedWord = word;
  ui.detailTerm.textContent = word.term;
  ui.detailMeta.textContent = `単語の詳細 · ${STATUS_LABELS[word.status] || STATUS_LABELS.new}`;
  const appleDetail = appleDefinitionDetail(word.appleDefinition);
  ui.detailPhonetic.textContent = word.dictionary?.phonetic || (appleDetail.pronunciation ? `| ${appleDetail.pronunciation} |` : '');
  ui.detailContent.replaceChildren();

  const summary = element('div', 'detail-summary');
  summary.append(
    element('span', 'detail-pill', `${word.encounterCount}回出現`),
    element('span', 'detail-pill', `${formatDate(word.createdAt)}に追加`),
    element('span', 'detail-pill', sourceLabel(word)),
  );
  if (word.dictionary?.audioUrl) {
    const audioButton = element('button', 'audio-button', '▶ 発音を聞く');
    audioButton.type = 'button';
    audioButton.addEventListener('click', () => new Audio(word.dictionary.audioUrl).play().catch(() => showToast('音声を再生できません。', true)));
    summary.append(audioButton);
  }
  ui.detailContent.append(summary);

  if (word.customMeaning || word.customExample) {
    const personal = detailSection('自分の意味', '編集可能');
    if (word.customMeaning) personal.append(element('p', 'personal-definition', word.customMeaning));
    if (word.customExample) personal.append(renderExample(word.customExample));
    ui.detailContent.append(personal);
  }

  const apple = detailSection('日本語の意味', 'Mac内蔵辞書');
  if (word.appleDefinition) {
    apple.append(renderAppleDefinition(word.appleDefinition));
  } else {
    apple.append(element('div', 'empty-definition', 'Previewから保存すると、Macで有効な辞書の定義がここに入ります。'));
  }
  ui.detailContent.append(apple);

  const automaticExamples = automaticExamplesSection(word);
  if (automaticExamples) ui.detailContent.append(automaticExamples);

  ui.detailContent.append(englishDictionarySection(word));

  ui.detailContent.append(editSection(word));

  if (Array.isArray(word.encounters) && word.encounters.length) {
    const encounters = detailSection('出会った履歴', `${word.encounters.length}件`);
    const list = element('ol', 'encounter-list');
    for (const encounter of word.encounters) {
      const item = element('li', 'encounter-item');
      const source = [encounter.sourceTitle, encounter.sourceApp].filter(Boolean).join(' · ') || '出典未設定';
      item.append(element('div', 'encounter-meta', `${formatDateTime(encounter.capturedAt)} · ${source}`));
      if (encounter.context) item.append(element('p', '', encounter.context));
      list.append(item);
    }
    encounters.append(list);
    ui.detailContent.append(encounters);
  }

  if (previousScrollTop !== null && scrollContainer) {
    requestAnimationFrame(() => {
      scrollContainer.scrollTop = previousScrollTop;
    });
  }
}

function automaticExamplesSection(word) {
  const examples = automaticExamplesForDetail(word);

  const section = detailSection('自動例文', examples.length ? `Tatoeba · ${examples.length}件` : 'Tatoeba');
  if (!examples.length) {
    const messages = {
      pending: '例文を取得しています。少し待ってから再読み込みしてください。',
      unavailable: '例文サービスに接続できませんでした。次回起動時に自動で再試行します。',
      not_found: 'この語の自動例文は見つかりませんでした。',
    };
    section.append(element(
      'div',
      'empty-definition',
      messages[word.exampleLookupStatus] || '自動例文はまだありません。自分の例文は下で追加できます。',
    ));
    if (word.exampleLookupStatus === 'unavailable' && !state.offline) {
      const retry = element('button', 'button quiet example-retry-button', '例文を再取得');
      retry.type = 'button';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        retry.textContent = '取得中…';
        try {
          const payload = await request(`/api/words/${word.id}/examples/refresh`, { method: 'POST' });
          replaceWord(payload.word);
          renderDetail(payload.word);
          render();
          if (payload.word.exampleLookupStatus === 'complete') {
            showToast('例文を取得しました。');
          } else if (payload.word.exampleLookupStatus === 'not_found') {
            showToast('この語の例文は見つかりませんでした。');
          } else {
            showToast('例文サービスに接続できませんでした。後でもう一度お試しください。', true);
          }
        } catch (error) {
          retry.disabled = false;
          retry.textContent = '例文を再取得';
          showToast(error.message, true);
        }
      });
      section.append(retry);
    }
    return section;
  }

  const list = element('ol', 'automatic-example-list');
  for (const [index, example] of examples.entries()) {
    const item = element('li', 'automatic-example-card');
    item.append(
      element('span', 'automatic-example-number', `例文 ${index + 1}`),
      element('blockquote', 'automatic-example-text', example.text),
      renderExampleAttribution(example),
    );
    if (example.translation && safeTatoebaUrl(example.translationSourceUrl)) {
      item.append(element('p', 'automatic-example-translation', example.translation));
      item.append(renderExampleAttribution({
        sourceUrl: example.translationSourceUrl,
        author: example.translationAuthor,
        license: example.translationLicense,
      }, '日本語訳をTatoebaで見る'));
    }
    list.append(item);
  }
  section.append(list);
  return section;
}

function englishDictionarySection(word) {
  const dictionary = detailSection('英語の定義', englishDictionaryStatus(word));
  if (!word.dictionary?.meanings?.length) {
    dictionary.append(element('div', 'empty-definition', englishDefinitionPlaceholder(word)));
    if (word.lookupStatus === 'unavailable' && !state.offline) {
      const retry = element('button', 'button quiet dictionary-retry-button', '英語の定義を再取得');
      retry.type = 'button';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        retry.textContent = '取得中…';
        try {
          const payload = await request(`/api/words/${word.id}/dictionary/refresh`, { method: 'POST' });
          replaceWord(payload.word);
          renderDetail(payload.word);
          render();
          if (payload.word.lookupStatus === 'complete') {
            showToast('英語の定義を取得しました。');
          } else if (payload.word.lookupStatus === 'not_found') {
            showToast('英語辞書にはこの語が見つかりませんでした。');
          } else {
            showToast('英語辞書に接続できませんでした。後でもう一度お試しください。', true);
          }
        } catch (error) {
          retry.disabled = false;
          retry.textContent = '英語の定義を再取得';
          showToast(error.message, true);
        }
      });
      dictionary.append(retry);
    }
    return dictionary;
  }

  if (word.dictionary?.origin) {
    const origin = element('p', 'etymology');
    origin.append(element('span', 'etymology-label', '語源'), document.createTextNode(word.dictionary.origin));
    dictionary.append(origin);
  }
  for (const meaning of word.dictionary.meanings) {
    const block = element('div', 'meaning-block');
    if (meaning.partOfSpeech) block.append(element('span', 'part-of-speech', partOfSpeechLabel(meaning.partOfSpeech)));
    const list = element('ol', 'definition-list');
    for (const [index, item] of (meaning.definitions || []).entries()) {
      const entry = element('li');
      entry.append(
        element('span', 'visually-hidden', `定義 ${index + 1}:`),
        element('p', 'definition-text', item.definition),
      );
      if (item.example) entry.append(renderExample(item.example));
      const synonyms = renderSynonyms(item.synonyms);
      if (synonyms) entry.append(synonyms);
      list.append(entry);
    }
    block.append(list);
    dictionary.append(block);
  }
  const attribution = dictionaryAttribution(word.dictionary);
  if (attribution) dictionary.append(attribution);
  return dictionary;
}

function dictionaryAttribution(dictionary) {
  const sourceUrl = safeDictionaryUrl(dictionary?.sourceUrl, ['dictionaryapi.dev', 'en.wiktionary.org']);
  const licenseUrl = safeDictionaryUrl(dictionary?.licenseUrl, ['creativecommons.org']);
  if (!sourceUrl && !licenseUrl && !dictionary?.adaptationNotice) return null;

  const attribution = element('p', 'dictionary-attribution');
  if (sourceUrl) {
    const source = element('a', '', dictionary.source || '辞書の出典');
    source.href = sourceUrl;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    attribution.append(source);
  } else if (dictionary?.source) {
    attribution.append(document.createTextNode(dictionary.source));
  }
  if (licenseUrl && dictionary?.license) {
    if (attribution.childNodes.length) attribution.append(document.createTextNode(' · '));
    const license = element('a', '', dictionary.license);
    license.href = licenseUrl;
    license.target = '_blank';
    license.rel = 'noopener noreferrer';
    attribution.append(license);
  }
  if (dictionary?.adaptationNotice) {
    if (attribution.childNodes.length) attribution.append(document.createTextNode(' · '));
    attribution.append(document.createTextNode(dictionary.adaptationNotice));
  }
  return attribution;
}

function safeDictionaryUrl(value, allowedHosts) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && allowedHosts.includes(url.hostname) ? url.href : '';
  } catch {
    return '';
  }
}

function renderExampleAttribution(example, linkText = 'Tatoebaで見る') {
  const attribution = element('p', 'example-attribution');
  const sourceUrl = safeTatoebaUrl(example.sourceUrl);
  if (sourceUrl) {
    const link = element('a', 'example-source-link', linkText);
    link.href = sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    attribution.append(link);
  } else {
    attribution.append(element('span', '', 'Tatoeba'));
  }

  if (example.author) attribution.append(document.createTextNode(` · 投稿: ${example.author}`));
  if (example.license) {
    attribution.append(document.createTextNode(' · '));
    const licenseUrl = exampleLicenseUrl(example.license);
    if (licenseUrl) {
      const license = element('a', 'example-license-link', example.license);
      license.href = licenseUrl;
      license.target = '_blank';
      license.rel = 'noopener noreferrer';
      attribution.append(license);
    } else {
      attribution.append(element('span', '', example.license));
    }
  }
  return attribution;
}

function englishDictionaryStatus(word) {
  if (word.dictionary?.meanings?.length) return word.dictionary.source || 'Free Dictionary API';
  if (word.lookupStatus === 'pending') return '取得中';
  if (word.lookupStatus === 'unavailable') return '接続できませんでした';
  if (word.lookupStatus === 'not_found') return '見つかりませんでした';
  return word.dictionary?.source || '英語辞書';
}

function englishDefinitionPlaceholder(word) {
  if (word.lookupStatus === 'pending') {
    return '英語の定義を取得中です。しばらくしてから再度開くと表示されます。';
  }
  if (word.lookupStatus === 'unavailable') {
    return '英語の定義に接続できませんでした。次回起動時に自動で再試行されます。';
  }
  if (word.lookupStatus === 'not_found') {
    return 'この語の英語の定義は見つかりませんでした。';
  }
  return '英語の定義はまだありません。';
}

function safeTatoebaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && ['tatoeba.org', 'www.tatoeba.org'].includes(url.hostname)
      && /^\/en\/sentences\/show\/\d+$/.test(url.pathname)
      ? url.href
      : '';
  } catch {
    return '';
  }
}

function exampleLicenseUrl(value) {
  if (/^CC BY 2\.0(?: FR)?$/i.test(value)) return 'https://creativecommons.org/licenses/by/2.0/fr/';
  if (/^CC0 1\.0$/i.test(value)) return 'https://creativecommons.org/publicdomain/zero/1.0/';
  return '';
}

function renderAppleDefinition(value) {
  const parsed = appleDefinitionDetail(value);
  const wrapper = element('div', 'apple-definition');

  if (!parsed.headword && parsed.lead) wrapper.append(element('p', 'apple-definition-lead', parsed.lead));
  for (const [index, group] of parsed.groups.entries()) {
    wrapper.append(renderAppleMeaningGroup(group, { showPronunciation: index > 0 }));
  }
  if (parsed.derivatives.length) wrapper.append(renderAppleDerivatives(parsed.derivatives));

  if (parsed.reference) {
    const reference = element('div', 'dictionary-reference');
    reference.append(
      element('span', 'dictionary-reference-label', '関連語'),
      element('span', '', parsed.reference),
    );
    wrapper.append(reference);
  }

  return wrapper;
}

function renderAppleMeaningGroup(group, { showPronunciation = true } = {}) {
  const section = element('section', 'apple-meaning-group');
  const labels = [...group.partOfSpeech, ...group.usage, ...group.grammar];
  if (labels.length || (showPronunciation && group.pronunciation)) {
    const heading = element('div', 'apple-pos-heading');
    const chips = element('div', 'apple-pos-chips');
    for (const label of labels) chips.append(element('span', 'apple-pos-chip', label));
    heading.append(chips);
    if (showPronunciation && group.pronunciation) {
      heading.append(element('span', 'apple-group-pronunciation', `/ ${group.pronunciation} /`));
    }
    section.append(heading);
  }
  if (group.intro) section.append(element('p', 'apple-definition-lead', group.intro));
  if (group.senses.length) section.append(renderAppleSenseList(group));
  return section;
}

function renderAppleSenseList(group) {
  const list = element('ol', 'apple-sense-list');
  list.setAttribute('role', 'list');
  if (!group.showMarkers) list.classList.add('is-unmarked');
  for (const [index, sense] of group.senses.entries()) {
    const item = element('li', 'apple-sense-item');
    const content = element('div', 'apple-sense-content');
    appendAppleClauses(content, sense.text);
    appendAppleExamples(content, sense.examples);
    if (group.showMarkers) {
      const marker = element('span', 'apple-sense-marker', sense.displayMarker);
      marker.setAttribute('aria-hidden', 'true');
      item.append(
        element('span', 'visually-hidden', `語義 ${index + 1}:`),
        marker,
        content,
      );
    } else {
      item.classList.add('is-unmarked');
      item.append(content);
    }
    list.append(item);
  }
  return list;
}

function renderAppleDerivatives(derivatives) {
  const section = element('section', 'apple-derived-section');
  section.append(element('h4', 'apple-derived-title', '派生語'));
  const list = element('div', 'apple-derived-list');
  for (const derivative of derivatives) {
    const card = element('article', 'apple-derived-card');
    const heading = element('div', 'apple-derived-heading');
    heading.append(element('h5', 'apple-derived-headword', derivative.displayHeadword || derivative.headword));
    if (derivative.pronunciation) {
      heading.append(element('span', 'apple-derived-pronunciation', `/ ${derivative.pronunciation} /`));
    }
    card.append(heading);
    for (const group of derivative.groups) {
      card.append(renderAppleMeaningGroup(group, { showPronunciation: false }));
    }
    if (!derivative.groups.some(({ senses }) => senses.length)) {
      card.append(element('p', 'apple-derived-empty', '意味の記載はありません。'));
    }
    list.append(card);
  }
  section.append(list);
  return section;
}

function appendAppleClauses(container, value) {
  const clauses = String(value ?? '')
    .split(/\s*[;；]\s*/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    container.append(element('p', 'apple-sense-text', clause));
  }
}

function appendAppleExamples(container, examples) {
  if (!Array.isArray(examples) || !examples.length) return;
  const list = element('ul', 'apple-example-list');
  for (const example of examples) {
    const item = element('li', 'apple-example');
    item.append(
      element('span', 'apple-example-label', '用例'),
      element('span', '', example),
    );
    list.append(item);
  }
  container.append(list);
}

function renderExample(value) {
  const example = element('div', 'example');
  example.append(
    element('span', 'example-label', '例文'),
    element('q', 'example-text', value),
  );
  return example;
}

function renderSynonyms(values) {
  const synonyms = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value).trim())
    .filter(Boolean))];
  if (!synonyms.length) return null;

  const row = element('div', 'synonym-row');
  row.append(element('span', 'synonym-label', '類義語'));
  const list = element('ul', 'synonym-list');
  for (const synonym of synonyms) list.append(element('li', 'synonym-chip', synonym));
  row.append(list);
  return row;
}

function editSection(word) {
  const section = detailSection('自分用に整える', 'いつでも編集可能');
  if (state.offline) {
    section.append(element('div', 'empty-definition', 'オフライン中は閲覧のみ利用できます。接続が戻ると編集できます。'));
    return section;
  }
  const form = element('form', 'detail-form-grid');

  const status = fieldWithSelect('復習状態', 'status', [
    ['new', '新着'],
    ['learning', '学習中'],
    ['mastered', '覚えた'],
  ], word.status);
  const tags = fieldWithInput('タグ（カンマ区切り）', 'tags', word.tags?.join(', ') || '');
  const meaning = fieldWithTextarea('自分の意味', 'customMeaning', word.customMeaning || '', 3, 'wide');
  const example = fieldWithTextarea('自分の例文', 'customExample', word.customExample || '', 2, 'wide');
  const notes = fieldWithTextarea('メモ', 'notes', word.notes || '', 3, 'wide');
  form.append(status, tags, meaning, example, notes);

  const footer = element('div', 'detail-footer wide');
  const deleteButton = element('button', 'button danger', '単語を削除');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteWord(word));
  const actions = element('div');
  const close = element('button', 'button quiet', '閉じる');
  close.type = 'button';
  close.addEventListener('click', () => ui.detailDialog.close());
  const save = element('button', 'button primary', '変更を保存');
  save.type = 'submit';
  actions.append(close, save);
  footer.append(deleteButton, actions);
  form.append(footer);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    const data = new FormData(form);
    try {
      const payload = await request(`/api/words/${word.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: data.get('status'),
          tags: String(data.get('tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean),
          customMeaning: data.get('customMeaning'),
          customExample: data.get('customExample'),
          notes: data.get('notes'),
        }),
      });
      replaceWord(payload.word);
      renderDetail(payload.word);
      render();
      showToast('変更を保存しました。');
    } catch (error) {
      showToast(error.message, true);
    } finally {
      save.disabled = false;
    }
  });

  section.append(form);
  return section;
}

async function addWord() {
  ui.addSubmitButton.disabled = true;
  ui.addSubmitButton.textContent = '意味・例文を取得中…';
  try {
    const payload = await request('/api/words', {
      method: 'POST',
      body: JSON.stringify({
        term: ui.termInput.value,
        context: ui.contextInput.value,
        sourceTitle: ui.sourceInput.value,
      }),
    });
    replaceWord(payload.word);
    render();
    ui.addForm.reset();
    ui.addDialog.close();
    showToast(payload.created ? `「${payload.word.term}」を保存しました。` : `再登場として ${payload.word.encounterCount}回目を記録しました。`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    ui.addSubmitButton.disabled = false;
    ui.addSubmitButton.textContent = '意味・例文を取得して保存';
  }
}

async function deleteWord(word) {
  if (!window.confirm(`「${word.term}」とその履歴を削除しますか？`)) return;
  try {
    await request(`/api/words/${word.id}`, { method: 'DELETE' });
    state.words = state.words.filter((candidate) => candidate.id !== word.id);
    commitLocalWordsMutation();
    ui.detailDialog.close();
    render();
    showToast(`「${word.term}」を削除しました。`);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function login() {
  ui.loginError.textContent = '';
  const submit = ui.loginForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await request('/api/session', {
      method: 'POST',
      body: JSON.stringify({ password: ui.passwordInput.value }),
      allowUnauthorized: true,
    });
    ui.passwordInput.value = '';
    ui.loginDialog.close();
    await loadWords();
  } catch (error) {
    ui.loginError.textContent = error.message;
    ui.passwordInput.select();
  } finally {
    submit.disabled = false;
  }
}

function showLogin() {
  if (!ui.loginDialog.open) ui.loginDialog.showModal();
  setTimeout(() => ui.passwordInput.focus(), 0);
}

function openAddDialog() {
  if (state.offline) {
    showToast('オフライン中は追加できません。', true);
    return;
  }
  ui.addDialog.showModal();
  setTimeout(() => ui.termInput.focus(), 0);
}

function replaceWord(word) {
  const index = state.words.findIndex((candidate) => candidate.id === word.id);
  if (index >= 0) state.words.splice(index, 1, word);
  else state.words.unshift(word);
  commitLocalWordsMutation();
}

function commitLocalWordsMutation() {
  localMutationGeneration += 1;
  lastWordsFingerprint = wordsFingerprint(state.words);
  persistCache();
}

function persistCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(state.words));
    return true;
  } catch {
    return false;
  }
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set('Content-Type', 'application/json');
  let response;
  try {
    response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  } catch {
    throw new Error('サーバーに接続できません。');
  }

  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && !options.allowUnauthorized) throw new AuthError(payload.error);
  if (!response.ok) throw new Error(payload.error || `リクエストに失敗しました (${response.status})`);
  return payload;
}

class AuthError extends Error {}

function bestDefinition(word) {
  if (word.customMeaning) return word.customMeaning;
  if (word.appleDefinition) {
    const preview = appleDefinitionPreview(word.appleDefinition);
    if (preview) return preview;
  }
  const definition = word.dictionary?.meanings?.[0]?.definitions?.[0]?.definition;
  if (definition) return definition;
  const automaticExample = Array.isArray(word.examples) ? word.examples[0]?.text : '';
  if (automaticExample) return `例文: ${automaticExample}`;
  if (word.lookupStatus === 'unavailable') return '辞書に接続できませんでした。意味は後から追加できます。';
  return '辞書にない語です。自分の意味を追加できます。';
}

function sourceLabel(word) {
  if (word.customMeaning) return '自分の意味';
  if (word.appleDefinition) return '日本語の意味';
  if (word.dictionary) return '英語の定義';
  if (Array.isArray(word.examples) && word.examples.length) return '自動例文あり';
  return '意味未設定';
}

function searchableText(word) {
  const definitions = word.dictionary?.meanings
    ?.flatMap((meaning) => meaning.definitions || [])
    .flatMap((entry) => [entry.definition, entry.example, ...(entry.synonyms || [])]) || [];
  const examples = (Array.isArray(word.examples) ? word.examples : [])
    .flatMap((example) => [example.text, example.translation]);
  return [
    word.term,
    word.appleDefinition,
    word.customMeaning,
    word.customExample,
    word.notes,
    ...(word.tags || []),
    ...definitions,
    ...examples,
  ].filter(Boolean).join(' ').toLocaleLowerCase('ja');
}

function compareDate(left, right) {
  return new Date(left).getTime() - new Date(right).getTime();
}

function compareTerm(left, right) {
  return left.term.localeCompare(right.term, 'en', { sensitivity: 'base' });
}

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric' }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function detailSection(title, source = '') {
  const section = element('section', 'detail-section');
  const heading = element('h3', 'section-title');
  heading.append(element('span', '', title));
  if (source) heading.append(element('small', 'dictionary-source', source));
  section.append(heading);
  return section;
}

function fieldWithInput(labelText, name, value) {
  const label = element('label', 'field');
  const input = element('input');
  input.name = name;
  input.value = value;
  label.append(element('span', '', labelText), input);
  return label;
}

function fieldWithTextarea(labelText, name, value, rows, className = '') {
  const label = element('label', `field ${className}`.trim());
  const textarea = element('textarea');
  textarea.name = name;
  textarea.rows = rows;
  textarea.value = value;
  label.append(element('span', '', labelText), textarea);
  return label;
}

function fieldWithSelect(labelText, name, options, selected) {
  const label = element('label', 'field');
  const select = element('select');
  select.name = name;
  for (const [value, text] of options) {
    const option = element('option', '', text);
    option.value = value;
    option.selected = value === selected;
    select.append(option);
  }
  label.append(element('span', '', labelText), select);
  return label;
}

function element(tagName, className = '', text = undefined) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function showToast(message, isError = false) {
  window.clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.classList.toggle('error', isError);
  ui.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    ui.toast.hidden = true;
  }, 3_600);
}
