async function load() {
  try {
    const res = await fetch("http://127.0.0.1:18900/api/downloads");
    if (!res.ok) return;
    const data = await res.json();
    render(data.downloads || []);
  } catch(e) {
    document.getElementById("list").innerHTML = `<div class="empty">İndirme servisine bağlanılamadı.<br>Lütfen arka plan servisinin çalıştığından emin olun.</div>`;
  }
}

function render(items) {
  const container = document.getElementById("list");
  if (!items || items.length === 0) {
    container.innerHTML = `<div class="empty">Henüz indirme yok.</div>`;
    return;
  }

  container.innerHTML = items.map(item => {
    const isD = item.status === "downloading";
    const isP = item.status === "paused";
    const isC = item.status === "completed";

    return `
      <div class="card">
        <div class="card-top">
          <div class="card-title" title="${item.title}">${item.title}</div>
          <div class="card-btns">
            ${isD ? `<button class="icon-btn" data-act="pause" data-id="${item.id}" title="Duraklat">⏸</button>` : ''}
            ${isP ? `<button class="icon-btn" data-act="resume" data-id="${item.id}" style="color:#00d287;" title="Devam Et">▶</button>` : ''}
            ${(isD || isP) ? `<button class="icon-btn" data-act="cancel" data-id="${item.id}" style="color:#ff4757;" title="İptal Et">✕</button>` : ''}
            ${isC ? `<button class="icon-btn" data-act="play" data-id="${item.id}" style="color:#00d287;" title="Dosyayı Oynat / Aç">▶</button><button class="icon-btn" data-act="open" data-id="${item.id}" title="Klasörde Göster">📁</button>` : ''}
          </div>
        </div>
        <div class="bar-bg">
          <div class="bar-fill ${item.status}" style="width: ${item.progress || 0}%"></div>
        </div>
        <div class="card-stats">
          <div style="display:flex; align-items:center; gap:4px;">
            <span class="badge badge-${item.status}">${item.status === 'downloading' ? 'İndiriliyor' : item.status === 'paused' ? 'Duraklatıldı' : item.status === 'completed' ? 'Tamamlandı' : 'İptal'}</span>
            <b>%${item.progress || 0}</b>
            ${isD ? `<span style="color:#00d287;">• ${item.speed}</span>` : ''}
          </div>
          <div>
            <span>${item.downloaded_str} / ${item.total_str}</span>
            ${isD && item.eta ? `<span style="margin-left:4px; color:#ffa502;">(${item.eta})</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll("[data-act]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const act = btn.getAttribute("data-act");
      const id = btn.getAttribute("data-id");
      try {
        if (act === "pause") await fetch("http://127.0.0.1:18900/api/downloads/pause", { method: "POST", body: JSON.stringify({id}) });
        else if (act === "resume") await fetch("http://127.0.0.1:18900/api/downloads/resume", { method: "POST", body: JSON.stringify({id}) });
        else if (act === "cancel") await fetch("http://127.0.0.1:18900/api/downloads/cancel", { method: "POST", body: JSON.stringify({id}) });
        else if (act === "open") await fetch("http://127.0.0.1:18900/api/open-folder", { method: "POST", body: JSON.stringify({id}) });
        else if (act === "play") await fetch("http://127.0.0.1:18900/api/open-file", { method: "POST", body: JSON.stringify({id}) });
        load();
      } catch(e){}
    });
  });
}

document.getElementById("btn-clear").addEventListener("click", async () => {
  try {
    await fetch("http://127.0.0.1:18900/api/downloads/clear", { method: "POST" });
    load();
  } catch(e){}
});

document.getElementById("btn-open-tab").addEventListener("click", () => {
  window.open("http://127.0.0.1:18900", "_blank");
});

load();
setInterval(load, 1200);
