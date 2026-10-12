// Observe playlist responses already fetched by this player. No extra requests.
(() => {
  const limit = 512 * 1024;
  const manifests = new Map();
  const KINESCOPE_KEY = "RySdvcyu5iTUxn97vn4HwoniwgxaCynA";

  function decodeKinescopePayload(raw) {
    if (typeof raw !== 'string' || !raw.includes('"p":')) return null;
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data.p !== 'string') return null;
      const b64 = data.p.split('').reverse().join('');
      const bin = (typeof atob === 'function' ? atob(b64) : (typeof Buffer !== 'undefined' ? Buffer.from(b64, 'base64').toString('binary') : ''));
      if (!bin) return null;
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i) ^ KINESCOPE_KEY.charCodeAt(i % KINESCOPE_KEY.length);
      }
      const text = new TextDecoder('utf-8').decode(bytes);
      if (/^\s*#EXTM3U\b/.test(text)) return text;
    } catch (_) {}
    return null;
  }

  function publish(url, value) {
    let text = typeof value === 'string' ? value : '';
    if (!/^\s*#EXTM3U\b/.test(text)) {
      const decoded = decodeKinescopePayload(text);
      if (decoded) {
        text = decoded;
      } else {
        return;
      }
    }
    if (!/#EXT(?:INF|-X-STREAM-INF|-X-TARGETDURATION):/.test(text)) return;
    try {
      const resolved = new URL(url, location.href);
      if (!/^https?:$/.test(resolved.protocol)) return;
      manifests.set(resolved.href, true);
      if (manifests.size > 12) manifests.delete(manifests.keys().next().value);
      window.postMessage({type: 'ldm-player-manifest', url: resolved.href}, location.origin);
    } catch (_) {}
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.type !== 'ldm-request-player-manifests') return;
    for (const url of manifests.keys()) {
      window.postMessage({type: 'ldm-player-manifest', url}, location.origin);
    }
  });

  // Also hook player API if available (e.g., Playerjs API: player.api("file"))
  function inspectPlayerApi() {
    try {
      if (window.player && typeof window.player.api === 'function') {
        const fileStr = window.player.api('file');
        if (typeof fileStr === 'string' && fileStr.includes('.m3u8')) {
          const matches = fileStr.match(/https?:\/\/[^\s,\]"']+\.m3u8[^\s,\]"']*/g);
          if (matches) {
            for (const mUrl of matches) {
              const cleanUrl = mUrl.replace(/[\]"'].*$/, '');
              try {
                const resolved = new URL(cleanUrl, location.href);
                if (/^https?:$/.test(resolved.protocol) && !manifests.has(resolved.href)) {
                  manifests.set(resolved.href, true);
                  if (manifests.size > 12) manifests.delete(manifests.keys().next().value);
                  window.postMessage({type: 'ldm-player-manifest', url: resolved.href}, location.origin);
                }
              } catch (_) {}
            }
          }
        }
      }
    } catch (_) {}
  }
  if (typeof setInterval === 'function') {
    setInterval(inspectPlayerApi, 2000);
  }

  const originalFetch = window.fetch;
  if (originalFetch) window.fetch = function (...args) {
    const result = Reflect.apply(originalFetch, this, args);
    result.then(response => {
      const mime = response.headers?.get?.('content-type') || '';
      if (!response.ok || /^(image|video|audio)\//i.test(mime)
          && !/mpegurl/i.test(mime)) return;
      if (Number(response.headers?.get?.('content-length')) > limit) return;
      const copy = response.clone();
      (async () => {
        const reader = copy.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let size = 0, text = '';
        try {
          while (true) {
            const {value, done} = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) return;
            text += decoder.decode(value, {stream: true});
            if (text.length > 64 && !/^\s*#EXTM3U\b/.test(text) && !/^\s*\{/.test(text)) return;
          }
          text += decoder.decode();
          publish(response.url, text);
        } finally { reader.cancel().catch(() => {}); }
      })().catch(() => {});
    }).catch(() => {});
    return result;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    if (!this.__ldmPlaylistObserved) {
      this.__ldmPlaylistObserved = true;
      this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          if (!this.responseType || this.responseType === 'text') {
            if (this.responseText.length <= limit) publish(this.responseURL, this.responseText);
          } else if (this.responseType === 'arraybuffer' && this.response?.byteLength <= limit) {
            publish(this.responseURL, new TextDecoder().decode(this.response));
          }
        } catch (_) {}
      });
    }
    return Reflect.apply(originalOpen, this, args);
  };
})();
