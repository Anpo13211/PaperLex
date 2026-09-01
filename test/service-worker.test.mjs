import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const serviceWorkerSource = fs.readFileSync(new URL('../public/service-worker.js', import.meta.url), 'utf8');
const localShell = '<!doctype html><title>PaperLex local</title>';

function cacheKey(request) {
  if (typeof request === 'string') return request;
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function createHarness({ libraryUrl = '', configOnline = true } = {}) {
  const listeners = new Map();
  const stored = new Map([
    ['/', new Response(localShell, { status: 200 })],
    ['/?local=1', new Response(localShell, { status: 200 })],
    ['/api/config', Response.json({ requiresLogin: false, libraryUrl })],
  ]);
  const caches = {
    async match(request) {
      return stored.get(cacheKey(request))?.clone();
    },
    async open() {
      return {
        async addAll(urls) { harnessState.addedShell = [...urls]; },
        async put(request, response) { stored.set(cacheKey(request), response.clone()); },
      };
    },
    async keys() { return ['paperlex-shell-v5']; },
    async delete(key) { return stored.delete(key); },
  };
  const harnessState = { addedShell: [] };
  const self = {
    location: { origin: 'http://paperlex.local' },
    clients: { async claim() {} },
    skipWaiting() {},
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const fetch = async (request) => {
    const url = new URL(typeof request === 'string' ? request : request.url, self.location.origin);
    if (url.pathname === '/api/config') {
      if (!configOnline) throw new TypeError('simulated config failure');
      return Response.json({ requiresLogin: false, libraryUrl });
    }
    throw new TypeError('simulated navigation failure');
  };

  vm.runInNewContext(serviceWorkerSource, {
    self,
    caches,
    fetch,
    URL,
    Response,
  }, { filename: 'service-worker.js' });

  async function navigate(pathname) {
    let responsePromise;
    listeners.get('fetch')({
      request: { url: new URL(pathname, self.location.origin).href, method: 'GET', mode: 'navigate' },
      respondWith(value) { responsePromise = Promise.resolve(value); },
    });
    assert.ok(responsePromise, 'service worker must handle same-origin navigation');
    return responsePromise;
  }

  async function install() {
    let installPromise;
    listeners.get('install')({ waitUntil(value) { installPromise = Promise.resolve(value); } });
    await installPromise;
    return harnessState.addedShell;
  }

  return { install, navigate };
}

test('cloud-capable shell precaches only the explicit local fallback document', async () => {
  const shell = await createHarness({ libraryUrl: 'https://paperlex.example/library' }).install();

  assert.ok(shell.includes('/?local=1'));
  assert.equal(shell.includes('/'), false);
  assert.equal(shell.includes('/index.html'), false);
});

test('failed cloud-mode navigation redirects to the configured library instead of cached local UI', async () => {
  const libraryUrl = 'https://paperlex.example/library';
  const response = await createHarness({ libraryUrl, configOnline: false }).navigate('/');

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), libraryUrl);
});

test('failed local-mode navigation may fall back to the cached local UI', async () => {
  const response = await createHarness().navigate('/');

  assert.equal(response.status, 200);
  assert.equal(await response.text(), localShell);
});

test('local query override may use cached local UI even when cloud mode is configured', async () => {
  const response = await createHarness({ libraryUrl: 'https://paperlex.example/library' }).navigate('/?local=1');

  assert.equal(response.status, 200);
  assert.equal(await response.text(), localShell);
});
