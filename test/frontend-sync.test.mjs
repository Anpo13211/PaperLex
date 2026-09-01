import test from 'node:test';
import assert from 'node:assert/strict';

const appUrls = [['local', new URL('../public/app.js', import.meta.url)], ['hosted', new URL('../hosted/public/app.js', import.meta.url)]];
let importSequence = 0;

class FakeEventTarget {
  listeners = new Map();
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  async emit(type, event = {}) {
    event.preventDefault ||= () => {};
    await Promise.all((this.listeners.get(type) || []).map((listener) => listener(event)));
  }
}

class FakeElement extends FakeEventTarget {
  constructor(tagName = 'div') {
    super();
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.childNodes = this.children;
    this.className = '';
    this.dataset = {};
    this.hidden = false;
    this.open = false;
    this.value = '';
    this.textContent = '';
    this.scrollTop = 0;
    this.replaceCount = 0;
    this.classList = { toggle: () => {} };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children.splice(0, this.children.length, ...children); this.replaceCount += 1; }
  setAttribute(name, value) { this[name] = String(value); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  reset() { this.value = ''; }
  focus() {}
  select() {}
  closest() { return this; }
  querySelector() { return new FakeElement('button'); }
}

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const word = (id, term, encounterCount = 1, lastSeenAt = '2026-09-01T00:00:00.000Z') => ({
  id, term, encounterCount, lastSeenAt, status: 'new', createdAt: '2026-09-01T00:00:00.000Z', tags: [], examples: [],
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

async function boot(appUrl, initialWords, { libraryUrl = '' } = {}) {
  const selectors = new Map();
  const elementFor = (selector) => {
    if (!selectors.has(selector)) selectors.set(selector, new FakeElement());
    return selectors.get(selector);
  };
  const document = new FakeEventTarget();
  Object.assign(document, {
    visibilityState: 'visible',
    querySelector: elementFor,
    querySelectorAll: () => [],
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (text) => ({ textContent: String(text) }),
  });
  const timers = [];
  let timerSequence = 0;
  const window = new FakeEventTarget();
  Object.assign(window, {
    setInterval: (callback, delay) => { timers.push({ id: ++timerSequence, callback, delay, cleared: false }); return timerSequence; },
    setTimeout: (callback, delay) => { timers.push({ id: ++timerSequence, callback, delay, cleared: false }); return timerSequence; },
    clearTimeout: (id) => { const timer = timers.find((candidate) => candidate.id === id); if (timer) timer.cleared = true; },
    confirm: () => true,
    location: { origin: 'http://paperlex.local', search: '', replace(value) { this.replaced = value; } },
  });
  const storage = new Map();
  const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const serviceWorkerEvents = { registrationsRemoved: 0, registerCalls: 0 };
  const navigator = {
    onLine: true,
    serviceWorker: {
      async getRegistrations() {
        return [{ unregister: async () => { serviceWorkerEvents.registrationsRemoved += 1; } }];
      },
      async register() { serviceWorkerEvents.registerCalls += 1; },
    },
  };
  const cacheEvents = { deleted: [] };
  const caches = {
    async keys() { return ['paperlex-shell-v5', 'unrelated-cache']; },
    async delete(name) { cacheEvents.deleted.push(name); return true; },
  };
  const requests = [];
  let getWords = async () => jsonResponse({ words: initialWords });
  let mutate = async () => jsonResponse({ error: 'unexpected mutation' }, 500);
  const fetch = async (path, options = {}) => {
    const request = { path: String(path), method: options.method || 'GET' };
    requests.push(request);
    if (request.path === '/api/config') return jsonResponse({ requiresLogin: false, libraryUrl });
    if (request.path === '/api/words' && request.method === 'GET') return getWords(request);
    return mutate(request, options);
  };
  const replacements = { document, window, navigator, caches, localStorage, fetch, requestAnimationFrame: (callback) => callback(), Audio: class { play() { return Promise.resolve(); } } };
  const previous = new Map();
  for (const [key, value] of Object.entries(replacements)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const importUrl = new URL(appUrl);
  importUrl.searchParams.set('test', String(importSequence += 1));
  await import(importUrl.href);
  if (libraryUrl) {
    await waitFor(() => window.location.replaced === libraryUrl, 'canonical library navigation');
    return {
      document, window, timers, requests, elementFor, storage, serviceWorkerEvents, cacheEvents,
      cleanup() {
        for (const [key, descriptor] of previous) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
      },
    };
  }
  await waitFor(() => requests.some(({ path }) => path === '/api/words'), 'initial words request');
  await waitFor(() => elementFor('#wordList').replaceCount >= 2, 'initial render');

  return {
    document, window, timers, requests, elementFor, storage,
    activePoll() { return timers.findLast((timer) => !timer.cleared && timer.delay >= 30_000); },
    setGetWords(handler) { getWords = handler; },
    setMutate(handler) { mutate = handler; },
    cleanup() {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    },
  };
}

test('local shell removes an existing service worker before opening the canonical cloud library', async () => {
  const libraryUrl = 'https://paperlex.example/library';
  const h = await boot(appUrls[0][1], [], { libraryUrl });
  try {
    assert.equal(h.serviceWorkerEvents.registrationsRemoved, 1);
    assert.equal(h.serviceWorkerEvents.registerCalls, 0);
    assert.deepEqual(h.cacheEvents.deleted, ['paperlex-shell-v5']);
    assert.equal(h.requests.some(({ path }) => path === '/api/words'), false);
  } finally { h.cleanup(); }
});

function defineSyncTests(label, appUrl) {
  test(`${label}: focus, visibility and interval refresh a visible library`, async () => {
    const h = await boot(appUrl, []);
    try {
      const initialGets = h.requests.filter(({ path }) => path === '/api/words').length;
      await h.window.emit('focus');
      await waitFor(() => h.requests.filter(({ path }) => path === '/api/words').length === initialGets + 1, 'focus refresh');
      await new Promise((resolve) => setImmediate(resolve));
      await h.document.emit('visibilitychange');
      await waitFor(() => h.requests.filter(({ path }) => path === '/api/words').length === initialGets + 2, 'visibility refresh');
      await new Promise((resolve) => setImmediate(resolve));
      const poll = h.activePoll();
      assert.ok(poll);
      poll.cleared = true;
      poll.callback();
      await waitFor(() => h.requests.filter(({ path }) => path === '/api/words').length === initialGets + 3, 'interval refresh');
    } finally { h.cleanup(); }
  });

  test(`${label}: overlapping refreshes share one words request`, async () => {
    const h = await boot(appUrl, []);
    try {
      const pending = deferred();
      h.setGetWords(() => pending.promise);
      const before = h.requests.length;
      await h.window.emit('focus');
      await h.window.emit('focus');
      assert.equal(h.requests.length, before + 1);
      pending.resolve(jsonResponse({ words: [] }));
      await new Promise((resolve) => setImmediate(resolve));
    } finally { h.cleanup(); }
  });

  test(`${label}: unchanged refresh does not replace the rendered list`, async () => {
    const original = word('1', 'stable');
    const h = await boot(appUrl, [original]);
    try {
      const renders = h.elementFor('#wordList').replaceCount;
      h.setGetWords(async () => jsonResponse({ words: [original] }));
      await h.window.emit('focus');
      await waitFor(() => h.requests.filter(({ path }) => path === '/api/words').length === 2, 'unchanged refresh');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(h.elementFor('#wordList').replaceCount, renders);
    } finally { h.cleanup(); }
  });

  test(`${label}: external additions and repeated captures produce a toast`, async () => {
    const original = word('1', 'repeatable');
    const added = word('2', 'newcomer', 1, '2026-09-01T00:01:00.000Z');
    const h = await boot(appUrl, [original]);
    try {
      h.setGetWords(async () => jsonResponse({ words: [added, original] }));
      await h.window.emit('focus');
      await waitFor(() => h.elementFor('#toast').textContent.includes('newcomer'), 'new-capture toast');
      assert.match(h.elementFor('#toast').textContent, /追加しました/u);
      const repeated = word('1', 'repeatable', 2, '2026-09-01T00:02:00.000Z');
      h.setGetWords(async () => jsonResponse({ words: [repeated, added] }));
      await h.window.emit('focus');
      await waitFor(() => h.elementFor('#toast').textContent.includes('repeatable'), 'repeat-capture toast');
      assert.match(h.elementFor('#toast').textContent, /2回目/u);
    } finally { h.cleanup(); }
  });

  test(`${label}: failed refresh shows offline state and backs off the interval`, async () => {
    const h = await boot(appUrl, []);
    try {
      h.setGetWords(async () => { throw new Error('network down'); });
      await h.window.emit('focus');
      await waitFor(() => h.elementFor('#offlineBanner').hidden === false, 'offline banner');
      await waitFor(() => h.activePoll()?.delay > 30_000, 'backoff timer');
      const requestsAfterFailure = h.requests.length;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(h.requests.length, requestsAfterFailure);
      assert.ok(h.activePoll().delay > 30_000);
    } finally { h.cleanup(); }
  });

  test(`${label}: stale refresh cannot overwrite a completed manual add`, async () => {
    const original = word('1', 'existing');
    const added = word('2', 'manually-added', 1, '2026-09-01T00:01:00.000Z');
    const h = await boot(appUrl, [original]);
    try {
      const stale = deferred();
      h.setGetWords(() => stale.promise);
      await h.window.emit('focus');
      h.setMutate(async ({ path, method }) => {
        assert.equal(path, '/api/words');
        assert.equal(method, 'POST');
        return jsonResponse({ created: true, word: added }, 201);
      });
      h.elementFor('#termInput').value = added.term;
      await h.elementFor('#addForm').emit('submit');
      await waitFor(() => String(h.storage.get('paperlex:last-words:v1')).includes(added.term), 'manual add');
      stale.resolve(jsonResponse({ words: [original] }));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(String(h.storage.get('paperlex:last-words:v1')), /manually-added/u);
    } finally { h.cleanup(); }
  });

  test(`${label}: cancelling a manual add keeps the native close path and sends no request`, async () => {
    const h = await boot(appUrl, []);
    try {
      const requestCount = h.requests.length;
      let prevented = false;
      await h.elementFor('#addForm').emit('submit', {
        submitter: { value: 'cancel' },
        preventDefault() { prevented = true; },
      });
      assert.equal(prevented, false);
      assert.equal(h.requests.length, requestCount);
    } finally { h.cleanup(); }
  });
}

for (const [label, appUrl] of appUrls) defineSyncTests(label, appUrl);
