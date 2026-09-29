# Linux Download Manager Pro (LDM Pro)

<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" alt="Linux Download Manager Pro icon">
</p>

<p align="center">
  <strong>High-performance, IDM-inspired parallel download manager and media extractor for Linux (Ubuntu, Debian, Arch, Fedora). Featuring 16-connection parallel HLS/HTTP engine, in-browser floating drawer, YouTube Mix/Album batch downloading with embedded cover art & ID3 metadata, and dual-audio film remuxing.</strong>
</p>

<p align="center">
  <a href="#quick-install"><b>Quick Install</b></a>
  &nbsp;·&nbsp;
  <a href="#features">Features</a>
  &nbsp;·&nbsp;
  <a href="#turkish-summary">Türkçe Açıklama</a>
  &nbsp;·&nbsp;
  <a href="#license--credits">License & Credits</a>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Platform: Linux" src="https://img.shields.io/badge/platform-Linux-1f6feb.svg">
  <img alt="Engine: Python 3 Parallel Daemon" src="https://img.shields.io/badge/engine-Python%203%20Daemon-green.svg">
  <img alt="Author: Wesut00-TR06" src="https://img.shields.io/badge/developer-Wesut00--TR06-teal.svg">
</p>

---

<details id="turkish-summary">
<summary><b>🇹🇷 Türkçe Açıklama ve Özellikler (Genişletmek için tıklayın)</b></summary>

### Linux Download Manager Pro Nedir?
**Linux için en gelişmiş IDM (Internet Download Manager) alternatifi.** Sıfır sistem kaynağı tüketen 1850+ satırlık özel Python Paralel Daemon motoru ve Chromium tabanlı (Chrome, Brave, Edge, Vivaldi) tarayıcı eklentisi ile web sayfalarının içine gömülü olarak çalışır.

#### Temel Özellikler:
1. **16 Kanallı Paralel HLS & Segment Motoru**: Film ve videoları 16 eş zamanlı bağlantıyla tam hat kapasitesinde indirir. Kesilen veya duraklatılan indirmeler ağ değiştiğinde kaldığı bayttan devam eder.
2. **Çift Sesli Film Desteği (Dual-Audio Remuxing)**: Türkçe dublaj ve Orijinal ses kanallarını eş zamanlı indirir, ffmpeg ile milisaniye kayması olmadan tek bir MP4 içinde birleştirir.
3. **Tek Tıkla YouTube Mix / Çalma Listesi İndirme**: YouTube Mix (`list=RD...`) ve çalma listelerindeki tüm parçaları sıralı (`01 - ...`, `02 - ...`) olarak otomatik oluşturulan albüm klasörüne çeker ve masaüstünde açar.
4. **320 kbps Stüdyo Kalite MP3 & Kapak Resmi**: Müzik indirmelerinde videonun en yüksek çözünürlüklü kapak resmini ve sanatçı/parça ID3 etiketlerini doğrudan MP3 dosyasına gömer.
5. **Sayfa İçi Yüzen Panel (Floating Widget)**: Harici hantal pencerelere ihtiyaç duymadan doğrudan tarayıcı sayfasının sağ alt köşesinde indirme hızını, ilerlemeyi ve dosya kontrollerini gösterir.
6. **Kararlı Hız & Kalan Süre (EMA)**: 3 saniyelik hareketli pencere ve Üstel Hareketli Ortalama (EMA) filtresi ile hız ve kalan süre sıçramaları tamamen engellenmiştir.
7. **Hız Sınırlayıcı & Otomatik Kapanma**: İnterneti meşgul etmemek için 10 MB/s, 5 MB/s, 2 MB/s, 1 MB/s hız limitleri seçilebilir; indirmeler bitince sistemi otomatik kapatma seçeneği sunar.
8. **Çoklu Dil Desteği (7 Dil)**: İngilizce (🇬🇧), Türkçe (🇹🇷), Rusça (🇷🇺), İspanyolca (🇪🇸), Çince (🇨🇳), Fransızca (🇫🇷) ve Arapça (🇸🇦). Tarayıcı dilini otomatik algılar ve panelden anında değiştirilebilir.

**Tek Komutla Hızlı Kurulum:**
```bash
curl -fsSL https://raw.githubusercontent.com/Wesut00-TR06/Linux-Download-Manager-Pro/main/install.sh | bash
```
</details>

---

## ⚡ Quick Install

Run the one-line installer in your Linux terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/Wesut00-TR06/Linux-Download-Manager-Pro/main/install.sh | bash
```

Or clone and run locally:
```bash
git clone https://github.com/Wesut00-TR06/Linux-Download-Manager-Pro.git
cd Linux-Download-Manager-Pro
./install.sh
```

---

## 🚀 Key Features

### 1. 🎬 High-Speed Parallel HLS & Dual-Audio Remuxer
- **16-worker concurrent segment streaming**: Maximizes bandwidth for movies and segmented HLS/M3U8 streams.
- **Dual-Audio preservation**: Simultaneously downloads Turkish dub and Original audio tracks, automatically multiplexing them into a single clean MP4.
- **Resilient resume**: Switch networks or pause anytime; downloads resume precisely at the exact segment without restarting.

### 2. 🎵 YouTube Mix & Playlist Batch Downloader
- **One-click full album extraction**: Automatically detects Mix and playlist contexts (`list=RD...` / `list=PL...`).
- **Sequential track numbering**: Saves files as `01 - Title.mp3`, `02 - Title.mp3`, etc.
- **Dedicated album folder**: Automatically creates and opens `~/Müzik/<Album Name> (Mix)/` on your desktop via `xdg-open`.
- **Live track progress**: Displays real-time progress indicators (e.g. `[5/50] Current Track Title`) with true overall playlist completion percentage.

### 3. 🎶 Embedded High-Res Cover Art & ID3 Metadata
- Automatically fetches maximum resolution video thumbnail, converts to JPG, and embeds it directly into MP3, FLAC, or M4A audio files.
- ID3 metadata tagging (artist, track title, album, date) ensures seamless integration with mobile devices, car audio systems, Spotify local files, and VLC.

### 4. ⚡ In-Browser Floating Widget & Controls
- **Zero-clutter UI**: Sleek, dark-mode floating pill in the bottom-right of browser pages with live speed and progress display.
- **Instant format & quality picker**: 4K, 1080p Full HD, 720p HD, 320 kbps MP3, FLAC (Lossless), and M4A.
- **Speed Limiter**: Switch between Unlimited (⚡ Sınırsız), 10 MB/s, 5 MB/s, 2 MB/s, or 1 MB/s anytime.
- **Auto-Shutdown**: Automatically powers off or sleeps the system when all downloads complete.

### 5. 📊 Stabilized Speed & ETA Calculations
- Employs a 3-second rolling window and Exponential Moving Average (EMA) filter to completely eliminate jittery speed jumps and erratic ETA fluctuations.

### 6. 🌐 Multi-Language (i18n) Support
- **7 Built-in Languages**: English (🇬🇧), Turkish (🇹🇷), Russian (🇷🇺), Spanish (🇪🇸), Chinese (🇨🇳), French (🇫🇷), and Arabic (🇸🇦).
- **Auto-Detection**: Automatically detects and matches your system/browser language (`navigator.language`).
- **Instant Switcher**: Seamless language selector dropdown in both the floating in-page drawer and toolbar popup.

---

## 📁 Project Architecture

```
├── daemon/
│   ├── ldm_daemon.py             # High-performance parallel Python REST daemon (Port 18900)
│   └── browser_native_host       # Chromium stdio native messaging bridge
├── browser/chromium/             # Browser extension (Manifest V3)
│   ├── content-script.js         # In-page floating widget & video detection hooks
│   ├── service-worker.js         # Request interception & native bridge dispatch
│   ├── content-style.css         # Dark modern styling for in-page controls
│   ├── popup.html / popup.js     # Toolbar popup view
│   └── manifest.json             # Chrome extension manifest
├── install.sh                    # One-click automated installer
└── uninstall.sh                  # Complete uninstaller
```

---

## ⚙️ Requirements

- **Linux OS**: Ubuntu, Debian, Arch Linux, CachyOS, Fedora, Linux Mint, Pop!_OS.
- **Python**: Python 3.8+ (pre-installed on almost all Linux distributions).
- **Core Tools**: `ffmpeg`, `yt-dlp`, and `nodejs` (automatically checked and configured by `install.sh`).
- **Browser**: Any Chromium-based browser (Google Chrome, Brave, Microsoft Edge, Vivaldi).

---

## 📜 License & Credits

- Distributed under the **MIT License**.
- **Credits & Attribution**: Based on initial ideas and architecture from [ekremx25/linux-download-manager](https://github.com/ekremx25/linux-download-manager). Heavily redesigned, refactored into a high-speed Python parallel daemon, and extended with YouTube Mix/Album batch downloading, dual-audio HLS remuxing, in-page floating UI, and metadata embedding by **[Wesut00-TR06](https://github.com/Wesut00-TR06)**.
