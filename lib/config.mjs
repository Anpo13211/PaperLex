import path from 'node:path';
import { normalizeExternalLibraryUrl } from './library-url.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const host = env.PAPERLEX_HOST?.trim() || '127.0.0.1';
  const port = parsePort(env.PAPERLEX_PORT || '8787');
  const dataDir = path.resolve(cwd, env.PAPERLEX_DATA_DIR?.trim() || 'data');
  const libraryUrl = normalizeExternalLibraryUrl(env.PAPERLEX_LIBRARY_URL || '');
  const password = env.PAPERLEX_PASSWORD || '';
  const captureToken = env.PAPERLEX_CAPTURE_TOKEN || '';
  const sessionSecret = env.PAPERLEX_SESSION_SECRET || `${password}:${captureToken}`;
  const secureCookie = parseBoolean(env.PAPERLEX_SECURE_COOKIE || 'false', 'PAPERLEX_SECURE_COOKIE');

  return {
    host,
    port,
    dataDir,
    databasePath: path.join(dataDir, 'paperlex.sqlite'),
    libraryUrl,
    password,
    captureToken,
    sessionSecret,
    secureCookie,
    isLoopbackOnly: LOOPBACK_HOSTS.has(host),
  };
}

export function assertSafeNetworkConfig(config) {
  if (config.captureToken.length < 24) {
    throw new Error('PAPERLEX_CAPTURE_TOKEN must be at least 24 characters.');
  }
  if (config.password && config.sessionSecret.length < 32) {
    throw new Error('PAPERLEX_SESSION_SECRET must be at least 32 characters when browser authentication is enabled.');
  }
  if (config.isLoopbackOnly) return;
  if (config.password.length < 12) {
    throw new Error('PAPERLEX_PASSWORD must be at least 12 characters when PAPERLEX_HOST is not loopback.');
  }
}

function parsePort(value) {
  const text = String(value);
  if (!/^[1-9]\d{0,4}$/.test(text)) {
    throw new Error(`Invalid PAPERLEX_PORT: ${value}`);
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PAPERLEX_PORT: ${value}`);
  }
  return port;
}

function parseBoolean(value, name) {
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  throw new Error(`Invalid ${name}: ${value}`);
}
