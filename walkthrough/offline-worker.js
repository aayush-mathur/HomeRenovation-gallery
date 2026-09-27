/* Protocol 1: never claim or replace a running client; releases are pinned at navigation. */
'use strict';
const base = new URL(self.registration.scope);
const prefix = `home-offline-v1:${base.pathname}:`;
const manifestURL = new URL('offline-manifest.json', base).href;
let database;
let job = null;
let mutations = Promise.resolve();
function exclusive(action) {
  const result = mutations.then(action);
  mutations = result.catch(() => {});
  return result;
}

function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(prefix, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Offline storage is blocked. Close other viewer tabs and retry.'));
  });
  return database;
}

async function read(key) {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const request = connection.transaction('state').objectStore('state').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function write(entries) {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('state', 'readwrite');
    for (const [key, value] of entries) {
      if (value === undefined) tx.objectStore('state').delete(key);
      else tx.objectStore('state').put(value, key);
    }
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Offline storage transaction failed.'));
  });
}

const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(n => n.toString(16).padStart(2, '0')).join('');
const assetURL = path => new URL(path, base).href;
function publicResponse(response) {
  return response.ok && response.type !== 'opaque' &&
    !/\bprivate\b/i.test(response.headers.get('Cache-Control') || '') &&
    !/(?:^|,)\s*(?:authorization|cookie)\s*(?:,|$)/i.test(response.headers.get('Vary') || '');
}

function validateManifest(value) {
  if (value?.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.release) ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > 200) {
    throw new Error('Unsupported offline manifest. Reload online and retry.');
  }
  const paths = new Set();
  let total = 0;
  for (const file of value.files) {
    if (!file || typeof file.path !== 'string' ||
        !/^[a-zA-Z0-9_-]+(?:[./][a-zA-Z0-9_-]+)*$/.test(file.path) ||
        file.path.includes('..') || file.path === 'offline-manifest.json' ||
        paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        assetURL(file.path).slice(0, base.href.length) !== base.href) {
      throw new Error('Invalid offline asset inventory.');
    }
    paths.add(file.path);
    total += file.bytes;
  }
  if (total !== value.totalBytes || total > 1024 * 1024 * 1024 ||
      !paths.has('index.html') || !paths.has('offline-client.js')) {
    throw new Error('Incomplete offline manifest.');
  }
  return value;
}

async function latest(signal) {
  const response = await fetch(manifestURL, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal });
  if (!publicResponse(response)) throw new Error('Cannot check updates from a public response. Go online and retry.');
  const value = validateManifest(await response.json());
  const inventory = value.files.map(f => `${f.path}\t${f.bytes}\t${f.sha256}\n`).join('');
  if (await hash(new TextEncoder().encode(inventory)) !== value.release) {
    throw new Error('Offline manifest integrity mismatch.');
  }
  return value;
}

async function completeReceipt(receipt) {
  if (!receipt || !(await caches.has(receipt.cache))) return false;
  const cache = await caches.open(receipt.cache);
  for (const file of receipt.manifest.files) {
    const response = await cache.match(assetURL(file.path));
    if (!response || Number(response.headers.get('Content-Length')) !== file.bytes) return false;
  }
  return true;
}

function cleanup() {
  return exclusive(async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const keep = new Set();
    const active = await read('active');
    if (active) keep.add(active.cache);
    const connection = await db();
    const entries = await new Promise((resolve, reject) => {
      const request = connection.transaction('state').objectStore('state').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    // A navigation's resulting client may not yet appear in matchAll.
    for (const pin of entries) {
      if (pin.cache && pin.pinnedAt > Date.now() - 60000) keep.add(pin.cache);
    }
    for (const client of clients) {
      const pin = await read(`pin:${client.id}`);
      if (pin?.cache) keep.add(pin.cache);
    }
    for (const name of await caches.keys()) {
      if (name.startsWith(prefix) && !keep.has(name) && name !== job?.cache) await caches.delete(name);
    }
  });
}

function contentType(path) {
  if (path.endsWith('.wasm')) return 'application/wasm';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.glb')) return 'model/gltf-binary';
  if (path.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

async function bytesFor(file, previous, signal, progress) {
  const prior = previous?.manifest.files.find(f => f.path === file.path &&
    f.sha256 === file.sha256 && f.bytes === file.bytes);
  if (prior && await caches.has(previous.cache)) {
    const response = await (await caches.open(previous.cache)).match(assetURL(file.path));
    if (response) {
      const data = await response.arrayBuffer();
      if (data.byteLength === file.bytes && await hash(data) === file.sha256) {
        progress(file.bytes, true);
        return { data, headers: new Headers(response.headers) };
      }
    }
  }
  const response = await fetch(assetURL(file.path), {
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal,
  });
  if (!publicResponse(response) || response.status !== 200) {
    throw new Error(`Download failed: ${file.path} (${response.status}). Retry online.`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > file.bytes) {
      await reader.cancel();
      throw new Error(`Size mismatch: ${file.path}. The release may be changing; retry later.`);
    }
    chunks.push(value);
    progress(value.byteLength, false);
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  if (length !== file.bytes || await hash(data) !== file.sha256) {
    throw new Error(`Integrity mismatch: ${file.path}. The previous offline copy is unchanged.`);
  }
  return { data, headers: new Headers(response.headers) };
}

async function download(source, port, expectedRelease, currentJob) {
  try {
    const manifest = await latest(currentJob.controller.signal);
    if (manifest.release !== expectedRelease) throw new Error('The release changed. Check updates and retry.');
    const previous = await read('active');
    if (previous?.manifest.release === manifest.release && await completeReceipt(previous)) {
      port.postMessage({ type: 'done', release: manifest.release });
      return;
    }
    currentJob.cache = `${prefix}${manifest.release}:${crypto.randomUUID()}`;
    const cache = await caches.open(currentJob.cache);
    let completed = 0, reused = 0, lastProgress = 0;
    for (const file of manifest.files) {
      currentJob.controller.signal.throwIfAborted();
      const { data, headers } = await bytesFor(file, previous, currentJob.controller.signal, (count, reuse) => {
        completed += count;
        if (reuse) reused += count;
        if (Date.now() - lastProgress > 100 || completed === manifest.totalBytes) {
          port.postMessage({ type: 'progress', completed, reused, total: manifest.totalBytes, path: file.path });
          lastProgress = Date.now();
        }
      });
      currentJob.controller.signal.throwIfAborted();
      // Keep the origin's security/isolation headers, but the stored body is decoded.
      for (const name of ['Content-Encoding', 'Transfer-Encoding', 'Content-Range']) headers.delete(name);
      headers.set('Content-Type', contentType(file.path));
      headers.set('Content-Length', String(file.bytes));
      headers.set('X-Offline-SHA256', file.sha256);
      headers.set('X-Offline-Release', manifest.release);
      await cache.put(assetURL(file.path), new Response(data, { headers }));
    }
    currentJob.controller.signal.throwIfAborted();
    if (!(await self.clients.get(source.id))) throw new Error('Download tab closed before completion.');
    const receipt = { cache: currentJob.cache, manifest, verifiedAt: new Date().toISOString() };
    // Cache writes are complete before the one atomic pointer/receipt transaction.
    await exclusive(() => write([['active', receipt]]));
    port.postMessage({ type: 'done', release: manifest.release, reused });
  } catch (error) {
    port.postMessage({ type: 'error', message: error.name === 'AbortError'
      ? 'Download cancelled. The previous offline copy is unchanged.'
      : error.name === 'QuotaExceededError'
        ? 'Not enough browser storage. Free space and retry; the previous offline copy is unchanged.'
        : `${error.message} The previous offline copy is unchanged.` });
  } finally {
    job = null;
    await cleanup();
  }
}

self.addEventListener('message', event => {
  const port = event.ports[0];
  if (!port || !event.source?.url || !event.source.url.startsWith(base.href)) return;
  const { type, release } = event.data || {};
  event.waitUntil((async () => {
    try {
      if (type === 'download') {
        if (job) throw new Error('A download is already running in another viewer tab.');
        job = { controller: new AbortController(), owner: event.source.id };
        await download(event.source, port, release, job);
      } else if (type === 'cancel') {
        if (job?.owner !== event.source.id) throw new Error('Cancel the download in the tab that started it.');
        job.controller.abort();
        port.postMessage({ type: 'done' });
      } else if (type === 'remove') {
        if (job) throw new Error('Cancel the current download before removing the offline copy.');
        await exclusive(() => write([['active', undefined]]));
        await cleanup();
        port.postMessage({ type: 'done' });
      } else if (type === 'status') {
        const active = await read('active');
        const pin = await read(`pin:${event.source.id}`);
        const available = await completeReceipt(active);
        let manifest = null, warning = null;
        try { manifest = await latest(AbortSignal.timeout(15000)); }
        catch (error) { warning = error.message; }
        const changedBytes = manifest?.files.reduce((total, file) => total +
          (available && active.manifest.files.some(f => f.path === file.path &&
            f.sha256 === file.sha256 && f.bytes === file.bytes) ? 0 : file.bytes), 0);
        port.postMessage({ type: 'status', active: available ? active.manifest.release : null,
          pinned: pin?.manifest?.release || null, manifest, changedBytes, warning,
          damaged: Boolean(active && !available), busy: Boolean(job) });
        await cleanup();
      } else throw new Error('Unknown offline operation.');
    } catch (error) { port.postMessage({ type: 'error', message: `Offline storage unavailable: ${error.message}` }); }
  })());
});

async function rangeResponse(response, range) {
  const bytes = await response.arrayBuffer();
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const size = bytes.byteLength;
  let start, end;
  if (match && (match[1] || match[2])) {
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end = match[1] ? (match[2] ? Math.min(Number(match[2]), size - 1) : size - 1) : size - 1;
  }
  const headers = new Headers(response.headers);
  headers.set('Accept-Ranges', 'bytes');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    headers.set('Content-Range', `bytes */${size}`);
    headers.set('Content-Length', '0');
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(bytes.slice(start, end + 1), { status: 206, headers });
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
  const path = url.pathname.slice(base.pathname.length);
  // The inventory is always a lightweight network check, never a cached update promise.
  if (path === 'offline-manifest.json') return;
  event.respondWith((async () => {
    try {
      let receipt;
      if (event.request.mode === 'navigate') {
        if (path !== '' && path !== 'index.html') return fetch(event.request);
        receipt = await exclusive(async () => {
          const saved = await read('active');
          const active = await completeReceipt(saved) ? saved : null;
          if (event.resultingClientId) await write([[`pin:${event.resultingClientId}`,
            { ...(active || { cache: null }), pinnedAt: Date.now() }]]);
          return active;
        });
      } else {
        receipt = await read(`pin:${event.clientId}`);
      }
      if (!receipt?.cache) return fetch(event.request);
      const file = receipt.manifest.files.find(f => f.path === (path || 'index.html'));
      if (!file) return fetch(event.request);
      const response = await (await caches.open(receipt.cache)).match(assetURL(file.path));
      if (!response) return new Response('This offline copy was evicted. Reconnect and remove/download it again.', { status: 503 });
      return event.request.headers.has('range') ? rangeResponse(response, event.request.headers.get('range')) : response;
    } catch (error) {
      return new Response(`Offline storage unavailable: ${error.message}. Reconnect and retry.`, { status: 503 });
    }
  })());
});
