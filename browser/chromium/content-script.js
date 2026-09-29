const t = (k) => (window.LDM_I18N ? window.LDM_I18N.t(k) : k);

const DOWNLOADABLE_EXTENSIONS = new Set([
  "7z",
  "apk",
  "appimage",
  "avi",
  "bin",
  "csv",
  "deb",
  "dmg",
  "epub",
  "exe",
  "flac",
  "gz",
  "img",
  "iso",
  "m4a",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "msi",
  "ogg",
  "pdf",
  "pkg",
  "rar",
  "rpm",
  "tar",
  "tgz",
  "torrent",
  "wav",
  "webm",
  "zip"
]);
const MEDIA_SOURCE_ATTRIBUTES = [
  "src",
  "data-src",
  "data-url",
  "data-video-src",
  "data-video-url",
  "data-stream",
  "data-stream-url",
  "data-hls",
  "data-mpd"
];
const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const MEDIA_CONTAINER_SELECTOR = [
  '[data-testid*="video" i]',
  '[data-testid*="media" i]',
  '[class*="video" i]',
  '[class*="player" i]',
  '[class*="media" i]',
  '[aria-label*="video" i]'
].join(", ");

let hoverButton = null;
let activeCandidate = null;
let reportTimer = null;
let recentMediaCandidates = [];
let mediaOverlayRoot = null;
let mediaRefreshTimer = null;
let toastRoot = null;
let toastTimer = null;
let captureTimeout = null;
let lastCaptureRequestAt = 0;
let lastLocationHref = window.location.href;
let periodicRefreshHandle = null;
let pageObserver = null;
const playerManifests = new Set();
let extensionDisconnected = false;

function disconnectExtension() {
  if (extensionDisconnected) return;
  extensionDisconnected = true;
  window.clearInterval(periodicRefreshHandle);
  window.clearTimeout(reportTimer);
  window.clearTimeout(mediaRefreshTimer);
  clearCaptureTimeout();
  pageObserver?.disconnect();
  hoverButton?.remove();
  mediaOverlayRoot?.remove();
  showToast(t("toast_reloaded"), "info");
}

function sendExtensionMessage(message, callback) {
  if (extensionDisconnected) return;
  try {
    if (!chrome.runtime?.id) { disconnectExtension(); return; }
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error && /context invalidated/i.test(error.message ?? "")) {
        disconnectExtension();
        return;
      }
      if (callback) callback(response);
    });
  } catch (error) {
    if (/context invalidated/i.test(error.message ?? "")) {
      disconnectExtension();
      return;
    }
    clearCaptureTimeout();
    showToast("Eklenti mesajı gönderilemedi: " + error.message, "error");
  }
}

bootstrap();

function isExcludedHost(hostname) {
  return /(^|\.)(whatsapp\.com|whatsapp\.net)$/i.test(hostname);
}

function bootstrap() {
  if (/(^|\.)molystream\.org$/i.test(window.location.hostname)) {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.type !== "ldm-player-manifest") return;
      const url = normalizeUrl(event.data.url);
      if (!url || playerManifests.has(url)) return;
      playerManifests.add(url);
      if (playerManifests.size > 12) playerManifests.delete(playerManifests.values().next().value);
      reportObservedMediaCandidates();
    });
    window.postMessage({type: "ldm-request-player-manifests"}, window.location.origin);
  }
  if (isExcludedHost(window.location.hostname)) {
    return;
  }

  // Embedded players run this script too so their media can still be reported,
  // but only the top-level page should render controls. Otherwise every iframe
  // adds its own LDM button over the same visible player.
  if (window !== window.top) {
    scheduleCandidateReport();
    observePageChanges();
    reportObservedMediaCandidates();
    periodicRefreshHandle = window.setInterval(reportObservedMediaCandidates, 1200);
    document.addEventListener("loadedmetadata", handleMediaSignal, true);
    document.addEventListener("play", handleMediaSignal, true);
    return;
  }

  createHoverButton();
  createMediaOverlay();
  createToastRoot();
  scheduleCandidateReport();
  observePageChanges();
  refreshRecentMediaCandidates();
  scheduleMediaOverlayRefresh();
  startPeriodicRefresh();

  document.addEventListener("pointerover", handlePointerOver, true);
  document.addEventListener("pointermove", handlePointerOver, true);
  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("scroll", repositionHoverButton, true);
  document.addEventListener("scroll", scheduleMediaOverlayRefresh, true);
  window.addEventListener("resize", repositionHoverButton);
  window.addEventListener("resize", scheduleMediaOverlayRefresh);
  document.addEventListener("loadedmetadata", handleMediaSignal, true);
  document.addEventListener("play", handleMediaSignal, true);
  window.addEventListener("popstate", handleRouteChange);
  window.addEventListener("hashchange", handleRouteChange);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "native-capture-status") {
      clearCaptureTimeout();
      showToast(
        message.message || "Linux Download Manager returned an unknown response.",
        message.tone || "info"
      );
      return;
    }

    if (message?.type === "open-quality-picker-from-context") {
      let candidate = null;
      if (activeCandidate) {
        candidate = activeCandidate;
      } else {
        const mediaUrl = message.mediaUrl;
        const pageUrl = message.pageUrl || window.location.href;
        const title = message.title || document.title;
        let matchingVideo = null;
        if (mediaUrl) {
          matchingVideo = Array.from(document.querySelectorAll("video")).find(v => v.src === mediaUrl || v.currentSrc === mediaUrl);
        }
        candidate = {
          element: matchingVideo,
          url: mediaUrl,
          sourcePageUrl: pageUrl,
          title: title,
          kind: "media-fallback"
        };
      }
      showQualityPicker(candidate, null);
      if (typeof sendResponse === "function") {
        sendResponse({ ok: true });
      }
      return true;
    }
  });
}

function createHoverButton() {
  // Sites with their own download control do not need a generic hover button.
  if (hasInlineButtons() || hoverButton) {
    return;
  }

  hoverButton = document.createElement("button");
  hoverButton.type = "button";
  hoverButton.className = "ldm-hover-button";
  hoverButton.textContent = "LDM";
  hoverButton.title = "Download with Linux Download Manager";
  hoverButton.hidden = true;
  hoverButton.addEventListener("click", handleHoverButtonClick);
  document.documentElement.appendChild(hoverButton);
}

function createMediaOverlay() {
  if (mediaOverlayRoot) {
    return;
  }

  mediaOverlayRoot = document.createElement("div");
  mediaOverlayRoot.className = "ldm-media-layer";
  document.documentElement.appendChild(mediaOverlayRoot);
}

function createToastRoot() {
  if (toastRoot) {
    return;
  }

  toastRoot = document.createElement("div");
  toastRoot.className = "ldm-toast-root";
  document.documentElement.appendChild(toastRoot);
}

function hasInlineButtons() {
  return /reddit\.com|youtube\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com/i.test(window.location.hostname);
}

function handlePointerOver(event) {
  if (hasInlineButtons()) return;

  const candidate = extractCandidateFromPoint(event);
  if (!candidate) {
    return;
  }

  activeCandidate = candidate;
  repositionHoverButton();
}

function handlePointerDown(event) {
  if (!hoverButton || hoverButton.hidden) {
    return;
  }

  if (hoverButton.contains(event.target)) {
    return;
  }

  if (isEventInsideActiveCandidate(event)) {
    return;
  }

  const candidate = extractCandidateFromPoint(event);
  if (!candidate || candidate.element !== activeCandidate?.element) {
    hideHoverButton();
  }
}

function handleHoverButtonClick(event) {
  event.preventDefault();
  event.stopPropagation();

  if (!activeCandidate) {
    return;
  }

  triggerCaptureForCandidate(activeCandidate, hoverButton);
}

function isYtdlpSupportedSite() {
  const host = window.location.hostname;
  return /(youtube\.com|youtu\.be|x\.com|twitter\.com|facebook\.com|instagram\.com|fb\.watch|tiktok\.com|reddit\.com|pinterest\.com|twitch\.tv|vimeo\.com|dailymotion\.com)$/i.test(host);
}

function showQualityPicker(candidate, anchorElement) {
  closeQualityPicker();

  const currentHref = window.location.href;
  const isPlaylistContext = currentHref.includes("list=") || window.location.search.includes("list=") || (candidate?.sourcePageUrl && candidate.sourcePageUrl.includes("list=")) || (candidate?.url && candidate.url.includes("list="));

  const picker = document.createElement("div");
  picker.setAttribute("style", `
    position: fixed !important;
    z-index: 2147483647 !important;
    background: rgba(18, 22, 30, 0.98) !important;
    border: 1px solid rgba(134, 232, 255, 0.3) !important;
    border-radius: 12px !important;
    padding: 10px 0 !important;
    min-width: 280px !important;
    max-width: 380px !important;
    box-shadow: 0 20px 60px rgba(0,0,0,0.85) !important;
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
    pointer-events: auto !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
  `);
  picker.id = "ldm-quality-picker";

  const title = document.createElement("div");
  title.setAttribute("style", `
    padding: 4px 16px 8px !important;
    font: 700 13px/1.2 sans-serif !important;
    color: #86e8ff !important;
    letter-spacing: 0.04em !important;
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
  `);
  title.innerHTML = `<span>⚡ Linux Download Manager</span><span style="font-size:10px; color:#8b9eb5; cursor:pointer;" id="ldm-picker-close-x">✕</span>`;
  picker.appendChild(title);

  title.querySelector("#ldm-picker-close-x")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeQualityPicker();
  });

  if (isPlaylistContext) {
    // 1. PLAYLIST SECTION
    const plHeader = document.createElement("div");
    plHeader.setAttribute("style", `
      padding: 6px 14px 4px !important;
      font: 700 11px/1 sans-serif !important;
      color: #86e8ff !important;
      letter-spacing: 0.06em !important;
      text-transform: uppercase !important;
      background: rgba(134, 232, 255, 0.1) !important;
      border-top: 1px solid rgba(134, 232, 255, 0.2) !important;
      border-bottom: 1px solid rgba(134, 232, 255, 0.1) !important;
      margin-top: 4px !important;
    `);
    plHeader.textContent = t("playlist_header");
    picker.appendChild(plHeader);

    const playlistOptions = [
      { label: t("playlist_mp3"), format: "audio_mp3_320" },
      { label: t("playlist_flac"), format: "audio_flac" },
      { label: t("playlist_m4a"), format: "audio_m4a" },
      { label: t("playlist_video_1080p"), format: "bv*[height<=1080]+ba/b" },
      { label: t("playlist_video_best"), format: "bv*+ba/b" }
    ];

    for (const opt of playlistOptions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = opt.label;
      btn.setAttribute("style", `
        display: block !important;
        width: 100% !important;
        border: 0 !important;
        background: transparent !important;
        color: #86e8ff !important;
        font: 600 12px/1.3 sans-serif !important;
        padding: 8px 16px !important;
        text-align: left !important;
        cursor: pointer !important;
        pointer-events: auto !important;
        transition: background 0.15s !important;
      `);
      btn.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
      btn.addEventListener("mouseenter", () => {
        btn.style.setProperty("background", "rgba(134,232,255,0.2)", "important");
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.setProperty("background", "transparent", "important");
      });
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closeQualityPicker();
        triggerCaptureWithFormat(candidate, opt.format, true);
      }, true);
      picker.appendChild(btn);
    }

    // 2. SINGLE VIDEO SECTION
    const singleHeader = document.createElement("div");
    singleHeader.setAttribute("style", `
      padding: 8px 14px 4px !important;
      font: 700 11px/1 sans-serif !important;
      color: #3dd29f !important;
      letter-spacing: 0.06em !important;
      text-transform: uppercase !important;
      border-top: 1px solid rgba(255,255,255,0.1) !important;
      margin-top: 6px !important;
    `);
    singleHeader.textContent = t("single_header");
    picker.appendChild(singleHeader);

    const singleOptions = [
      { label: t("single_best"), format: "bv*+ba/b" },
      { label: t("single_1080p"), format: "bv*[height<=1080]+ba/b" },
      { label: t("single_720p"), format: "bv*[height<=720]+ba/b" },
      { label: t("single_mp3"), format: "audio_mp3_320" }
    ];

    for (const opt of singleOptions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = opt.label;
      btn.setAttribute("style", `
        display: block !important;
        width: 100% !important;
        border: 0 !important;
        background: transparent !important;
        color: #e8e8e8 !important;
        font: 500 12px/1.3 sans-serif !important;
        padding: 7px 16px !important;
        text-align: left !important;
        cursor: pointer !important;
        pointer-events: auto !important;
        transition: background 0.15s !important;
      `);
      btn.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
      btn.addEventListener("mouseenter", () => {
        btn.style.setProperty("background", "rgba(61,210,159,0.18)", "important");
        btn.style.setProperty("color", "#3dd29f", "important");
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.setProperty("background", "transparent", "important");
        btn.style.setProperty("color", "#e8e8e8", "important");
      });
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closeQualityPicker();
        triggerCaptureWithFormat(candidate, opt.format, false);
      }, true);
      picker.appendChild(btn);
    }
  } else {
    // Normal single video / page options
    const qualities = [
      { label: t("single_best"), format: "bv*+ba/b" },
      { label: t("single_1080p"), format: "bv*[height<=1080]+ba/b" },
      { label: t("single_720p"), format: "bv*[height<=720]+ba/b" },
      { label: t("single_480p"), format: "bv*[height<=480]+ba/b" },
      { label: t("single_mp3"), format: "audio_mp3_320" },
      { label: t("single_flac"), format: "audio_flac" },
      { label: t("single_m4a"), format: "audio_m4a" }
    ];

    for (const quality of qualities) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = quality.label;
      btn.setAttribute("style", `
        display: block !important;
        width: 100% !important;
        border: 0 !important;
        background: transparent !important;
        color: #e8e8e8 !important;
        font: 500 13px/1 sans-serif !important;
        padding: 9px 16px !important;
        text-align: left !important;
        cursor: pointer !important;
        pointer-events: auto !important;
      `);
      btn.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
      btn.addEventListener("mouseenter", () => {
        btn.style.setProperty("background", "rgba(61,210,159,0.18)", "important");
        btn.style.setProperty("color", "#3dd29f", "important");
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.setProperty("background", "transparent", "important");
        btn.style.setProperty("color", "#e8e8e8", "important");
      });
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closeQualityPicker();
        triggerCaptureWithFormat(candidate, quality.format, false);
      }, true);
      picker.appendChild(btn);
    }
  }

  picker.style.setProperty("top", "50%", "important");
  picker.style.setProperty("left", "50%", "important");
  picker.style.setProperty("transform", "translate(-50%, -50%)", "important");

  document.documentElement.appendChild(picker);

  setTimeout(() => {
    document.addEventListener("pointerdown", handleQualityPickerOutsideClick, true);
  }, 100);
}

function closeQualityPicker() {
  document.removeEventListener("pointerdown", handleQualityPickerOutsideClick, true);
  const existing = document.getElementById("ldm-quality-picker");
  if (existing) existing.remove();
}

function handleQualityPickerOutsideClick(event) {
  const picker = document.getElementById("ldm-quality-picker");
  if (picker && !picker.contains(event.target)) {
    closeQualityPicker();
  }
}

function resolveSourcePageUrl(candidate, isPlaylist = false) {
  let url = candidate?.sourcePageUrl
    || (candidate?.url && /^https?:\/\/.*(reddit\.com|x\.com|twitter\.com|youtube\.com|facebook\.com|instagram\.com|tiktok\.com)\//.test(candidate.url) ? candidate.url : null)
    || window.location.href;

  if (isPlaylist) {
    if (window.location.href.includes("list=") && !url.includes("list=")) {
      url = window.location.href;
    }
  } else {
    if (url && (url.includes("youtube.com/watch") || url.includes("youtu.be/"))) {
      url = url.replace(/[?&](list|index|start_radio)=[^&]+/g, "");
      if (!url.includes("?") && url.includes("&")) {
        url = url.replace("&", "?");
      }
    }
  }
  return url;
}

function triggerCaptureWithFormat(candidate, format, isPlaylist = false) {
  showToast(isPlaylist ? t("sending_playlist") : t("sending_download"), "info");
  armCaptureTimeout();

  const sourcePageUrl = resolveSourcePageUrl(candidate, isPlaylist);

  if (candidate.kind === "media" || candidate.kind === "media-fallback") {
    sendExtensionMessage({
      type: "capture-best-media",
      payload: {
        preferredUrl: candidate.url ?? null,
        sourcePageUrl: sourcePageUrl,
        sourceTitle: candidate.title || document.title,
        format: format ?? null,
        isPlaylist: isPlaylist
      }
    }, (response) => {
      clearCaptureTimeout();
      if (chrome.runtime.lastError) {
        showToast(chrome.runtime.lastError.message, "error");
        return;
      }
      if (!response?.ok) {
        clearCaptureTimeout();
        showToast(response?.error ?? "Media capture failed.", "error");
        return;
      }
      pulseHoverButton();
    });
    return;
  }

  sendExtensionMessage({
    type: "capture-download",
    payload: {
      url: candidate.url,
      sourcePageUrl: sourcePageUrl,
      sourceTitle: document.title,
      format: format ?? null,
      isPlaylist: isPlaylist
    }
  }, (response) => {
    if (chrome.runtime.lastError) {
      clearCaptureTimeout();
      showToast(chrome.runtime.lastError.message, "error");
      return;
    }
    if (!response?.ok) {
      clearCaptureTimeout();
      showToast(response?.error ?? "Download request failed.", "error");
      return;
    }
    pulseHoverButton();
  });
}

function triggerCaptureForCandidate(candidate, anchorElement) {
  if (!candidate) {
    return;
  }

  if (isYtdlpSupportedSite()) {
    showQualityPicker(candidate, anchorElement);
    return;
  }

  triggerCaptureWithFormat(candidate, null);
}

function triggerCaptureOnce(candidate, anchorElement) {
  const now = Date.now();
  if (now - lastCaptureRequestAt < 2000) {
    return;
  }

  lastCaptureRequestAt = now;
  triggerCaptureForCandidate(candidate, anchorElement);
}

function pulseHoverButton() {
  if (!hoverButton) {
    return;
  }

  hoverButton.classList.add("ldm-hover-button-sent");
  window.setTimeout(() => {
    hoverButton?.classList.remove("ldm-hover-button-sent");
  }, 900);
}

function repositionHoverButton() {
  if (mediaOverlayRoot?.childElementCount > 0) {
    if (hoverButton) hoverButton.hidden = true;
    return;
  }
  if (!hoverButton || !activeCandidate) {
    hideHoverButton();
    return;
  }

  if (isStickyMediaCandidate(activeCandidate)) {
    const stickyElement = resolveCandidateAnchorElement(activeCandidate);
    if (stickyElement) {
      const rect = stickyElement.getBoundingClientRect();
      if (!isVisibleMediaRect(rect)) {
        hideHoverButton();
        return;
      }

      hoverButton.style.position = "absolute";
      hoverButton.style.right = "auto";
      hoverButton.style.top = `${Math.max(8, rect.top + window.scrollY + 10)}px`;
      hoverButton.style.left = `${Math.max(8, rect.right + window.scrollX - 44)}px`;
      hoverButton.hidden = false;
      return;
    }

    hoverButton.style.position = "fixed";
    hoverButton.style.top = "18px";
    hoverButton.style.left = "auto";
    hoverButton.style.right = "18px";
    hoverButton.hidden = false;
    return;
  }

  if (!activeCandidate.element?.isConnected) {
    hideHoverButton();
    return;
  }

  const rect = activeCandidate.element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    hideHoverButton();
    return;
  }

  hoverButton.style.position = "absolute";
  hoverButton.style.right = "auto";
  const top = Math.max(8, rect.top + window.scrollY - 10);
  const left = Math.max(8, rect.right + window.scrollX - 44);
  hoverButton.style.top = `${top}px`;
  hoverButton.style.left = `${left}px`;
  hoverButton.hidden = false;
}

function hideHoverButton() {
  activeCandidate = null;
  if (hoverButton) {
    hoverButton.hidden = true;
  }
}

function isStickyMediaCandidate(candidate) {
  return candidate?.kind === "media" || candidate?.kind === "media-fallback";
}

function isEventInsideActiveCandidate(event) {
  if (!activeCandidate?.element?.isConnected) {
    return false;
  }

  if (typeof event.clientX !== "number" || typeof event.clientY !== "number") {
    return false;
  }

  const rect = activeCandidate.element.getBoundingClientRect();
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}

function observePageChanges() {
  const observer = pageObserver = new MutationObserver(() => {
    detectLocationChange();
    scheduleCandidateReport();
    scheduleMediaRefresh();
    scheduleMediaOverlayRefresh();
    if (activeCandidate && !activeCandidate.element.isConnected && !isStickyMediaCandidate(activeCandidate)) {
      hideHoverButton();
    } else if (isStickyMediaCandidate(activeCandidate)) {
      const recoveredCandidate = resolvePersistentMediaCandidate();
      if (recoveredCandidate) {
        activeCandidate = recoveredCandidate;
        repositionHoverButton();
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href", "src", "download"]
  });
}

function handleMediaSignal(event) {
  if (event?.target instanceof Element) {
    if (window.location.hostname.includes("tiktok.com") && event.target.tagName === "VIDEO") {
      try {
        const info = extractTikTokPostInfo(event.target);
        if (info) {
          activeCandidate = {
            element: event.target,
            url: info.directSrc || info.postUrl,
            preferredUrl: info.directSrc || null,
            sourcePageUrl: (info.postUrl && info.postUrl.includes("/video/")) ? info.postUrl : window.location.href,
            title: info.desc,
            kind: "media-fallback"
          };
        }
      } catch (err) {}
    } else {
      const candidate = extractCandidateFromTarget(event.target);
      if (candidate) {
        activeCandidate = candidate;
        repositionHoverButton();
      }
    }
  }

  scheduleCandidateReport();
  scheduleMediaRefresh();
  scheduleMediaOverlayRefresh();
}

function handleRouteChange() {
  detectLocationChange(true);
}

function detectLocationChange(force = false) {
  if (!force && window.location.href === lastLocationHref) {
    return;
  }

  lastLocationHref = window.location.href;
  hideHoverButton();
  scheduleCandidateReport();
  scheduleMediaRefresh();
  scheduleMediaOverlayRefresh();
}

function startPeriodicRefresh() {
  if (periodicRefreshHandle) {
    window.clearInterval(periodicRefreshHandle);
  }

  periodicRefreshHandle = window.setInterval(() => {
    detectLocationChange();
    scheduleMediaRefresh();
    scheduleMediaOverlayRefresh();
  }, 1200);
}

function scheduleMediaRefresh() {
  if (extensionDisconnected) return;
  window.setTimeout(() => {
    reportObservedMediaCandidates();
    refreshRecentMediaCandidates();
  }, 180);
}

function scheduleMediaOverlayRefresh() {
  if (extensionDisconnected) return;
  if (mediaRefreshTimer) {
    window.clearTimeout(mediaRefreshTimer);
  }

  mediaRefreshTimer = window.setTimeout(() => {
    mediaRefreshTimer = null;
    refreshMediaOverlay();
  }, 120);
}

function scheduleCandidateReport() {
  if (extensionDisconnected) return;
  if (reportTimer) {
    window.clearTimeout(reportTimer);
  }

  reportTimer = window.setTimeout(() => {
    reportTimer = null;
    sendExtensionMessage({
      type: "candidate-count",
      count: countCandidates()
    });
  }, 120);
}

function countCandidates() {
  const seen = new Set();
  let count = 0;

  for (const element of document.querySelectorAll("a[href], video, audio, source")) {
    const candidate = extractCandidateFromTarget(element);
    if (!candidate || seen.has(candidate.url)) {
      continue;
    }

    seen.add(candidate.url);
    count += 1;
  }

  return count;
}

function extractCandidateFromPoint(event) {
  const pointCandidates = [];

  if (typeof event.clientX === "number" && typeof event.clientY === "number") {
    for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
      pointCandidates.push(element);
    }

    for (const mediaElement of findVisibleMediaAtPoint(event.clientX, event.clientY)) {
      pointCandidates.push(mediaElement);
    }
  }

  pointCandidates.push(event.target);

  for (const target of pointCandidates) {
    const candidate = extractCandidateFromTarget(target);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function extractCandidateFromTarget(target, depth = 0) {
  if (depth > 2 || !(target instanceof Element)) {
    return null;
  }

  const link = target.closest("a[href]");
  if (link) {
    const url = normalizeUrl(link.getAttribute("href"));
    if (url && isDownloadableLink(link, url)) {
      return { element: link, url };
    }
  }

  const mediaTarget = target.closest("video, audio, source");
  if (mediaTarget) {
    const mediaElement = mediaTarget.tagName === "SOURCE" && mediaTarget.parentElement
      ? mediaTarget.parentElement
      : mediaTarget;
    try {
      const url = resolveMediaUrl(mediaTarget, mediaElement);
      if (url && isMediaCandidate(url)) {
        return { element: mediaElement, url, kind: "media" };
      }
    } catch (err) {}

    if (mediaElement instanceof HTMLMediaElement) {
      return {
        element: mediaElement,
        url: recentMediaCandidates[0] ?? null,
        kind: "media-fallback"
      };
    }
  }

  if (depth === 0) {
    const mediaContainer = findMediaContainer(target);
    if (mediaContainer && mediaContainer !== target) {
      return extractCandidateFromMediaContainer(mediaContainer, depth + 1);
    }
  }

  return null;
}

function refreshMediaOverlay() {
  if (!mediaOverlayRoot) {
    return;
  }

  mediaOverlayRoot.replaceChildren();

  refreshInlineDownloadButtons();

  const host = window.location.hostname;
  if (/reddit\.com|youtube\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com/.test(host)) {
    return;
  }

  const overlayTargets = collectOverlayTargets();
  const activeOverlayTarget = resolveActiveOverlayTarget();
  if (activeOverlayTarget && !overlayTargets.some((target) => target.element === activeOverlayTarget.element)) {
    overlayTargets.unshift(activeOverlayTarget);
  }

  const persistentCandidate = resolvePersistentMediaCandidate();
  if (
    persistentCandidate &&
    !overlayTargets.some((target) => isSameCandidate(target.candidate, persistentCandidate))
  ) {
    const persistentElement = resolveCandidateAnchorElement(persistentCandidate);
    overlayTargets.unshift(
      persistentElement
        ? {
            element: persistentElement,
            candidate: persistentCandidate
          }
        : {
            candidate: persistentCandidate,
            pinned: true
          }
    );
  }

  for (const target of overlayTargets) {
    if (target.element?.querySelector?.(".ldm-inline-btn")) {
      continue;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ldm-media-button";
    button.textContent = t("download_btn");
    if (target.pinned) {
      // Without a player anchor, a floating button could cover the video.
      continue;
    } else {
      const rect = target.element.getBoundingClientRect();
      if (!isVisibleMediaRect(rect)) {
        continue;
      }

      button.style.setProperty("top", `${rect.top - 8}px`, "important");
      button.style.setProperty("left", `${rect.right - 8}px`, "important");
      button.style.setProperty("transform", "translate(-100%, -100%)", "important");
      button.style.setProperty("right", "auto", "important");
    }

    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      activeCandidate = target.candidate;
      triggerCaptureOnce(target.candidate, button);
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    mediaOverlayRoot.appendChild(button);
    if (hoverButton) hoverButton.hidden = true;
    break;
  }
}

function refreshInlineDownloadButtons() {
  const host = window.location.hostname;
  if (/youtube\.com/.test(host)) {
    injectYouTubeButton();
  }
  if (/reddit\.com/.test(host)) {
    injectRedditButtons();
  }
  if (/x\.com|twitter\.com/.test(host)) {
    injectTwitterButtons();
  }
  if (/instagram\.com/.test(host)) {
    injectInstagramButtons();
  }
  if (/facebook\.com|fb\.watch/.test(host)) {
    injectFacebookButtons();
  }
  if (/tiktok\.com/.test(host)) {
    injectTikTokButtons();
  }
}

function injectRedditButtons() {
  for (const player of document.querySelectorAll("shreddit-player, shreddit-player-2")) {
    if (player.querySelector(".ldm-site-btn")) continue;

    const post = player.closest("shreddit-post, article, [class*='Post']");
    if (!post) continue;
    if (post.querySelector(".ldm-site-btn")) continue;

    const btn = document.createElement("div");
    btn.className = "ldm-site-btn";
    btn.textContent = t("download_btn");
    btn.setAttribute("style", `
      display: block !important;
      z-index: 2147483647 !important;
      background: linear-gradient(135deg, #3dd29f, #86e8ff) !important;
      color: #04110d !important;
      border: 0 !important;
      border-radius: 6px !important;
      padding: 8px 16px !important;
      font: 700 12px/1 sans-serif !important;
      letter-spacing: 0.04em !important;
      cursor: pointer !important;
      pointer-events: auto !important;
      user-select: none !important;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15) !important;
      margin: 6px 0 !important;
      width: fit-content !important;
    `);

    btn.addEventListener("mouseenter", () => btn.style.setProperty("opacity", "1", "important"));
    btn.addEventListener("mouseleave", () => btn.style.setProperty("opacity", "0.85", "important"));
    btn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }, true);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      let hlsUrl = null;
      const shadowRoot = player.shadowRoot;
      if (shadowRoot) {
        const videoEl = shadowRoot.querySelector("video");
        if (videoEl && videoEl.src && !videoEl.src.startsWith("blob:")) {
          hlsUrl = videoEl.src;
        }
      }

      if (!hlsUrl) {
        const src = player.getAttribute("src")
          || player.getAttribute("packaged-media-json");
        if (src) {
          try {
            const data = JSON.parse(src);
            hlsUrl = data?.playbackMp4s?.permutations?.[0]?.source?.url
              || data?.hlsUrl
              || data?.fallbackUrl;
          } catch (_) {
            if (src.includes(".m3u8") || src.includes("v.redd.it")) {
              hlsUrl = src;
            }
          }
        }
      }

      if (!hlsUrl) {
        const permalink = player.closest("shreddit-post")?.getAttribute("permalink");
        if (permalink) {
          hlsUrl = "https://www.reddit.com" + permalink;
        }
      }

      if (hlsUrl) {
        const shredditPost = player.closest("shreddit-post");
        const postTitle = shredditPost?.getAttribute("post-title")
          || shredditPost?.querySelector('[slot="title"]')?.textContent?.trim()
          || post.querySelector("h1, h3, [data-testid='post-title']")?.textContent?.trim()
          || document.title;

        showToast("Sending download to Linux Download Manager...", "info");
        armCaptureTimeout();
        sendExtensionMessage({
          type: "capture-download",
          payload: {
            url: hlsUrl,
            sourcePageUrl: window.location.href,
            sourceTitle: postTitle
          }
        }, (response) => {
          if (chrome.runtime.lastError) {
            clearCaptureTimeout();
            showToast(chrome.runtime.lastError.message, "error");
            return;
          }
          if (!response?.ok) {
            clearCaptureTimeout();
            showToast(response?.error ?? "Download failed.", "error");
          }
        });
      } else {
        showToast(t("toast_no_url"), "error");
      }
    }, true);

    player.insertAdjacentElement("beforebegin", btn);
  }
}

function injectTwitterButtons() {
  for (const video of document.querySelectorAll("video")) {
    const videoContainer = video.closest('[data-testid="videoComponent"], [data-testid="videoPlayer"]') || video.parentElement;
    if (!videoContainer || videoContainer.querySelector(".ldm-site-btn")) continue;

    const tweet = video.closest("article");

    const rect = video.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 60) continue;

    let postUrl = null;
    const timeLink = tweet?.querySelector('a[href*="/status/"] time')?.closest("a");
    if (timeLink) postUrl = timeLink.href;
    else if (tweet?.querySelector('a[href*="/status/"]')) {
      postUrl = tweet.querySelector('a[href*="/status/"]').href;
    } else if (/\/status\/\d+/.test(window.location.pathname)) postUrl = window.location.href;

    const btn = document.createElement("div");
    btn.className = "ldm-site-btn";
    btn.textContent = "⬇ LDM";
    btn.setAttribute("style", `
      position: absolute !important;
      top: 8px !important;
      right: 8px !important;
      z-index: 2147483647 !important;
      background: linear-gradient(135deg, #3dd29f, #86e8ff) !important;
      color: #04110d !important;
      border: 0 !important;
      border-radius: 6px !important;
      padding: 6px 14px !important;
      font: 700 12px/1 sans-serif !important;
      cursor: pointer !important;
      pointer-events: auto !important;
      user-select: none !important;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4) !important;
      opacity: 0.85 !important;
      transition: opacity 0.15s !important;
    `);

    btn.addEventListener("mouseenter", () => btn.style.setProperty("opacity", "1", "important"));
    btn.addEventListener("mouseleave", () => btn.style.setProperty("opacity", "0.85", "important"));
    btn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }, true);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const tweetText = tweet?.querySelector('[data-testid="tweetText"]')?.textContent?.trim();
      const userName = tweet?.querySelector('[data-testid="User-Name"] a')?.textContent?.trim();
      const title = tweetText
        ? (tweetText.length > 80 ? tweetText.substring(0, 80) : tweetText)
        : (userName ? `${userName} video` : null);

      const candidate = {
        element: video,
        url: postUrl || null,
        kind: "media-fallback",
        title: title
      };
      activeCandidate = candidate;
      triggerCaptureForCandidate(candidate, btn);
    }, true);

    const parentPos = window.getComputedStyle(videoContainer).position;
    if (parentPos === "static") {
      videoContainer.style.setProperty("position", "relative", "");
    }
    videoContainer.appendChild(btn);
  }
}

function injectInstagramButtons() {
  for (const video of document.querySelectorAll("video")) {
    const videoContainer = video.closest("article, div[role='dialog'], [class*='x1lliihq']") || video.parentElement;
    if (!videoContainer || videoContainer.querySelector(".ldm-ig-btn")) continue;

    const rect = video.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) continue;

    let postUrl = null;
    if (window.location.pathname.includes("/reel/") || window.location.pathname.includes("/reels/") || window.location.pathname.includes("/p/")) {
      postUrl = window.location.href;
    } else {
      const link = videoContainer.querySelector('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"]') || document.querySelector('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"]');
      if (link && link.href) postUrl = link.href;
      else postUrl = window.location.href;
    }

    const btn = document.createElement("div");
    btn.className = "ldm-site-btn ldm-ig-btn";
    btn.textContent = "⬇ LDM";
    btn.setAttribute("style", `
      position: absolute !important;
      top: 12px !important;
      right: 12px !important;
      z-index: 2147483647 !important;
      background: linear-gradient(135deg, #3dd29f, #86e8ff) !important;
      color: #04110d !important;
      border: 0 !important;
      border-radius: 6px !important;
      padding: 6px 14px !important;
      font: 700 12px/1 sans-serif !important;
      letter-spacing: 0.04em !important;
      cursor: pointer !important;
      pointer-events: auto !important;
      user-select: none !important;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5) !important;
      opacity: 0.9 !important;
      transition: opacity 0.15s !important;
    `);

    btn.addEventListener("mouseenter", () => btn.style.setProperty("opacity", "1", "important"));
    btn.addEventListener("mouseleave", () => btn.style.setProperty("opacity", "0.9", "important"));
    btn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }, true);

    const triggerIgPicker = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const directSrc = (video.src && !video.src.startsWith("blob:")) ? video.src : (video.currentSrc && !video.currentSrc.startsWith("blob:") ? video.currentSrc : null);
      const title = document.title || "Instagram Video";
      const candidate = {
        element: video,
        url: directSrc,
        sourcePageUrl: postUrl,
        title: title,
        kind: "media-fallback"
      };
      activeCandidate = candidate;
      showQualityPicker(candidate, btn);
    };

    btn.addEventListener("click", triggerIgPicker, true);
    btn.addEventListener("contextmenu", triggerIgPicker, true);

    videoContainer.addEventListener("contextmenu", () => {
      const directSrc = (video.src && !video.src.startsWith("blob:")) ? video.src : (video.currentSrc && !video.currentSrc.startsWith("blob:") ? video.currentSrc : null);
      activeCandidate = {
        element: video,
        url: directSrc,
        sourcePageUrl: postUrl,
        title: document.title || "Instagram Video",
        kind: "media-fallback"
      };
    }, true);

    const parentPos = window.getComputedStyle(videoContainer).position;
    if (parentPos === "static") {
      videoContainer.style.setProperty("position", "relative", "");
    }
    videoContainer.appendChild(btn);
  }
}

function injectFacebookButtons() {
  for (const video of document.querySelectorAll("video")) {
    const videoContainer = video.closest("div[data-pagelet*='Video'], div[role='article'], div[data-video-id], div[class*='k4urcfbm']") || video.parentElement;
    if (!videoContainer || videoContainer.querySelector(".ldm-fb-btn")) continue;

    const rect = video.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) continue;

    let postUrl = null;
    if (window.location.pathname.includes("/videos/") || window.location.pathname.includes("/watch") || window.location.pathname.includes("/reel")) {
      postUrl = window.location.href;
    } else {
      const link = videoContainer.querySelector('a[href*="/videos/"], a[href*="/watch"], a[href*="/reel/"], a[href*="/share/v/"], a[href*="/share/r/"]') || document.querySelector('a[href*="/videos/"], a[href*="/watch"]');
      if (link && link.href) postUrl = link.href;
      else postUrl = window.location.href;
    }

    const btn = document.createElement("div");
    btn.className = "ldm-site-btn ldm-fb-btn";
    btn.textContent = "⬇ LDM";
    btn.setAttribute("style", `
      position: absolute !important;
      top: 12px !important;
      right: 12px !important;
      z-index: 2147483647 !important;
      background: linear-gradient(135deg, #3dd29f, #86e8ff) !important;
      color: #04110d !important;
      border: 0 !important;
      border-radius: 6px !important;
      padding: 6px 14px !important;
      font: 700 12px/1 sans-serif !important;
      letter-spacing: 0.04em !important;
      cursor: pointer !important;
      pointer-events: auto !important;
      user-select: none !important;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5) !important;
      opacity: 0.9 !important;
      transition: opacity 0.15s !important;
    `);

    btn.addEventListener("mouseenter", () => btn.style.setProperty("opacity", "1", "important"));
    btn.addEventListener("mouseleave", () => btn.style.setProperty("opacity", "0.9", "important"));
    btn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }, true);
    const triggerFbPicker = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const directSrc = (video.src && !video.src.startsWith("blob:")) ? video.src : (video.currentSrc && !video.currentSrc.startsWith("blob:") ? video.currentSrc : null);
      const title = document.title || "Facebook Video";
      const candidate = {
        element: video,
        url: directSrc,
        sourcePageUrl: postUrl,
        title: title,
        kind: "media-fallback"
      };
      activeCandidate = candidate;
      showQualityPicker(candidate, btn);
    };

    btn.addEventListener("click", triggerFbPicker, true);
    btn.addEventListener("contextmenu", triggerFbPicker, true);

    videoContainer.addEventListener("contextmenu", () => {
      const directSrc = (video.src && !video.src.startsWith("blob:")) ? video.src : (video.currentSrc && !video.currentSrc.startsWith("blob:") ? video.currentSrc : null);
      activeCandidate = {
        element: video,
        url: directSrc,
        sourcePageUrl: postUrl,
        title: document.title || "Facebook Video",
        kind: "media-fallback"
      };
    }, true);

    const parentPos = window.getComputedStyle(videoContainer).position;
    if (parentPos === "static") {
      videoContainer.style.setProperty("position", "relative", "");
    }
    videoContainer.appendChild(btn);
  }
}

function isValidTikTokVideoStream(url) {
  if (!url || typeof url !== "string") return false;
  if (/monitor_web|webmssdk|telemetry|analytics|log_web|webcast|falcon|report|mon\.tiktok|mon-sg|mcs\.tiktok|passport|login|logout|location|check_in/i.test(url)) return false;
  if (/\.(json|js|css|svg|png|jpe?g|ico|webp|gif)($|\?)/i.test(url)) return false;

  const isTikTokCdnHost = /(tiktokcdn\.com|tiktokv\.com|tiktok\.com|pstatp\.com|akamaized\.net|ibyteimg\.com|byteoversea\.com)/i.test(url);
  if (!isTikTokCdnHost) return false;

  const hasVideoMarker = (/video\/tos/i.test(url) || /\.mp4($|\?)/i.test(url) || /mime_type=video/i.test(url) || /playAddr/i.test(url) || /range=\d+/i.test(url) || /&vr=/i.test(url) || /&btag=/i.test(url));
  return hasVideoMarker;
}

function extractTikTokPostInfo(video) {
  let postUrl = null;
  let videoId = null;
  let author = "tiktok";
  let desc = "";
  let directSrc = null;

  if (window.location.pathname.includes("/video/")) {
    postUrl = window.location.href;
    const m = window.location.pathname.match(/\/video\/(\d+)/);
    if (m) videoId = m[1];
  }

  // 1. Walk up from video to find root card
  let card = video;
  let rootCard = null;
  while (card && card !== document.body) {
    if (card.querySelector('a[href*="/@"]') || card.querySelector('a[href*="/video/"]') || card.querySelector('[data-e2e*="desc"]')) {
      rootCard = card;
      if (card.getAttribute('data-e2e') || /ItemContainer|FeedItem/i.test(card.className || "")) {
        break;
      }
    }
    card = card.parentElement;
  }
  rootCard = rootCard || video.parentElement;

  // 2. Extract description & author
  if (rootCard) {
    const descEl = rootCard.querySelector('[data-e2e*="desc"], [class*="desc"], h1, [data-e2e="user-post-item-desc"]');
    if (descEl && descEl.textContent) {
      desc = descEl.textContent.trim();
    }
    const authorEl = rootCard.querySelector('a[href*="/@"]');
    if (authorEl) {
      const href = authorEl.getAttribute("href") || "";
      const am = href.match(/@([a-zA-Z0-9_\.]+)/);
      if (am) author = am[1];
    }

    const link = rootCard.querySelector('a[href*="/video/"]');
    if (link && link.href && link.href.includes("/video/")) {
      postUrl = link.href;
      const m = link.href.match(/\/video\/(\d+)/);
      if (m) videoId = m[1];
    }

    if (!videoId) {
      const allEls = [rootCard, ...rootCard.querySelectorAll("*")];
      for (const el of allEls) {
        const elId = el.id || "";
        const m = elId.match(/(\d{18,20})/);
        if (m) { videoId = m[1]; break; }
        for (const attr of el.getAttributeNames()) {
          const val = el.getAttribute(attr);
          const am = val?.match(/(\d{18,20})/);
          if (am) { videoId = am[1]; break; }
        }
        if (videoId) break;
      }
    }
  }

  // 3. Inspect React Fiber / Props for itemStruct
  if (!videoId || !directSrc) {
    let el = video;
    while (el && el !== document.body) {
      const keys = Object.keys(el);
      const reactKey = keys.find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$"));
      if (reactKey) {
        try {
          let fiber = el[reactKey];
          for (let d = 0; d < 8 && fiber; d++) {
            const item = fiber.memoizedProps?.itemInfo?.itemStruct || 
                         fiber.memoizedProps?.videoData || 
                         fiber.memoizedProps?.item ||
                         fiber.pendingProps?.itemInfo?.itemStruct ||
                         fiber.return?.memoizedProps?.itemInfo?.itemStruct;
            if (item) {
              if (item.id || item.awemeId) {
                videoId = item.id || item.awemeId;
                author = item.author?.uniqueId || author;
              }
              if (!desc && item.desc) desc = item.desc;
              const pUrl = item.video?.playAddr || item.video?.downloadAddr;
              if (pUrl && isValidTikTokVideoStream(pUrl)) {
                directSrc = pUrl;
              }
              break;
            }
            fiber = fiber.return;
          }
        } catch (e) {}
      }
      if (videoId && directSrc) break;
      el = el.parentElement;
    }
  }

  // 4. Closest <a> tag on entire page
  if (!postUrl && !videoId) {
    const allLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    if (allLinks.length > 0) {
      const vRect = video.getBoundingClientRect();
      let closest = null;
      let minDist = Infinity;
      for (const a of allLinks) {
        const aRect = a.getBoundingClientRect();
        const dist = Math.hypot(aRect.top - vRect.top, aRect.left - vRect.left);
        if (dist < minDist) {
          minDist = dist;
          closest = a;
        }
      }
      if (closest && closest.href) {
        postUrl = closest.href;
        const m = closest.href.match(/\/video\/(\d+)/);
        if (m) videoId = m[1];
      }
    }
  }

  if (videoId && (!postUrl || !postUrl.includes("/video/"))) {
    postUrl = `https://www.tiktok.com/@${author}/video/${videoId}`;
  }

  // 5. Direct stream from video.src or performance
  if (!directSrc) {
    if (video.src && !video.src.startsWith("blob:") && isValidTikTokVideoStream(video.src)) {
      directSrc = video.src;
    } else if (video.currentSrc && !video.currentSrc.startsWith("blob:") && isValidTikTokVideoStream(video.currentSrc)) {
      directSrc = video.currentSrc;
    } else if (window.performance) {
      const perfEntries = window.performance.getEntriesByType("resource");
      for (let i = perfEntries.length - 1; i >= 0; i--) {
        const name = perfEntries[i].name;
        if (isValidTikTokVideoStream(name)) {
          directSrc = name;
          break;
        }
      }
    }
  }

  if (!desc) {
    desc = document.title || "TikTok Video";
  }

  return {
    postUrl: postUrl || window.location.href,
    videoId,
    author,
    desc,
    directSrc
  };
}

function injectTikTokButtons() {
  for (const video of document.querySelectorAll("video")) {
    const videoContainer = video.closest("div[data-e2e='recommend-list-item-container'], div[data-e2e='feed-video'], div[class*='DivItemContainer'], div[class*='DivVideoWrapper'], div[data-e2e='user-post-item']") || video.parentElement;
    if (!videoContainer || videoContainer.querySelector(".ldm-tiktok-btn")) continue;

    const rect = video.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) continue;

    const btn = document.createElement("div");
    btn.className = "ldm-site-btn ldm-tiktok-btn";
    btn.textContent = "⬇ LDM";
    btn.setAttribute("style", `
      position: absolute !important;
      top: 12px !important;
      right: 12px !important;
      z-index: 2147483647 !important;
      background: linear-gradient(135deg, #3dd29f, #86e8ff) !important;
      color: #04110d !important;
      border: 0 !important;
      border-radius: 6px !important;
      padding: 6px 14px !important;
      font: 700 12px/1 sans-serif !important;
      letter-spacing: 0.04em !important;
      cursor: pointer !important;
      pointer-events: auto !important;
      user-select: none !important;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5) !important;
      opacity: 0.9 !important;
      transition: opacity 0.15s !important;
    `);

    btn.addEventListener("mouseenter", () => btn.style.setProperty("opacity", "1", "important"));
    btn.addEventListener("mouseleave", () => btn.style.setProperty("opacity", "0.9", "important"));
    btn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }, true);

    const triggerTikTokPicker = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const info = extractTikTokPostInfo(video);
      const targetUrl = (info.directSrc && isValidTikTokVideoStream(info.directSrc))
        ? info.directSrc
        : ((info.postUrl && info.postUrl.includes("/video/")) ? info.postUrl : (info.directSrc || info.postUrl));

      const candidate = {
        element: video,
        url: targetUrl,
        preferredUrl: info.directSrc || null,
        sourcePageUrl: (info.postUrl && info.postUrl.includes("/video/")) ? info.postUrl : window.location.href,
        title: info.desc,
        kind: "media-fallback"
      };
      activeCandidate = candidate;
      showQualityPicker(candidate, btn);
    };

    btn.addEventListener("click", triggerTikTokPicker, true);
    btn.addEventListener("contextmenu", triggerTikTokPicker, true);

    videoContainer.addEventListener("contextmenu", () => {
      const info = extractTikTokPostInfo(video);
      const targetUrl = (info.directSrc && isValidTikTokVideoStream(info.directSrc))
        ? info.directSrc
        : ((info.postUrl && info.postUrl.includes("/video/")) ? info.postUrl : (info.directSrc || info.postUrl));
      activeCandidate = {
        element: video,
        url: targetUrl,
        preferredUrl: info.directSrc || null,
        sourcePageUrl: (info.postUrl && info.postUrl.includes("/video/")) ? info.postUrl : window.location.href,
        title: info.desc,
        kind: "media-fallback"
      };
    }, true);

    const parentPos = window.getComputedStyle(videoContainer).position;
    if (parentPos === "static") {
      videoContainer.style.setProperty("position", "relative", "");
    }
    videoContainer.appendChild(btn);
  }
}

function injectYouTubeButton() {
  if (document.getElementById("ldm-yt-download-btn")) return;

  const player = document.querySelector("#movie_player, .html5-video-player");
  if (!player) return;

  const btn = document.createElement("div");
  btn.id = "ldm-yt-download-btn";
  btn.textContent = "LDM";
  btn.setAttribute("style", `
    position: absolute !important;
    top: 12px !important;
    left: 12px !important;
    z-index: 2147483647 !important;
    background: linear-gradient(135deg, #3dd29f, #86e8ff) !important;
    color: #04110d !important;
    border: 0 !important;
    border-radius: 6px !important;
    padding: 8px 16px !important;
    font: 700 13px/1 sans-serif !important;
    letter-spacing: 0.08em !important;
    cursor: pointer !important;
    text-transform: uppercase !important;
    opacity: 0.85 !important;
    pointer-events: auto !important;
    user-select: none !important;
    transition: opacity 0.15s !important;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4) !important;
  `);

  btn.addEventListener("mouseenter", () => {
    btn.style.setProperty("opacity", "1", "important");
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.setProperty("opacity", "0.85", "important");
  });

  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);

  btn.addEventListener("pointerup", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const videoEl = document.querySelector("#movie_player video");
    const candidate = {
      element: videoEl || null,
      url: null,
      kind: "media-fallback"
    };
    activeCandidate = candidate;
    triggerCaptureForCandidate(candidate, btn);
  }, true);

  player.style.setProperty("position", "relative", "");
  player.appendChild(btn);
}

function isSameCandidate(left, right) {
  return left?.url === right?.url && left?.kind === right?.kind;
}

function collectOverlayTargets() {
  const results = [];
  const seen = new Set();

  for (const container of document.querySelectorAll(MEDIA_CONTAINER_SELECTOR)) {
    if (!(container instanceof Element)) {
      continue;
    }

    const candidate = extractCandidateFromMediaContainer(container);
    if (!candidate) {
      continue;
    }

    if (seen.has(candidate.element)) {
      continue;
    }

    seen.add(candidate.element);
    results.push({ element: candidate.element, candidate });
  }

  for (const mediaElement of document.querySelectorAll("video, audio")) {
    if (!(mediaElement instanceof HTMLMediaElement)) {
      continue;
    }

    const candidate = extractCandidateFromTarget(mediaElement);
    if (!candidate) {
      continue;
    }

    const overlayElement = resolveOverlayElement(mediaElement);
    if (!overlayElement) {
      continue;
    }

    if (seen.has(overlayElement)) {
      continue;
    }
    seen.add(overlayElement);
    results.push({ element: overlayElement, candidate });
  }

  return results;
}

function extractCandidateFromMediaContainer(container, depth = 0) {
  if (depth > 2 || !(container instanceof Element)) {
    return null;
  }

  if (!looksLikeMediaSurface(container)) {
    return null;
  }

  const mediaElement = container.querySelector("video, audio, source");
  if (mediaElement instanceof Element) {
    const mediaCandidate = extractCandidateFromTarget(mediaElement, depth + 1);
    if (mediaCandidate) {
      return {
        ...mediaCandidate,
        element: resolveOverlayElement(
          mediaElement.tagName === "SOURCE" && mediaElement.parentElement
            ? mediaElement.parentElement
            : mediaElement
        )
      };
    }

    return {
      element: container,
      url: recentMediaCandidates[0] ?? null,
      kind: "media-fallback"
    };
  }

  const url = resolveMediaContainerUrl(container);
  if (url && isMediaCandidate(url)) {
    return {
      element: container,
      url,
      kind: "media"
    };
  }

  if (recentMediaCandidates.length > 0) {
    return {
      element: container,
      url: recentMediaCandidates[0],
      kind: "media-fallback"
    };
  }

  return null;
}

function resolveActiveOverlayTarget() {
  if (!activeCandidate) {
    return null;
  }

  const overlayElement = resolveCandidateAnchorElement(activeCandidate);
  if (!(overlayElement instanceof Element)) {
    return null;
  }

  return {
    element: overlayElement,
    candidate: activeCandidate
  };
}

function resolveCandidateAnchorElement(candidate) {
  if (!candidate?.element) {
    return null;
  }

  if (candidate.element instanceof HTMLMediaElement) {
    return resolveOverlayElement(candidate.element);
  }

  if (!(candidate.element instanceof Element)) {
    return null;
  }

  const nestedMedia = candidate.element.querySelector("video, audio");
  if (nestedMedia instanceof HTMLMediaElement) {
    return resolveOverlayElement(nestedMedia);
  }

  const mediaContainer = findMediaContainer(candidate.element);
  if (mediaContainer && looksLikeMediaSurface(mediaContainer)) {
    return mediaContainer;
  }

  if (looksLikeMediaSurface(candidate.element)) {
    return candidate.element;
  }

  return null;
}

function resolveOverlayElement(mediaElement) {
  const overlayElement = resolveGenericOverlayElement(mediaElement);
  if (overlayElement) {
    return overlayElement;
  }

  return mediaElement;
}

function resolveGenericOverlayElement(mediaElement, preferredContainer = null) {
  const mediaRect = mediaElement.getBoundingClientRect();
  const containers = collectOverlayContainers(mediaElement, preferredContainer);

  let bestContainer = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const container of containers) {
    const rect = container.getBoundingClientRect();
    if (!isVisibleMediaRect(rect)) {
      continue;
    }

    if (!rectContains(rect, mediaRect)) {
      continue;
    }

    const areaRatio = (rect.width * rect.height) / Math.max(1, mediaRect.width * mediaRect.height);
    const offset =
      Math.abs(rect.left - mediaRect.left) +
      Math.abs(rect.top - mediaRect.top) +
      Math.abs(rect.right - mediaRect.right) +
      Math.abs(rect.bottom - mediaRect.bottom);
    const score = Math.abs(areaRatio - 1) * 100 + offset;
    if (score < bestScore) {
      bestScore = score;
      bestContainer = container;
    }
  }

  return bestContainer;
}

function collectOverlayContainers(mediaElement, preferredContainer = null) {
  const containers = [];
  const seen = new Set();

  const addContainer = (element) => {
    if (!(element instanceof Element) || seen.has(element)) {
      return;
    }

    seen.add(element);
    containers.push(element);
  };

  addContainer(preferredContainer);
  addContainer(mediaElement.parentElement);
  addContainer(mediaElement.closest("figure"));
  addContainer(mediaElement.closest("picture"));
  addContainer(mediaElement.closest('[data-testid*="video" i]'));
  addContainer(mediaElement.closest('[data-testid*="media" i]'));
  addContainer(mediaElement.closest('[class*="video" i]'));
  addContainer(mediaElement.closest('[class*="player" i]'));
  addContainer(mediaElement.closest('[class*="media" i]'));
  addContainer(mediaElement.closest('[role="dialog"]'));
  addContainer(mediaElement.closest('[role="button"]'));
  addContainer(mediaElement.closest('[role="link"]'));
  addContainer(mediaElement.closest("a[href]"));
  addContainer(mediaElement.closest("article"));
  addContainer(mediaElement.closest("section"));

  let ancestor = mediaElement.parentElement;
  let depth = 0;
  while (ancestor && depth < 7) {
    addContainer(ancestor);
    ancestor = ancestor.parentElement;
    depth += 1;
  }

  return containers;
}

function showToast(message, tone = "info") {
  if (!toastRoot) {
    return;
  }

  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }

  const toast = document.createElement("div");
  toast.className = `ldm-toast ldm-toast-${tone}`;
  toast.textContent = message;
  toastRoot.replaceChildren(toast);

  toastTimer = window.setTimeout(() => {
    toastRoot?.replaceChildren();
  }, 4500);
}

function findMediaContainer(target) {
  if (!(target instanceof Element)) {
    return null;
  }

  const container = target.closest(MEDIA_CONTAINER_SELECTOR);
  return container instanceof Element ? container : null;
}

function armCaptureTimeout() {
  clearCaptureTimeout();
  captureTimeout = window.setTimeout(() => {
    showToast("No response from extension background. Reload the extension and try again.", "error");
  }, 2500);
}

function clearCaptureTimeout() {
  if (captureTimeout) {
    window.clearTimeout(captureTimeout);
    captureTimeout = null;
  }
}

function isVisibleMediaRect(rect) {
  if (rect.width < 80 || rect.height < 60) {
    return false;
  }

  if (rect.bottom < 0 || rect.right < 0) {
    return false;
  }

  if (rect.top > window.innerHeight || rect.left > window.innerWidth) {
    return false;
  }

  return true;
}

function rectContains(outer, inner) {
  return (
    outer.left <= inner.left + 4 &&
    outer.top <= inner.top + 4 &&
    outer.right >= inner.right - 4 &&
    outer.bottom >= inner.bottom - 4
  );
}

function findVisibleMediaAtPoint(clientX, clientY) {
  const matches = [];
  for (const mediaElement of document.querySelectorAll("video, audio")) {
    if (!(mediaElement instanceof HTMLMediaElement)) {
      continue;
    }

    const rect = mediaElement.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) {
      continue;
    }

    const insideX = clientX >= rect.left && clientX <= rect.right;
    const insideY = clientY >= rect.top && clientY <= rect.bottom;
    if (insideX && insideY) {
      matches.push(mediaElement);
    }
  }

  return matches;
}

function normalizeUrl(rawUrl) {
  if (!rawUrl) {
    return null;
  }

  try {
    const url = new URL(rawUrl, window.location.href);
    if (!/^https?:$/i.test(url.protocol)) {
      return null;
    }

    return url.toString();
  } catch (error) {
    return null;
  }
}

function looksLikeMediaSurface(element) {
  if (!(element instanceof Element)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (!isVisibleMediaRect(rect)) {
    return false;
  }

  if (rect.width < 180 || rect.height < 120) {
    return false;
  }

  const hasMediaChildren = Boolean(element.querySelector("video, audio, source, img, canvas"));
  const hasPlayableRole =
    element.matches('[role="button"], [role="link"], a[href]') ||
    element.querySelector('[aria-label*="play" i], [data-testid*="play" i], button');
  return hasMediaChildren || Boolean(hasPlayableRole);
}

function resolveMediaContainerUrl(container) {
  if (!(container instanceof Element)) {
    return null;
  }

  for (const attribute of MEDIA_SOURCE_ATTRIBUTES) {
    const url = normalizeUrl(container.getAttribute(attribute));
    if (url) {
      return url;
    }
  }

  for (const node of container.querySelectorAll("[src], [data-src], [data-url], [data-video-src], [data-video-url], [data-stream], [data-stream-url], [data-hls], [data-mpd]")) {
    if (!(node instanceof Element)) {
      continue;
    }

    for (const attribute of MEDIA_SOURCE_ATTRIBUTES) {
      const url = normalizeUrl(node.getAttribute(attribute));
      if (url) {
        return url;
      }
    }
  }

  return null;
}

function resolveMediaUrl(mediaTarget, mediaElement) {
  try {
    const directCandidates = [
      mediaTarget instanceof HTMLMediaElement ? mediaTarget.currentSrc : null,
      mediaElement instanceof HTMLMediaElement ? mediaElement.currentSrc : null
    ];

    for (const candidate of directCandidates) {
      const url = normalizeUrl(candidate);
      if (url) {
        return url;
      }
    }

    const nodesToInspect = new Set();
    if (mediaTarget instanceof Element) nodesToInspect.add(mediaTarget);
    if (mediaElement instanceof Element) {
      nodesToInspect.add(mediaElement);
      const childSources = mediaElement.querySelectorAll("source, [src], [data-src], [data-url]");
      for (const node of childSources) {
        nodesToInspect.add(node);
      }
    }

    for (const node of nodesToInspect) {
      if (!(node instanceof Element)) {
        continue;
      }

      for (const attribute of MEDIA_SOURCE_ATTRIBUTES) {
        const url = normalizeUrl(node.getAttribute(attribute));
        if (url) {
          return url;
        }
      }
    }

    for (const candidate of recentMediaCandidates) {
      if (isMediaCandidate(candidate.url)) {
        return candidate.url;
      }
    }
  } catch (err) {
    console.warn("[LDM] resolveMediaUrl caught error:", err);
  }

  return null;
}

function resolvePersistentMediaCandidate() {
  for (const mediaElement of document.querySelectorAll("video, audio")) {
    if (!(mediaElement instanceof HTMLMediaElement)) {
      continue;
    }

    if (!isVisibleMediaRect(mediaElement.getBoundingClientRect())) {
      continue;
    }

    if (!mediaElement.paused || mediaElement.readyState > 1) {
      const candidate = extractCandidateFromTarget(mediaElement);
      if (candidate) {
        return candidate;
      }
    }
  }

  for (const mediaElement of document.querySelectorAll("video, audio")) {
    if (!(mediaElement instanceof HTMLMediaElement)) {
      continue;
    }

    if (!isVisibleMediaRect(mediaElement.getBoundingClientRect())) {
      continue;
    }

    const candidate = extractCandidateFromTarget(mediaElement);
    if (candidate) {
      return candidate;
    }
  }

  for (const container of document.querySelectorAll(MEDIA_CONTAINER_SELECTOR)) {
    if (!(container instanceof Element)) {
      continue;
    }

    const candidate = extractCandidateFromMediaContainer(container);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function isDownloadableLink(link, url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;
  if (link.hasAttribute("download")) {
    return true;
  }

  const parsedUrl = new URL(normalized);
  if (parsedUrl.searchParams.has("download")) {
    return true;
  }

  const extension = parsedUrl.pathname.toLowerCase().split(".").pop();
  return DOWNLOADABLE_EXTENSIONS.has(extension);
}

function isMediaCandidate(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;
  const parsedUrl = new URL(normalized);
  const extension = parsedUrl.pathname.toLowerCase().split(".").pop();
  return DOWNLOADABLE_EXTENSIONS.has(extension) || ["m3u8", "mpd", "m4s", "ts", "aac"].includes(extension);
}

function refreshRecentMediaCandidates() {
  sendExtensionMessage({ type: "get-media-candidates" }, (response) => {
    if (chrome.runtime.lastError) {
      return;
    }

    if (!response?.ok || !Array.isArray(response.candidates)) {
      return;
    }

    // Filter out audio-only and fragment streams from candidates so user downloads full video
    const valid = response.candidates
      .filter((candidate) => candidate?.streamKind !== "audio" && candidate?.streamKind !== "fragment");

    // Master manifest takes absolute priority
    const master = valid.find(c => c.streamKind === "master" || /\/(master|index)\./i.test(c.url));
    const sorted = master 
      ? [master, ...valid.filter(c => c.url !== master.url)]
      : valid;

    recentMediaCandidates = (sorted.length > 0 ? sorted : response.candidates)
      .map((candidate) => normalizeUrl(candidate?.url))
      .filter(Boolean);
  });
}

function reportObservedMediaCandidates() {
  if (extensionDisconnected) return;
  sendExtensionMessage({type: "capture-diagnostic-frame",
    media: Array.from(document.querySelectorAll("video, audio")).map(m => ({
      src: m.currentSrc || m.src, readyState: m.readyState, paused: m.paused})),
    embeds: Array.from(document.querySelectorAll("iframe")).map(f => f.src),
    resourceCount: performance.getEntriesByType("resource").length
  }, () => void chrome.runtime.lastError);
  const candidates = [];
  const seen = new Set();
  const referrerUrl = window.location.href;
  const observedHeaders = {
    "referer": referrerUrl,
    "user-agent": navigator.userAgent,
    "accept": "*/*"
  };
  if (window.location.origin && window.location.origin !== "null") {
    observedHeaders.origin = window.location.origin;
  }

  const remember = (url, type = "observed") => {
    const normalized = normalizeUrl(url);
    if (!normalized || seen.has(normalized) || (!["media", "audio"].includes(type) && !isLikelyObservedMediaUrl(normalized))) {
      return;
    }

    seen.add(normalized);
    candidates.push({
      url: normalized,
      type,
      referrerUrl,
      httpHeaders: observedHeaders
    });
  };

  for (const mediaElement of document.querySelectorAll("video, audio")) {
    if (!(mediaElement instanceof HTMLMediaElement)) {
      continue;
    }

    const mediaType = mediaElement.tagName === "AUDIO" ? "audio" : "media";
    remember(mediaElement.currentSrc, mediaType);
    remember(mediaElement.src, mediaType);

    for (const source of mediaElement.querySelectorAll("source")) {
      if (!(source instanceof HTMLSourceElement)) {
        continue;
      }

      remember(source.src, mediaType);
      remember(source.getAttribute("src"), mediaType);
    }
  }

  for (const entry of performance.getEntriesByType("resource")) {
    if (!entry || typeof entry.name !== "string") {
      continue;
    }

    const initiatorType = typeof entry.initiatorType === "string" ? entry.initiatorType : "observed";
    if (["video", "audio", "xmlhttprequest", "fetch", "other"].includes(initiatorType) || isLikelyObservedMediaUrl(entry.name)) {
      remember(entry.name, initiatorType);
    }
  }

  for (const url of playerManifests) {
    candidates.unshift({url, type: "observed-manifest", referrerUrl, httpHeaders: observedHeaders});
  }
  if (candidates.length === 0) return;

  sendExtensionMessage({
    type: "remember-media-candidates",
    candidates: candidates.slice(0, 24)
  }, () => void chrome.runtime.lastError);
}

function isLikelyObservedMediaUrl(url) {
  try {
    const parsedUrl = new URL(url);
    if (!/^https?:$/i.test(parsedUrl.protocol)) {
      return false;
    }

    const pathname = parsedUrl.pathname.toLowerCase();
    const extension = pathname.split(".").pop();
    if (IMAGE_EXTENSIONS.has(extension)) {
      return false;
    }
    if (DOWNLOADABLE_EXTENSIONS.has(extension) || ["m3u8", "mpd", "m4s", "ts", "aac", "m3u"].includes(extension)) {
      return true;
    }

    const mimeType =
      parsedUrl.searchParams.get("mime_type") ||
      parsedUrl.searchParams.get("mime") ||
      parsedUrl.searchParams.get("content_type") ||
      "";
    if (/video|audio/i.test(mimeType)) {
      return true;
    }

    if (/\/(videoplayback|manifest|playlist|master|hls|dash)\b/i.test(pathname)) {
      return true;
    }

    if (/(^|\.)fbcdn\.net$/i.test(parsedUrl.hostname) || /(^|\.)cdninstagram\.com$/i.test(parsedUrl.hostname)) {
      return true;
    }

    if (parsedUrl.searchParams.has("bytestart") || parsedUrl.searchParams.has("byteend")) {
      return true;
    }

    const formatHint =
      parsedUrl.searchParams.get("format") ||
      parsedUrl.searchParams.get("ext") ||
      parsedUrl.searchParams.get("filename") ||
      "";
    return /\.(mp4|webm|mov|mkv|mp3|m4a|m3u8|mpd)\b/i.test(formatHint);
  } catch (error) {
    return false;
  }
}

/* ─── LDM Collapsible In-Page Drawer Logic ──────────────────────────────── */
(function initLdmDrawer() {
  if (window !== window.top) return;

  let panelVisible = false;
  let pollTimer = null;

  const root = document.createElement("div");
  root.className = "ldm-widget-root";

  const badge = document.createElement("div");
  badge.className = "ldm-drawer-badge";
  badge.innerHTML = `<span>⚡</span> <span>${t("downloader_badge")}</span> <span>▲</span>`;
  badge.title = t("panel_title");

  const panel = document.createElement("div");
  panel.className = "ldm-drawer-panel is-hidden";
  panel.innerHTML = `
    <div class="ldm-drawer-header">
      <div class="ldm-drawer-title">
        <span style="color:#00d287;">⚡</span> Linux Download Manager
      </div>
      <div class="ldm-drawer-actions">
        <select id="ldm-lang-select" style="background:#1e2430; color:#8b9eb5; border:1px solid rgba(255,255,255,0.15); border-radius:4px; font-size:10px; padding:2px 3px; cursor:pointer; outline:none;" title="${t("lang_label")}"></select>
        <button class="ldm-icon-btn" id="ldm-btn-clear" title="${t("clear_history")}">🧹</button>
        <button class="ldm-icon-btn" id="ldm-btn-dash" title="${t("open_panel")}">🌐</button>
        <button class="ldm-icon-btn" id="ldm-btn-close" title="${t("close_panel")}">✕</button>
      </div>
    </div>
    <div class="ldm-drawer-body" id="ldm-drawer-items">
      <div style="text-align:center; padding:30px 10px; color:#8b9eb5;">...</div>
    </div>
    <div class="ldm-drawer-footer" style="padding: 7px 12px; background: rgba(0,0,0,0.4); border-top: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #8b9eb5;">
      <div style="display:flex; align-items:center; gap:5px;">
        <span id="ldm-txt-speed" title="${t("speed_label")}">${t("speed_label")}</span>
        <select id="ldm-speed-limit" style="background:#1e2430; color:#eee; border:1px solid rgba(255,255,255,0.15); border-radius:4px; font-size:10px; padding:2px 4px; cursor:pointer;">
          <option value="0">${t("speed_unlimited")}</option>
          <option value="10240">🚀 10 MB/s</option>
          <option value="5120">🐢 5 MB/s</option>
          <option value="2048">🐌 2 MB/s</option>
          <option value="1024">1 MB/s</option>
        </select>
      </div>
      <label style="display:flex; align-items:center; gap:4px; cursor:pointer;" title="${t("shutdown_tooltip")}">
        <input type="checkbox" id="ldm-auto-shutdown" style="cursor:pointer; accent-color:#00d287;">
        <span id="ldm-txt-shutdown" style="font-size:10px;">${t("shutdown_label")}</span>
      </label>
    </div>
  `;

  root.appendChild(badge);
  root.appendChild(panel);
  document.documentElement.appendChild(root);

  function togglePanel() {
    panelVisible = !panelVisible;
    if (panelVisible) {
      panel.classList.remove("is-hidden");
      badge.querySelector("span:last-child").textContent = "▼";
      fetchAndRender();
      syncSettings();
      if (!pollTimer) pollTimer = setInterval(fetchAndRender, 1200);
    } else {
      panel.classList.add("is-hidden");
      badge.querySelector("span:last-child").textContent = "▲";
    }
  }

  function openPanel() {
    if (!panelVisible) togglePanel();
  }
  window.__ldmOpenDrawer = openPanel;

  function ldmApi(path, method = "GET", body = null) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "ldm-api-proxy", path, method, body }, (res) => {
          if (chrome.runtime.lastError || !res?.ok) {
            resolve(null);
          } else {
            resolve(res.data);
          }
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  badge.addEventListener("click", togglePanel);
  panel.querySelector("#ldm-btn-close").addEventListener("click", togglePanel);
  panel.querySelector("#ldm-btn-dash").addEventListener("click", () => window.open("http://127.0.0.1:18900", "_blank"));
  panel.querySelector("#ldm-btn-clear").addEventListener("click", async () => {
    await ldmApi("/api/downloads/clear", "POST");
    fetchAndRender();
  });

  const langSel = panel.querySelector("#ldm-lang-select");
  function updateDrawerLanguage() {
    panel.querySelector("#ldm-btn-clear")?.setAttribute("title", t("clear_history"));
    panel.querySelector("#ldm-btn-dash")?.setAttribute("title", t("open_panel"));
    panel.querySelector("#ldm-btn-close")?.setAttribute("title", t("close_panel"));
    const opt0 = panel.querySelector("#ldm-speed-limit option[value='0']");
    if (opt0) opt0.textContent = t("speed_unlimited");
    const shutTxt = panel.querySelector("#ldm-txt-shutdown");
    if (shutTxt) shutTxt.textContent = t("shutdown_label");
    const spdTxt = panel.querySelector("#ldm-txt-speed");
    if (spdTxt) { spdTxt.textContent = t("speed_label"); spdTxt.title = t("speed_label"); }
    badge.title = t("panel_title");
  }

  if (langSel && window.LDM_I18N) {
    langSel.innerHTML = window.LDM_I18N.languages
      .map((l) => `<option value="${l.code}">${l.flag} ${l.code.toUpperCase()}</option>`)
      .join("");
    langSel.value = window.LDM_I18N.getLanguage();
    langSel.addEventListener("change", (e) => {
      window.LDM_I18N.setLanguage(e.target.value);
      updateDrawerLanguage();
      fetchAndRender();
    });
  }

  const speedSel = panel.querySelector("#ldm-speed-limit");
  const shutCheck = panel.querySelector("#ldm-auto-shutdown");

  async function syncSettings() {
    const res = await ldmApi("/api/settings");
    if (res && res.settings) {
      if (speedSel) speedSel.value = String(res.settings.speed_limit_kbps || 0);
      if (shutCheck) shutCheck.checked = Boolean(res.settings.auto_shutdown);
    }
  }

  if (speedSel) {
    speedSel.addEventListener("change", async () => {
      const val = parseInt(speedSel.value, 10) || 0;
      await ldmApi("/api/settings", "POST", { speed_limit_kbps: val });
    });
  }

  if (shutCheck) {
    shutCheck.addEventListener("change", async () => {
      await ldmApi("/api/settings", "POST", { auto_shutdown: shutCheck.checked });
      if (shutCheck.checked) {
        showToast(t("shutdown_toast"), "info");
      }
    });
  }

  async function fetchAndRender() {
    const data = await ldmApi("/api/downloads");
    if (data && data.downloads) {
      renderItems(data.downloads);
    }
  }

  function renderItems(items) {
    const listEl = panel.querySelector("#ldm-drawer-items");
    const active = items.find(d => d.status === "downloading" || d.status === "paused");

    if (active) {
      badge.classList.add("is-active");
      const spd = active.speed || "";
      const prg = active.progress || 0;
      badge.innerHTML = `<span>⚡</span> <span>%${prg} • ${spd}</span> <span>${panelVisible ? '▼' : '▲'}</span>`;
    } else {
      badge.classList.remove("is-active");
      badge.innerHTML = `<span>⚡</span> <span>LDM (${items.length})</span> <span>${panelVisible ? '▼' : '▲'}</span>`;
    }

    if (!items || items.length === 0) {
      listEl.innerHTML = `<div style="text-align:center; padding:35px 15px; color:#8b9eb5; font-size:12px;">${t("empty_downloads")}</div>`;
      return;
    }

    listEl.innerHTML = items.map(item => {
      const isD = item.status === "downloading";
      const isP = item.status === "paused";
      const isC = item.status === "completed";

      let statusBadge = "";
      if (isD) statusBadge = `<span class="ldm-badge-sm ldm-badge-downloading">${t("status_downloading")}</span>`;
      else if (isP) statusBadge = `<span class="ldm-badge-sm ldm-badge-paused">${t("status_paused")}</span>`;
      else if (isC) statusBadge = `<span class="ldm-badge-sm ldm-badge-completed">${t("status_completed")}</span>`;
      else statusBadge = `<span class="ldm-badge-sm ldm-badge-failed">${t("status_failed")}</span>`;

      return `
        <div class="ldm-card">
          <div class="ldm-card-header">
            <div class="ldm-card-name" title="${item.title}">${item.title}</div>
            <div class="ldm-card-btns">
              ${isD ? `<button class="ldm-icon-btn" data-act="pause" data-id="${item.id}" title="${t("act_pause")}">⏸</button>` : ''}
              ${isP ? `<button class="ldm-icon-btn" data-act="resume" data-id="${item.id}" style="color:#00d287;" title="${t("act_resume")}">▶</button>` : ''}
              ${(isD || isP) ? `<button class="ldm-icon-btn" data-act="cancel" data-id="${item.id}" style="color:#ff4757;" title="${t("act_cancel")}">✕</button>` : ''}
              ${isC ? `<button class="ldm-icon-btn" data-act="play" data-id="${item.id}" style="color:#00d287;" title="${t("act_play")}">▶</button><button class="ldm-icon-btn" data-act="open" data-id="${item.id}" title="${t("act_open_folder")}">📁</button>` : ''}
            </div>
          </div>

          <div class="ldm-bar-bg">
            <div class="ldm-bar-fill ${item.status}" style="width: ${item.progress || 0}%"></div>
          </div>

          <div class="ldm-card-details">
            <div style="display:flex; align-items:center; gap:6px;">
              ${statusBadge}
              <b style="color:#fff;">%${item.progress || 0}</b>
              ${isD ? `<span style="color:#00d287;">• ${item.speed}</span>` : ''}
            </div>
            <div>
              <span>${item.downloaded_str || '0 B'} / ${item.total_str || 'Bilinmiyor'}</span>
              ${isD && item.eta ? `<span style="margin-left:4px; color:#ffb142;">(⏳ ${item.eta})</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join("");

    // Wire action buttons
    listEl.querySelectorAll("[data-act]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const act = btn.getAttribute("data-act");
        const id = btn.getAttribute("data-id");
        try {
          if (act === "pause") await ldmApi("/api/downloads/pause", "POST", { id });
          else if (act === "resume") await ldmApi("/api/downloads/resume", "POST", { id });
          else if (act === "cancel") await ldmApi("/api/downloads/cancel", "POST", { id });
          else if (act === "open") await ldmApi("/api/open-folder", "POST", { id });
          else if (act === "play") await ldmApi("/api/open-file", "POST", { id });
          fetchAndRender();
        } catch(err){}
      });
    });
  }

  // Periodic check for active downloads to update badge even if drawer is closed
  setInterval(fetchAndRender, 3000);
  setTimeout(fetchAndRender, 500);

  // Hook button clicks to open panel automatically
  document.addEventListener("click", (e) => {
    if (e.target && (e.target.classList.contains("ldm-media-button") || e.target.classList.contains("ldm-site-btn") || e.target.closest(".ldm-media-button, .ldm-site-btn"))) {
      setTimeout(openPanel, 400);
    }
  }, true);
})();

