import { isIP } from 'node:net';

export function normalizeExternalLibraryUrl(value) {
  const text = String(value).trim();
  if (!text) return '';

  try {
    if (text.includes('?') || text.includes('#')) throw new Error('URL delimiters are not allowed.');
    const url = new URL(text);
    const hostname = normalizedHostname(url);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.search
      || url.hash
      || isLocalHostname(hostname)
      || isIP(hostname) !== 0
    ) {
      throw new Error('unsafe URL');
    }
    url.hostname = hostname;
    return url.href;
  } catch {
    throw new Error(
      'Invalid PAPERLEX_LIBRARY_URL: use an external HTTPS hostname without credentials, query, or fragment.',
    );
  }
}

export function classifyCaptureBaseUrl(value) {
  const text = String(value).trim();
  if (text.includes('?') || text.includes('#')) throw new Error('URL delimiters are not allowed.');
  const url = new URL(text);
  const hostname = normalizedHostname(url);
  if (url.username || url.password || url.search || url.hash) throw new Error('Unsafe capture base URL.');

  if (isLocalHostname(hostname) || isLocalIp(hostname)) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsafe local capture URL.');
    return { kind: 'local', url: url.href };
  }

  return { kind: 'remote', url: normalizeExternalLibraryUrl(url.href) };
}

function normalizedHostname(url) {
  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/g, '')
    .toLowerCase();
  if (!hostname) throw new Error('Missing hostname.');
  return hostname;
}

function isLocalHostname(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

function isLocalIp(hostname) {
  if (hostname === '::' || hostname === '::1' || hostname.startsWith('::ffff:')) return true;
  if (isIP(hostname) !== 4) return false;
  const octets = hostname.split('.').map(Number);
  return octets[0] === 127 || octets.every((octet) => octet === 0);
}
