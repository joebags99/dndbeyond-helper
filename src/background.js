/**
 * Fetches character sheets for the campaign page content script.
 *
 * Runs in the extension context so the character-service requests are not
 * subject to the page's CORS rules, and so the D&D Beyond session cookie can be
 * exchanged for a short-lived bearer token — that token is what makes
 * campaign-private characters readable by their DM.
 */

const CHARACTER_ENDPOINT = (id) =>
  `https://character-service.dndbeyond.com/character/v5/character/${id}`;
const TOKEN_ENDPOINT = 'https://auth-service.dndbeyond.com/v1/cobalt-token';

const DEFAULT_TTL_SECONDS = 300;
const MAX_PARALLEL_FETCHES = 4;
const CACHE_PREFIX = 'character:';

let tokenCache = { token: null, expiresAt: 0 };
const inFlight = new Map();

async function getAuthToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  try {
    const response = await fetch(TOKEN_ENDPOINT, { method: 'POST', credentials: 'include' });
    if (!response.ok) throw new Error(`token request failed (${response.status})`);
    const body = await response.json();
    if (!body || !body.token) throw new Error('token missing from response');
    const ttl = typeof body.ttl === 'number' ? body.ttl : 600;
    tokenCache = { token: body.token, expiresAt: Date.now() + Math.max(30, ttl - 30) * 1000 };
    return tokenCache.token;
  } catch (error) {
    // Signed out, or the endpoint moved: public characters still resolve below.
    tokenCache = { token: null, expiresAt: 0 };
    return null;
  }
}

async function requestCharacter(id, token) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(CHARACTER_ENDPOINT(id), { headers });

  if (response.status === 401 || response.status === 403) {
    const error = new Error('private');
    error.status = response.status;
    throw error;
  }
  if (response.status === 404) {
    const error = new Error('not-found');
    error.status = 404;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`http-${response.status}`);
    error.status = response.status;
    throw error;
  }

  const body = await response.json();
  if (body && body.success === false) {
    const error = new Error(body.message || 'unavailable');
    error.status = 403;
    throw error;
  }
  return body;
}

function describeError(error) {
  switch (error && error.message) {
    case 'private':
      return 'Not readable — set the character’s privacy to Public or campaign-visible.';
    case 'not-found':
      return 'Character not found. It may have been deleted.';
    default:
      return `Couldn’t load this character (${(error && error.message) || 'unknown error'}).`;
  }
}

async function readCache(id, ttlSeconds) {
  if (ttlSeconds <= 0) return null;
  const key = CACHE_PREFIX + id;
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (!entry || typeof entry.fetchedAt !== 'number') return null;
  if (Date.now() - entry.fetchedAt > ttlSeconds * 1000) return null;
  return entry;
}

async function writeCache(id, payload) {
  await chrome.storage.local.set({
    [CACHE_PREFIX + id]: { fetchedAt: Date.now(), payload }
  });
}

async function loadCharacter(id, { force, ttlSeconds }) {
  if (!force) {
    const cached = await readCache(id, ttlSeconds);
    if (cached) return { id, ok: true, payload: cached.payload, fetchedAt: cached.fetchedAt, cached: true };
  }

  if (inFlight.has(id)) return inFlight.get(id);

  const job = (async () => {
    try {
      let payload;
      try {
        payload = await requestCharacter(id, await getAuthToken());
      } catch (error) {
        // A stale token reads as forbidden; drop it and retry once.
        if (error.status === 401 || error.status === 403) {
          tokenCache = { token: null, expiresAt: 0 };
          const retryToken = await getAuthToken();
          payload = retryToken
            ? await requestCharacter(id, retryToken)
            : await requestCharacter(id, null);
        } else {
          throw error;
        }
      }
      const fetchedAt = Date.now();
      await writeCache(id, payload);
      return { id, ok: true, payload, fetchedAt, cached: false };
    } catch (error) {
      const stale = await readCache(id, Number.MAX_SAFE_INTEGER);
      if (stale) {
        return { id, ok: true, payload: stale.payload, fetchedAt: stale.fetchedAt, cached: true, stale: true };
      }
      return { id, ok: false, error: describeError(error) };
    } finally {
      inFlight.delete(id);
    }
  })();

  inFlight.set(id, job);
  return job;
}

async function loadCharacters(ids, options) {
  const queue = ids.slice();
  const results = [];
  const workers = Array.from({ length: Math.min(MAX_PARALLEL_FETCHES, queue.length) }, async () => {
    while (queue.length > 0) {
      results.push(await loadCharacter(queue.shift(), options));
    }
  });
  await Promise.all(workers);
  return results;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (!message || message.type !== 'getCharacters') return false;

  (async () => {
    try {
      const { cacheTtlSeconds = DEFAULT_TTL_SECONDS } = await chrome.storage.sync.get('cacheTtlSeconds');
      const ids = Array.from(new Set((message.ids || []).map(String))).filter(Boolean);
      const results = await loadCharacters(ids, {
        force: Boolean(message.force),
        ttlSeconds: message.force ? 0 : cacheTtlSeconds
      });
      sendResponse({ ok: true, results });
    } catch (error) {
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    }
  })();

  return true; // keep the message channel open for the async response
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
