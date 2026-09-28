const host = document.querySelector('[data-offline-host]');
const base = new URL('./', import.meta.url);

if (host) {
  const study = host.dataset.offlineKind === 'study';
  const panel = document.createElement('details');
  panel.className = 'offline-panel';
  panel.innerHTML = `<summary>Offline</summary>
    <div class="offline-content">
      <h2>${study ? 'Keep this landing study' : 'Keep this walkthrough'}</h2>
      <p data-offline-status role="status" aria-live="polite">Checking offline support...</p>
      <progress data-offline-progress aria-label="Offline download progress" hidden></progress>
      <div class="offline-actions">
        <button data-offline-download disabled>Download for offline use</button>
        <button data-offline-cancel hidden>Cancel download</button>
        <button data-offline-reload hidden>Reload to update</button>
        <button data-offline-check>Check again</button>
        <button data-offline-remove hidden>Remove offline copy</button>
        <button data-offline-close>${study ? 'Back to landing study' : 'Back to walkthrough'}</button>
      </div>
      <p class="offline-note">First download requires internet. Saved only in this browser on this site, not synced.
      ${study ? 'Only this separate intermediate-landing study is included. The house and gallery are not downloaded.'
        : 'All ceiling choices are included where available. The optional landing study, gallery and other viewers are not downloaded.'}
      Browser storage can be evicted; private browsing may not support saving. Keep this tab open until complete.</p>
      <p data-offline-storage class="offline-note"></p>
    </div>`;
  host.append(panel);
  const find = name => panel.querySelector(`[data-offline-${name}]`);
  const status = find('status'), download = find('download'), cancel = find('cancel');
  const reload = find('reload'), check = find('check'), remove = find('remove'), progress = find('progress');
  let registration, state, busy = false;
  const mb = bytes => `${(bytes / 1000000).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  const say = text => { status.textContent = text; };

  function request(type, payload = {}, onProgress) {
    return new Promise((resolve, reject) => {
      const worker = registration?.active;
      if (!worker) { reject(new Error('Offline worker is not ready. Reload online and retry.')); return; }
      const channel = new MessageChannel();
      let timer;
      const finish = () => { clearTimeout(timer); channel.port1.close(); };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          finish(); reject(new Error('Offline operation stopped responding. Check again or reload and retry.'));
        }, type === 'download' ? 180000 : 30000);
      };
      channel.port1.onmessage = ({ data }) => {
        arm();
        if (data.type === 'progress') { onProgress?.(data); return; }
        finish();
        if (data.type === 'error') reject(new Error(data.message));
        else resolve(data);
      };
      arm();
      worker.postMessage({ type, ...payload }, [channel.port2]);
    });
  }

  function render() {
    download.disabled = busy || !state?.manifest || state.active === state.manifest.release;
    download.textContent = state?.active && state?.manifest && state.active !== state.manifest.release
      ? `Update available - ${mb(state.changedBytes)}`
      : `Download for offline use${state?.manifest ? ` - ${mb(state.manifest.totalBytes)}` : ''}`;
    cancel.hidden = !busy;
    check.disabled = remove.disabled = busy;
    remove.hidden = !state?.active && !state?.damaged;
    reload.hidden = busy || !state?.active || state.pinned === state.active;
    progress.hidden = !busy;
  }

  async function refresh() {
    try {
      check.disabled = true;
      state = await request('status');
      say(state.damaged ? 'The saved copy is incomplete or was evicted. Download it again while online.'
        : state.active ? `Available offline.${state.pinned !== state.active ? ' Reload to use the saved release.' : ''}${state.warning ? ' Update check unavailable; the saved release is unchanged.' : ''}`
          : state.warning ? `${state.warning} An online download is needed before offline use.`
            : `Save the complete viewer (${mb(state.manifest.totalBytes)}) for offline visits.`);
      if (state.busy) say('A download is running in another viewer tab. Check again when it finishes.');
    } catch (error) { say(error.message); }
    finally { render(); }
  }

  download.onclick = async () => {
    if (!state?.manifest || busy) return;
    busy = true;
    progress.max = state.manifest.totalBytes; progress.value = 0;
    say('Preparing verified download...'); render();
    try {
      if (navigator.storage?.estimate) {
        try {
          const estimate = await navigator.storage.estimate();
          find('storage').textContent = estimate.quota == null ? 'Browser storage estimate is unavailable.'
            : `Estimated browser space remaining: ${mb(Math.max(0, estimate.quota - (estimate.usage || 0)))}. Updates temporarily keep both releases.`;
        } catch (error) { find('storage').textContent = `Storage estimate unavailable: ${error.message}.`; }
      }
      if (navigator.storage?.persist) {
        try {
          const persisted = await navigator.storage.persist();
          find('storage').textContent += persisted ? ' Persistent storage granted; you can still clear it in browser settings.'
            : ' Persistent storage was not granted; your browser may clear the copy.';
        } catch (error) { find('storage').textContent += ` Persistence request unavailable: ${error.message}.`; }
      }
      await request('download', { release: state.manifest.release }, data => {
        progress.value = data.completed;
        say(`${mb(data.completed)} / ${mb(data.total)} received or reused${data.reused ? ` (${mb(data.reused)} reused)` : ''}. Verifying ${data.path}`);
      });
      busy = false;
      await refresh();
    } catch (error) { say(error.message); }
    finally { busy = false; render(); }
  };
  cancel.onclick = async () => {
    try { await request('cancel'); }
    catch (error) { say(error.message); }
  };
  check.onclick = refresh;
  reload.onclick = () => location.reload();
  find('close').onclick = () => {
    panel.open = false;
    panel.querySelector('summary').focus();
  };
  remove.onclick = async () => {
    try {
      await request('remove');
      state.active = null; state.damaged = false;
      say('Offline copy removed for future visits. Close viewer tabs to release files still in use; unrelated sites are untouched.');
      render();
    } catch (error) { say(error.message); }
  };
  panel.addEventListener('toggle', () => {
    if (panel.open) {
      document.exitPointerLock?.();
      window.hallControl?.(JSON.stringify({ type: 'stop' }));
    }
  });

  let supported = false;
  try {
    supported = isSecureContext && 'serviceWorker' in navigator && Boolean(window.indexedDB && window.caches && crypto.subtle);
  } catch (error) {
    find('storage').textContent = `Browser storage access was denied: ${error.message}.`;
  }
  if (!supported) {
    say('Offline saving is unsupported here. Use a regular browser window on HTTPS (or localhost). The online viewer still works.');
    check.hidden = true;
  } else {
    (async () => {
      try {
        registration = await navigator.serviceWorker.register(new URL('offline-worker.js', base), { scope: base.pathname, updateViaCache: 'none' });
        if (!registration.active) {
          await new Promise((resolve, reject) => {
            const worker = registration.installing || registration.waiting;
            if (!worker) return reject(new Error('Offline worker could not start.'));
            const timeout = setTimeout(() => reject(new Error('Offline worker startup timed out.')), 15000);
            worker.addEventListener('statechange', () => {
              if (worker.state === 'activated') { clearTimeout(timeout); resolve(); }
              if (worker.state === 'redundant') { clearTimeout(timeout); reject(new Error('Offline worker installation failed.')); }
            });
          });
        }
        await refresh();
      } catch (error) {
        say(`Offline saving is unavailable: ${error.message} Try a regular browser window with storage enabled.`);
        check.onclick = () => location.reload();
      }
    })();
  }
}
