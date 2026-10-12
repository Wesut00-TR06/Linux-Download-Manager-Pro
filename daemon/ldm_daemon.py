#!/usr/bin/env python3
import sys
import os
import json
import time
import signal
import subprocess
import threading
import re
import shutil
import glob
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, urljoin
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import deque
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import hashlib
import base64
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

PORT = 18900
DATA_DIR = os.path.expanduser("~/.local/share/linux-download-manager")
HISTORY_FILE = os.path.join(DATA_DIR, "downloads_history.json")
LOG_FILE = os.path.join(DATA_DIR, "daemon.log")
TEMP_DIR = os.path.join(DATA_DIR, "temp")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(TEMP_DIR, exist_ok=True)

def log(msg):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass

def format_bytes(b):
    if b is None or b < 0:
        return "0 B"
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if b < 1024.0:
            return f"{b:.1f} {unit}"
        b /= 1024.0
    return f"{b:.1f} PB"

def format_duration(seconds):
    if seconds is None or seconds < 0:
        return "--:--"
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"

KINESCOPE_DECODER_KEY = "RySdvcyu5iTUxn97vn4HwoniwgxaCynA"

def decode_kinescope_playlist(text: str) -> str:
    """Decodes Kinescope / Playerjs encrypted playlist JSON: {'p': '...', 'v': 1}"""
    if not text or not text.strip().startswith("{"):
        return text
    try:
        data = json.loads(text)
        p = data.get("p")
        if not p or not isinstance(p, str):
            return text
        b64_str = p[::-1]
        raw_bytes = base64.b64decode(b64_str)
        key_bytes = KINESCOPE_DECODER_KEY.encode("utf-8")
        decrypted = bytes([b ^ key_bytes[i % len(key_bytes)] for i, b in enumerate(raw_bytes)])
        decoded_text = decrypted.decode("utf-8", errors="ignore")
        if "#EXTM3U" in decoded_text:
            return decoded_text
    except Exception:
        pass
    return text

class DownloadManager:
    def __init__(self):
        self.lock = threading.Lock()
        self.downloads = []
        self.processes = {}  # dl_id -> subprocess.Popen (for ffmpeg fallback)
        self.workers = {}    # dl_id -> worker info (for parallel / segmented engine)
        self.temp_base_dir = TEMP_DIR
        self.settings_file = os.path.expanduser("~/.local/share/linux-download-manager/settings.json")
        self.settings = {"speed_limit_kbps": 0, "auto_shutdown": False}
        self.load_settings()
        self.load_history()

    def load_settings(self):
        if os.path.exists(self.settings_file):
            try:
                with open(self.settings_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    self.settings.update(data)
            except Exception as e:
                log(f"Error loading settings: {e}")

    def save_settings(self):
        try:
            with open(self.settings_file, "w", encoding="utf-8") as f:
                json.dump(self.settings, f, indent=2)
        except Exception as e:
            log(f"Error saving settings: {e}")

    def load_history(self):
        if os.path.exists(HISTORY_FILE):
            try:
                with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    for item in data:
                        if item.get("status") in ["downloading", "paused"]:
                            item["status"] = "cancelled"
                    self.downloads = data
            except Exception as e:
                log(f"Error loading history: {e}")

    def save_history(self):
        try:
            with open(HISTORY_FILE, "w", encoding="utf-8") as f:
                json.dump(self.downloads[-50:], f, ensure_ascii=False, indent=2)
        except Exception as e:
            log(f"Error saving history: {e}")

    def get_download(self, dl_id):
        with self.lock:
            for d in self.downloads:
                if d["id"] == dl_id:
                    return d
        return None

    def _on_download_completed(self, item):
        target_path = item.get("target_path")
        if not target_path:
            return

        item["status"] = "completed"
        item["progress"] = 100.0
        item["speed"] = "Tamamlandı"
        item["remaining_str"] = "0 B"
        item["eta"] = "Tamamlandı"
        # Convert to audio if audio format was selected for a video stream
        fmt = item.get("format") or ""
        if fmt.startswith("audio_") and target_path.lower().endswith((".mp4", ".ts", ".webm", ".mkv")):
            try:
                base_no_ext = os.path.splitext(target_path)[0]
                audio_ext = ".mp3" if "mp3" in fmt else (".flac" if "flac" in fmt else ".m4a")
                audio_path = base_no_ext + audio_ext
                cmd = ["ffmpeg", "-y", "-i", target_path, "-vn"]
                if "mp3" in fmt:
                    cmd.extend(["-c:a", "libmp3lame", "-b:a", "320k"])
                elif "flac" in fmt:
                    cmd.extend(["-c:a", "flac"])
                else:
                    cmd.extend(["-c:a", "aac", "-b:a", "256k"])
                cmd.append(audio_path)
                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
                if os.path.exists(audio_path):
                    try: os.remove(target_path)
                    except Exception: pass
                    target_path = audio_path
                    item["target_path"] = audio_path
                    item["filename"] = os.path.basename(audio_path)
            except Exception as e:
                log(f"Audio conversion failed for {item['id']}: {e}")

        try:
            if os.path.exists(target_path):
                sz = os.path.getsize(target_path)
                item["total_bytes"] = sz
                item["downloaded_bytes"] = sz
                item["total_str"] = format_bytes(sz)
                item["downloaded_str"] = item["total_str"]
        except Exception:
            pass

        # Symlink to ~/İndirilenler so everything is also accessible in one central folder
        ind_dir = os.path.expanduser("~/İndirilenler")
        if os.path.isdir(ind_dir) and os.path.exists(target_path):
            dest = os.path.join(ind_dir, os.path.basename(target_path))
            if not os.path.exists(dest):
                try:
                    os.symlink(target_path, dest)
                except Exception:
                    pass

        # For playlists/albums, automatically open the album folder when all songs are done
        if item.get("is_playlist"):
            folder = target_path if os.path.isdir(target_path) else os.path.dirname(target_path)
            if os.path.exists(folder):
                try:
                    env = os.environ.copy()
                    if "DISPLAY" not in env:
                        env["DISPLAY"] = ":0"
                    if "WAYLAND_DISPLAY" not in env and os.path.exists(f"/run/user/{os.getuid()}/wayland-0"):
                        env["WAYLAND_DISPLAY"] = "wayland-0"
                    if "DBUS_SESSION_BUS_ADDRESS" not in env and os.path.exists(f"/run/user/{os.getuid()}/bus"):
                        env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path=/run/user/{os.getuid()}/bus"
                    subprocess.Popen(["xdg-open", folder], env=env)
                except Exception as e:
                    log(f"Auto-open album folder on completion error: {e}")

        # Desktop notification
        filename = item.get("filename") or os.path.basename(target_path)
        size_str = item.get("downloaded_str") or item.get("total_str") or ""
        msg = f"{filename}\n{size_str}".strip()
        try:
            subprocess.Popen([
                "notify-send",
                "-a", "Linux Download Manager",
                "-i", "document-save",
                "İndirme Tamamlandı",
                msg
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as e:
            log(f"Notification error: {e}")

        self.save_history()

        # Check auto-shutdown trigger
        if self.settings.get("auto_shutdown"):
            with self.lock:
                still_downloading = any(d.get("status") == "downloading" and d.get("id") != item.get("id") for d in self.downloads)
            if not still_downloading:
                self.settings["auto_shutdown"] = False
                self.save_settings()
                log("All downloads completed. Auto-shutdown armed for 60 seconds.")
                try:
                    subprocess.Popen([
                        "notify-send",
                        "-a", "Linux Download Manager",
                        "-u", "critical",
                        "-i", "system-shutdown",
                        "İndirmeler Bitti - Bilgisayar Kapanıyor",
                        "Tüm indirmeler tamamlandı. Sistem 60 saniye içinde kapatılacak.\nİptal etmek için terminalde 'shutdown -c' yazın."
                    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    subprocess.Popen(["shutdown", "-h", "+1", "Linux Download Manager: Tüm indirmeler tamamlandı."], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except Exception as e:
                    log(f"Auto-shutdown error: {e}")

    def add_download(self, url, title=None, headers=None, source_page=None, save_dir=None, format=None, force_ytdlp=False, is_playlist=False):
        dl_id = f"dl_{int(time.time()*1000)}_{len(self.downloads)}"
        title = title or "İsimsiz İndirme"

        # Clean browser notification badges (e.g. "(700) ") and site suffixes (e.g. " - YouTube")
        title = re.sub(r'^\(\d+\)\s*', '', title)
        title = re.sub(r'\s*-\s*YouTube$', '', title, flags=re.IGNORECASE).strip()

        # Determine media category & extension
        fmt_lower = str(format or "").lower()
        is_audio = format == "ba/b" or ("audio" in fmt_lower and "video" not in fmt_lower)
        
        if format == "audio_flac":
            ext_to_use = ".flac"
            is_audio = True
        elif format == "audio_m4a":
            ext_to_use = ".m4a"
            is_audio = True
        elif is_audio or format == "audio_mp3_320":
            ext_to_use = ".mp3"
            is_audio = True
        else:
            url_clean = url.split("?")[0].split("#")[0].rstrip("/")
            url_ext = os.path.splitext(url_clean)[1].lower()
            if url_ext in [".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".iso", ".deb", ".rpm", ".apk", ".appimage", ".exe", ".pdf", ".epub", ".doc", ".docx", ".xls", ".xlsx", ".png", ".jpg", ".jpeg", ".mp4", ".mkv", ".webm", ".avi", ".flv"]:
                ext_to_use = url_ext
            else:
                ext_to_use = ".mp4"

        clean_title = re.sub(r'[\\/*?:"<>|]', "", title).strip() or "download"
        if not clean_title.lower().endswith(ext_to_use):
            clean_title += ext_to_use

        # Smart Categorization & Automatic Folder Routing
        if not save_dir or save_dir == os.path.expanduser("~/Downloads"):
            if is_audio:
                target_dir = os.path.expanduser("~/Müzik") if os.path.isdir(os.path.expanduser("~/Müzik")) else os.path.expanduser("~/Downloads")
            elif ext_to_use in [".pdf", ".epub", ".doc", ".docx", ".odt", ".txt", ".xlsx", ".csv"]:
                target_dir = os.path.expanduser("~/Belgeler") if os.path.isdir(os.path.expanduser("~/Belgeler")) else os.path.expanduser("~/Downloads")
            elif ext_to_use in [".mp4", ".mkv", ".webm", ".avi", ".flv", ".mov", ".ts"]:
                target_dir = os.path.expanduser("~/Videolar") if os.path.isdir(os.path.expanduser("~/Videolar")) else os.path.expanduser("~/Downloads")
            else:
                target_dir = os.path.expanduser("~/Downloads")
        else:
            target_dir = save_dir

        os.makedirs(target_dir, exist_ok=True)
        if is_playlist:
            clean_alb_name = re.sub(r'^\(\d+\)\s*', '', title)
            clean_alb_name = re.sub(r'\s*-\s*YouTube$', '', clean_alb_name, flags=re.IGNORECASE).strip()
            clean_alb_name = re.sub(r'[\\/*?:"<>|]', "", clean_alb_name).strip() or "Mix_Album"
            if not clean_alb_name.endswith("(Mix)") and not clean_alb_name.endswith("(Liste)"):
                album_folder_name = f"{clean_alb_name} (Mix)"
            else:
                album_folder_name = clean_alb_name
            album_dir = os.path.join(target_dir, album_folder_name)
            os.makedirs(album_dir, exist_ok=True)
            target_path = album_dir
            try:
                env = os.environ.copy()
                if "DISPLAY" not in env:
                    env["DISPLAY"] = ":0"
                if "WAYLAND_DISPLAY" not in env and os.path.exists(f"/run/user/{os.getuid()}/wayland-0"):
                    env["WAYLAND_DISPLAY"] = "wayland-0"
                if "DBUS_SESSION_BUS_ADDRESS" not in env and os.path.exists(f"/run/user/{os.getuid()}/bus"):
                    env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path=/run/user/{os.getuid()}/bus"
                subprocess.Popen(["xdg-open", album_dir], env=env)
                log(f"Auto-opened album directory: {album_dir}")
            except Exception as e:
                log(f"Auto-open album directory error: {e}")
        else:
            target_path = os.path.join(target_dir, clean_title)
            counter = 1
            root, ext = os.path.splitext(target_path)
            while os.path.exists(target_path):
                target_path = f"{root}_{counter}{ext}"
                counter += 1

        hdrs = dict(headers or {})
        # Domain-specific referer enforcement
        if "closeload" in url or "cdnimages" in url:
            hdrs["Referer"] = "https://closeload.filmmakinesi.to/"
        elif "rapid" in url or "rapidrame" in url:
            hdrs["Referer"] = "https://rapid.filmmakinesi.to/"
        elif not hdrs.get("Referer") and not hdrs.get("referer"):
            if source_page:
                hdrs["Referer"] = source_page

        # Auto-upgrade sublist URLs to master playlist if available (ensures full video+audio)
        if "/sublist_" in url or "/txt/sublist" in url:
            master_candidate = re.sub(r'/sublist_[^/]+\.txt', '/master.txt', url)
            try:
                import urllib.request
                req = urllib.request.Request(master_candidate, headers=hdrs)
                with urllib.request.urlopen(req, timeout=3) as resp:
                    if resp.status == 200:
                        log(f"Auto-upgraded sublist URL {url} to master playlist: {master_candidate}")
                        url = master_candidate
            except Exception as e:
                log(f"Could not auto-upgrade sublist URL: {e}")

        item = {
            "id": dl_id,
            "url": url,
            "title": title,
            "filename": os.path.basename(target_path),
            "target_path": target_path,
            "headers": hdrs,
            "source_page": source_page,
            "format": format,
            "force_ytdlp": force_ytdlp,
            "is_playlist": is_playlist,
            "status": "downloading",
            "progress": 0.0,
            "speed": "Bağlanıyor...",
            "speed_bytes": 0,
            "multiplier": "1x",
            "downloaded_bytes": 0,
            "downloaded_str": "0 MB",
            "total_bytes": None,
            "total_str": "Hesaplanıyor...",
            "remaining_str": "Hesaplanıyor...",
            "eta": "Hesaplanıyor...",
            "eta_seconds": None,
            "duration": "--:--",
            "duration_seconds": None,
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S")
        }

        with self.lock:
            self.downloads.insert(0, item)
            self.save_history()

        # Start download thread
        t = threading.Thread(target=self._start_download_worker, args=(item,))
        t.daemon = True
        t.start()

        return item

    def _is_social_url(self, u):
        if not u:
            return False
        return bool(re.search(r'(youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.watch|tiktok\.com|twitter\.com|x\.com|reddit\.com|pinterest\.com|twitch\.tv|vimeo\.com|dailymotion\.com|threads\.net|t\.co|vk\.com|bilibili\.com)', str(u), re.IGNORECASE))

    def _start_download_worker(self, item):
        url = item["url"]
        src = item.get("source_page") or ""
        force = item.get("force_ytdlp", False)
        is_playlist = item.get("is_playlist", False) or ("youtube.com/playlist" in url)

        # Ignore telemetry/analytics tracking endpoints
        if any(bad in url for bad in ["monitor_web", "webmssdk", "telemetry", "mon.tiktokv.com", "mon-sg.tiktokv.com"]):
            if src and "/video/" in src:
                item["url"] = src
                url = src
            else:
                log(f"Ignoring non-media telemetry request for {item['id']}: {url}")
                item["status"] = "failed"
                item["speed"] = "Geçersiz medya akışı"
                return

        # Direct TikTok CDN streams (watermark-free MP4): use high-speed multi-connection segmented HTTP engine
        is_tiktok_stream = (
            any(cdn in url for cdn in ["tiktokcdn.com", "akamaized.net", "tos-useast", "tiktokv.com", "pstatp.com", "byteoversea.com"]) or
            ("tiktok.com" in url and any(m in url for m in ["/video/tos/", "mime_type=video", "playAddr", ".mp4", "vr=", "btag="]))
        ) and not is_playlist
        if is_tiktok_stream:
            try:
                log(f"Downloading direct TikTok stream via segmented HTTP engine for {item['id']}")
                success = self._run_segmented_http_download(item)
                if success or item.get("status") in ["paused", "cancelled", "completed"]:
                    return
            except Exception as e:
                log(f"Direct stream download failed: {e}. Trying yt-dlp fallback.")

        # 1. Social & Portal Downloads (YouTube, Facebook, Instagram, Twitter, etc.)
        if force or is_playlist or self._is_social_url(url) or self._is_social_url(src):
            try:
                self._run_ytdlp_download(item)
                return
            except Exception as e:
                log(f"yt-dlp download failed for {item['id']}: {e}. Switching to fallback.")

        # 2. HLS / m3u8 Streaming Video
        is_hls = any(ext in url.lower() for ext in [".m3u8", "master.txt", "/txt/", "/hls/"])
        if is_hls:
            try:
                success = self._run_parallel_hls_download(item)
                if success or item.get("status") in ["paused", "cancelled", "completed"]:
                    return
            except Exception as e:
                log(f"Parallel HLS engine exception for {item['id']}: {e}")
                if item.get("status") in ["paused", "cancelled", "completed"]:
                    return
        
        # 3. Segmented HTTP Multi-Connection Downloader (Direct files: ISO, ZIP, MP4, DEB, etc.)
        try:
            success = self._run_segmented_http_download(item)
            if success or item.get("status") in ["paused", "cancelled", "completed"]:
                return
        except Exception as e:
            log(f"Segmented HTTP download failed for {item['id']}: {e}. Switching to ffmpeg fallback.")

        # 4. Fallback to standard ffmpeg only if previous engines could not process
        if item.get("status") not in ["paused", "cancelled", "completed"]:
            self._run_ffmpeg_download(item)

    def pause_download(self, dl_id):
        with self.lock:
            item = next((d for d in self.downloads if d["id"] == dl_id), None)
            worker = self.workers.get(dl_id)
            proc = self.processes.get(dl_id)
            if item and item["status"] == "downloading":
                if worker:
                    worker["pause_event"].clear()
                    item["status"] = "paused"
                    item["speed"] = "0 KB/s"
                    item["eta"] = "Duraklatıldı"
                    self.save_history()
                    log(f"Paused parallel download {dl_id}")
                    return True
                elif proc:
                    try:
                        os.kill(proc.pid, signal.SIGSTOP)
                        item["status"] = "paused"
                        item["speed"] = "0 KB/s"
                        item["eta"] = "Duraklatıldı"
                        self.save_history()
                        log(f"Paused download {dl_id}")
                        return True
                    except Exception as e:
                        log(f"Error pausing {dl_id}: {e}")
        return False

    def resume_download(self, dl_id):
        with self.lock:
            item = next((d for d in self.downloads if d["id"] == dl_id), None)
            worker = self.workers.get(dl_id)
            proc = self.processes.get(dl_id)
            if item and item["status"] in ["paused", "failed"]:
                if worker:
                    worker["pause_event"].set()
                    item["status"] = "downloading"
                    item["speed"] = "Devam ediliyor..."
                    self.save_history()
                    log(f"Resumed active parallel download {dl_id}")
                    return True
                elif proc:
                    try:
                        os.kill(proc.pid, signal.SIGCONT)
                        item["status"] = "downloading"
                        item["speed"] = "Devam ediliyor..."
                        self.save_history()
                        log(f"Resumed active process {dl_id}")
                        return True
                    except Exception as e:
                        log(f"Error resuming process {dl_id}: {e}")
                
                # Worker or process is not running; restart download worker in thread
                item["status"] = "downloading"
                item["speed"] = "Yeniden bağlanıyor..."
                self.save_history()
                log(f"Spawning new download worker for resumed item {dl_id}")
                t = threading.Thread(target=self._start_download_worker, args=(item,))
                t.daemon = True
                t.start()
                return True
        return False

    def cancel_download(self, dl_id):
        with self.lock:
            item = next((d for d in self.downloads if d["id"] == dl_id), None)
            worker = self.workers.get(dl_id)
            proc = self.processes.get(dl_id)
            if item:
                item["status"] = "cancelled"
                item["speed"] = "0 KB/s"
                item["eta"] = "İptal edildi"
                if worker:
                    worker["cancel_event"].set()
                    worker["pause_event"].set()
                if proc:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                self.save_history()
                log(f"Cancelled download {dl_id}")
                return True
        return False

    def clear_history(self):
        with self.lock:
            self.downloads = [d for d in self.downloads if d["status"] in ["downloading", "paused"]]
            self.save_history()
        return True

    def _resolve_media_info(self, url, headers):
        dur_sec = None
        tot_bytes = None
        try:
            import urllib.request
            req_hdrs = {}
            for k, v in (headers or {}).items():
                req_hdrs[k] = v
            if not req_hdrs.get("User-Agent") and not req_hdrs.get("user-agent"):
                req_hdrs["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            if "kinescope" in url.lower():
                req_hdrs.setdefault("Referer", "https://kinescopecdn.net/")

            lower_url = url.lower()
            if any(ext in lower_url for ext in ["m3u8", "master.txt", "/txt/", "/hls/"]):
                req = urllib.request.Request(url, headers=req_hdrs)
                with urllib.request.urlopen(req, timeout=8) as resp:
                    content = decode_kinescope_playlist(resp.read().decode('utf-8', errors='ignore'))

                if "#EXT-X-STREAM-INF" in content and "#EXTINF" not in content:
                    lines = [l.strip() for l in content.splitlines() if l.strip()]
                    for i, l in enumerate(lines):
                        if l.startswith("#EXT-X-STREAM-INF") and i + 1 < len(lines):
                            next_l = lines[i+1]
                            if not next_l.startswith("#"):
                                sub_url = urljoin(url, next_l)
                                sub_req = urllib.request.Request(sub_url, headers=req_hdrs)
                                with urllib.request.urlopen(sub_req, timeout=8) as sub_resp:
                                    content = decode_kinescope_playlist(sub_resp.read().decode('utf-8', errors='ignore'))
                                break

                inf_matches = re.findall(r'#EXTINF:([0-9.]+)', content)
                if inf_matches:
                    dur_sec = sum(float(x) for x in inf_matches)
            else:
                req = urllib.request.Request(url, headers=req_hdrs, method='HEAD')
                try:
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        cl = resp.headers.get("Content-Length")
                        if cl and cl.isdigit():
                            tot_bytes = int(cl)
                except Exception:
                    pass
        except Exception as e:
            log(f"resolve_media_info exception for {url}: {e}")

        return dur_sec, tot_bytes

    def _run_parallel_hls_download(self, item):
        dl_id = item["id"]
        url = item["url"]
        headers = item["headers"]
        target_path = item["target_path"]

        log(f"Starting parallel HLS engine for {dl_id}: {url}")

        pause_event = threading.Event()
        pause_event.set()
        cancel_event = threading.Event()
        cancel_event.clear()

        session = requests.Session()
        session.verify = False
        adapter = HTTPAdapter(pool_connections=24, pool_maxsize=24, max_retries=3)
        session.mount("https://", adapter)
        session.mount("http://", adapter)

        with self.lock:
            self.workers[dl_id] = {
                "type": "parallel_hls",
                "pause_event": pause_event,
                "cancel_event": cancel_event,
                "session": session
            }

        # Deterministic temp_dir based on media identifier for persistent resumption across CDN changes and network switches
        media_key_m = re.search(r'/([a-zA-Z0-9_\-\.]+\.(?:mp4|mkv|avi|webm)[a-zA-Z0-9_\-]*)', url)
        if media_key_m:
            media_id = media_key_m.group(1)
        elif item.get("title") and item["title"] not in ["video", "İsimsiz Video"]:
            media_id = re.sub(r'[^a-zA-Z0-9_\-]', '', item["title"])
        else:
            media_id = url

        url_hash = hashlib.md5(media_id.encode('utf-8', errors='ignore')).hexdigest()[:16]
        temp_dir = os.path.join(self.temp_base_dir, f"hls_{url_hash}")
        os.makedirs(temp_dir, exist_ok=True)

        try:
            req_hdrs = dict(headers or {})
            if not req_hdrs.get("User-Agent") and not req_hdrs.get("user-agent"):
                req_hdrs["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

            # Domain-specific referer enforcement
            if "closeload" in url or "cdnimages" in url:
                req_hdrs["Referer"] = "https://closeload.filmmakinesi.to/"
            elif "rapid" in url or "rapidrame" in url:
                req_hdrs["Referer"] = "https://rapid.filmmakinesi.to/"
            elif "kinescope" in url:
                req_hdrs.setdefault("Referer", "https://kinescopecdn.net/")

            resp = session.get(url, headers=req_hdrs, timeout=10)
            if resp.status_code != 200:
                raise ValueError(f"HTTP error {resp.status_code} fetching playlist")

            playlist_content = decode_kinescope_playlist(resp.text)
            lines = [l.strip() for l in playlist_content.splitlines() if l.strip()]

            is_master = any(l.startswith("#EXT-X-STREAM-INF") for l in lines) or any(l.startswith("#EXT-X-MEDIA:TYPE=AUDIO") for l in lines)

            video_url = None
            audio_tracks = []

            if is_master:
                video_candidates = []
                for i, l in enumerate(lines):
                    if l.startswith("#EXT-X-MEDIA:") and "TYPE=AUDIO" in l:
                        uri_m = re.search(r'URI="([^"]+)"', l)
                        name_m = re.search(r'NAME="([^"]+)"', l)
                        lang_m = re.search(r'LANGUAGE="([^"]+)"', l)
                        def_m = re.search(r'DEFAULT=(YES|NO)', l)
                        if uri_m:
                            audio_tracks.append({
                                "uri": urljoin(url, uri_m.group(1)),
                                "name": name_m.group(1) if name_m else f"Audio {len(audio_tracks)+1}",
                                "lang": lang_m.group(1) if lang_m else None,
                                "default": def_m.group(1) == "YES" if def_m else False
                            })
                    elif l.startswith("#EXT-X-STREAM-INF:"):
                        bw_m = re.search(r'BANDWIDTH=(\d+)', l)
                        res_m = re.search(r'RESOLUTION=([0-9x]+)', l)
                        bw = int(bw_m.group(1)) if bw_m else 0
                        res = res_m.group(1) if res_m else "unknown"
                        if i + 1 < len(lines) and not lines[i+1].startswith("#"):
                            video_candidates.append({
                                "bandwidth": bw,
                                "resolution": res,
                                "uri": urljoin(url, lines[i+1])
                            })
                
                video_candidates.sort(key=lambda x: x["bandwidth"], reverse=True)
                if not video_candidates:
                    raise ValueError("No video stream candidate found in master playlist")
                video_url = video_candidates[0]["uri"]
                log(f"Selected video stream: {video_candidates[0]['resolution']} ({video_candidates[0]['bandwidth']} bps)")
            else:
                video_url = url

            # Fetch video sublist
            v_resp = session.get(video_url, headers=req_hdrs, timeout=10)
            if v_resp.status_code != 200:
                raise ValueError(f"HTTP error {v_resp.status_code} fetching video sublist")
            v_content = decode_kinescope_playlist(v_resp.text)

            # Check encryption or unsupported byte ranges
            if re.search(r'#EXT-X-KEY:METHOD=(?!NONE)', v_content, re.IGNORECASE):
                raise ValueError("Encrypted HLS stream detected (DRM/AES-128)")
            if "#EXT-X-BYTERANGE" in v_content:
                raise ValueError("Byte-range HLS stream detected")

            v_lines = [l.strip() for l in v_content.splitlines() if l.strip()]
            v_segs = []
            v_durs = []
            for i, l in enumerate(v_lines):
                if l.startswith("#EXTINF:"):
                    d_m = re.search(r'#EXTINF:([0-9.]+)', l)
                    dur = float(d_m.group(1)) if d_m else 0.0
                    if i + 1 < len(v_lines) and not v_lines[i+1].startswith("#"):
                        v_segs.append(urljoin(video_url, v_lines[i+1]))
                        v_durs.append(dur)

            if not v_segs:
                raise ValueError("No video segments found in sublist")

            total_dur = sum(v_durs)
            item["duration_seconds"] = total_dur
            item["duration"] = format_duration(total_dur)
            log(f"Parsed {len(v_segs)} video segments, total duration {item['duration']}")

            # Fetch audio sublists
            for a_track in audio_tracks:
                a_resp = session.get(a_track["uri"], headers=req_hdrs, timeout=10)
                if a_resp.status_code == 200:
                    a_content = decode_kinescope_playlist(a_resp.text)
                    if re.search(r'#EXT-X-KEY:METHOD=(?!NONE)', a_content, re.IGNORECASE):
                        raise ValueError("Encrypted audio stream detected")
                    a_lines = [l.strip() for l in a_content.splitlines() if l.strip()]
                    a_segs = []
                    for i, l in enumerate(a_lines):
                        if l.startswith("#EXTINF:"):
                            if i + 1 < len(a_lines) and not a_lines[i+1].startswith("#"):
                                a_segs.append(urljoin(a_track["uri"], a_lines[i+1]))
                    a_track["segs"] = a_segs
                    log(f"Parsed {len(a_segs)} audio segments for '{a_track['name']}'")
                else:
                    a_track["segs"] = []

            # Prepare task lists
            v_tasks = [("v", 0, i, u, os.path.join(temp_dir, f"v_{i:05d}.ts")) for i, u in enumerate(v_segs)]
            a_tasks = []
            for k, a_track in enumerate(audio_tracks):
                for i, u in enumerate(a_track.get("segs", [])):
                    a_tasks.append(("a", k, i, u, os.path.join(temp_dir, f"a{k}_{i:05d}.ts")))

            tasks = v_tasks + a_tasks
            total_segments = len(tasks)
            log(f"Total parallel download tasks: {total_segments} (Video: {len(v_segs)}, Audio: {len(a_tasks)})")

            completed_count = 0
            downloaded_bytes = 0
            v_completed_count = 0
            v_downloaded_bytes = 0
            a_completed_count = 0
            a_downloaded_bytes = 0
            lock = threading.Lock()

            # Pre-scan existing parts if any (resume capability)
            for t in tasks:
                p = t[4]
                if os.path.exists(p) and os.path.getsize(p) > 0:
                    sz = os.path.getsize(p)
                    downloaded_bytes += sz
                    completed_count += 1
                    if t[0] == "v":
                        v_completed_count += 1
                        v_downloaded_bytes += sz
                    else:
                        a_completed_count += 1
                        a_downloaded_bytes += sz

            if completed_count > 0:
                prog = min(99.0, (completed_count / total_segments) * 100.0)
                item["progress"] = round(prog, 1)
                item["downloaded_bytes"] = downloaded_bytes
                item["downloaded_str"] = format_bytes(downloaded_bytes)
                log(f"Resuming parallel HLS for {dl_id}: {completed_count}/{total_segments} parts ({item['downloaded_str']}) already downloaded ({item['progress']}%)")

            last_time = time.time()
            last_bytes = downloaded_bytes
            rolling_samples = deque([(last_time, downloaded_bytes)])
            smoothed_speed_bps = 0.0
            smoothed_eta_sec = None
            last_ui_update = 0.0

            def download_worker(task):
                nonlocal completed_count, downloaded_bytes, last_time, last_bytes
                nonlocal v_completed_count, v_downloaded_bytes, a_completed_count, a_downloaded_bytes
                nonlocal rolling_samples, smoothed_speed_bps, smoothed_eta_sec, last_ui_update
                kind, k, idx, seg_url, out_path = task

                if cancel_event.is_set():
                    return 0

                pause_event.wait()
                if cancel_event.is_set():
                    return 0

                # Check if already downloaded
                if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
                    return os.path.getsize(out_path)

                # Optional throttling if user set a speed limit
                limit_kbps = self.settings.get("speed_limit_kbps", 0)
                if limit_kbps and limit_kbps > 0 and smoothed_speed_bps > (limit_kbps * 1024):
                    over_ratio = smoothed_speed_bps / (limit_kbps * 1024)
                    time.sleep(min(1.0, 0.05 * over_ratio))

                # Polite pacing for audio to avoid Cloudflare 429
                if kind == "a":
                    time.sleep(0.02)

                seg_size = 0
                for attempt in range(12):
                    if cancel_event.is_set():
                        return 0
                    pause_event.wait()
                    try:
                        r = session.get(seg_url, headers=req_hdrs, timeout=12)
                        if r.status_code == 200 and len(r.content) > 0:
                            tmp_p = out_path + ".tmp"
                            with open(tmp_p, "wb") as f:
                                f.write(r.content)
                            os.replace(tmp_p, out_path)
                            seg_size = len(r.content)
                            break
                        elif r.status_code == 429:
                            time.sleep(0.6 * (attempt + 1))
                        else:
                            time.sleep(0.3 * (attempt + 1))
                    except Exception as ex:
                        if attempt < 11:
                            if not pause_event.is_set():
                                pause_event.wait()
                            else:
                                time.sleep(min(8.0, 0.5 * (attempt + 1)))
                        else:
                            log(f"Segment retry exhausted for {out_path}: {ex}")
                            return 0

                with lock:
                    completed_count += 1
                    downloaded_bytes += seg_size
                    if kind == "v":
                        v_completed_count += 1
                        v_downloaded_bytes += seg_size
                    else:
                        a_completed_count += 1
                        a_downloaded_bytes += seg_size

                    now = time.time()
                    rolling_samples.append((now, downloaded_bytes))
                    while len(rolling_samples) > 1 and (now - rolling_samples[0][0]) > 3.0:
                        rolling_samples.popleft()

                    # Smooth UI updates every 0.6s using rolling window to eliminate jitter
                    if now - last_ui_update >= 0.6:
                        dt = rolling_samples[-1][0] - rolling_samples[0][0]
                        db = rolling_samples[-1][1] - rolling_samples[0][1]
                        if dt >= 0.8:
                            calc_spd = db / dt
                        else:
                            calc_spd = (downloaded_bytes - last_bytes) / max(0.1, now - last_time)

                        if smoothed_speed_bps <= 0:
                            smoothed_speed_bps = calc_spd
                        else:
                            smoothed_speed_bps = (smoothed_speed_bps * 0.75) + (calc_spd * 0.25)

                        last_time = now
                        last_bytes = downloaded_bytes
                        last_ui_update = now

                        if item["status"] == "downloading":
                            item["speed_bytes"] = int(smoothed_speed_bps)
                            item["speed"] = f"{format_bytes(smoothed_speed_bps)}/s"

                        # Precise size estimation separating video and audio
                        est_v_total = 0
                        if v_completed_count > 0:
                            est_v_total = (v_downloaded_bytes / v_completed_count) * len(v_segs)
                        elif completed_count > 0:
                            est_v_total = (downloaded_bytes / completed_count) * len(v_segs)

                        est_a_total = 0
                        if a_completed_count > 0:
                            avg_a = a_downloaded_bytes / a_completed_count
                            est_a_total = sum(avg_a * len(track.get("segs", [])) for track in audio_tracks)
                        elif audio_tracks:
                            est_a_total = len(audio_tracks) * (16000 * total_dur)

                        est_total = int(est_v_total + est_a_total)
                        if est_total > 0:
                            item["total_bytes"] = est_total
                            item["total_str"] = format_bytes(est_total)
                            prog = min(99.0, (downloaded_bytes / est_total) * 100.0)
                            rem_bytes = max(0, est_total - downloaded_bytes)
                            item["remaining_str"] = format_bytes(rem_bytes)
                            if smoothed_speed_bps > 1000 and item["status"] == "downloading":
                                inst_eta = rem_bytes / smoothed_speed_bps
                                if smoothed_eta_sec is None:
                                    smoothed_eta_sec = inst_eta
                                else:
                                    smoothed_eta_sec = (smoothed_eta_sec * 0.85) + (inst_eta * 0.15)
                                item["eta_seconds"] = int(smoothed_eta_sec)
                                item["eta"] = format_duration(smoothed_eta_sec)
                        else:
                            prog = min(99.0, (completed_count / total_segments) * 100.0)

                        item["progress"] = round(prog, 1)
                        item["downloaded_bytes"] = downloaded_bytes
                        item["downloaded_str"] = format_bytes(downloaded_bytes)

                return seg_size

            # Launch concurrent thread pools: 16 workers for video, 4 for audio
            with ThreadPoolExecutor(max_workers=16) as v_pool, ThreadPoolExecutor(max_workers=4) as a_pool:
                v_futs = [v_pool.submit(download_worker, t) for t in v_tasks]
                a_futs = [a_pool.submit(download_worker, t) for t in a_tasks] if a_tasks else []
                for f in as_completed(v_futs + a_futs):
                    if cancel_event.is_set():
                        break
                    f.result()

            if cancel_event.is_set():
                log(f"Download {dl_id} was cancelled by user.")
                shutil.rmtree(temp_dir, ignore_errors=True)
                with self.lock:
                    item["status"] = "cancelled"
                    item["speed"] = "0 KB/s"
                    self.workers.pop(dl_id, None)
                    self.save_history()
                return True

            # Recovery pass: verify 100% of segments downloaded
            missing_tasks = [t for t in tasks if not os.path.exists(t[4]) or os.path.getsize(t[4]) == 0]
            if missing_tasks and not cancel_event.is_set():
                log(f"Verification pass: re-downloading {len(missing_tasks)} missing segments for {dl_id}...")
                for mt in missing_tasks:
                    if cancel_event.is_set():
                        break
                    download_worker(mt)

            if cancel_event.is_set():
                log(f"Download {dl_id} was cancelled by user.")
                shutil.rmtree(temp_dir, ignore_errors=True)
                with self.lock:
                    item["status"] = "cancelled"
                    item["speed"] = "0 KB/s"
                    self.workers.pop(dl_id, None)
                    self.save_history()
                return True

            final_missing = [t for t in tasks if not os.path.exists(t[4]) or os.path.getsize(t[4]) == 0]
            if final_missing:
                log(f"Download {dl_id} interrupted: {len(final_missing)} segments remaining. Pausing for network resume.")
                with self.lock:
                    item["status"] = "paused"
                    item["speed"] = "Ağ kesildi (Duraklatıldı)"
                    item["eta"] = "Devam etmeyi bekliyor"
                    self.workers.pop(dl_id, None)
                    self.save_history()
                return True

            # 4. Concatenation and Remuxing Phase
            log(f"All {total_segments} segments downloaded. Merging and remuxing for {dl_id}...")
            with self.lock:
                item["speed"] = "Birleştiriliyor..."
                item["progress"] = 99.5

            v_concat = os.path.join(temp_dir, "v_merged.ts")
            with open(v_concat, "wb") as out_v:
                for i in range(len(v_segs)):
                    part_p = os.path.join(temp_dir, f"v_{i:05d}.ts")
                    if os.path.exists(part_p):
                        with open(part_p, "rb") as in_p:
                            shutil.copyfileobj(in_p, out_v, length=1024*1024)

            a_concats = []
            for k, a_track in enumerate(audio_tracks):
                a_concat = os.path.join(temp_dir, f"a{k}_merged.ts")
                with open(a_concat, "wb") as out_a:
                    for i in range(len(a_track.get("segs", []))):
                        part_p = os.path.join(temp_dir, f"a{k}_{i:05d}.ts")
                        if os.path.exists(part_p):
                            with open(part_p, "rb") as in_p:
                                shutil.copyfileobj(in_p, out_a, length=1024*1024)
                a_concats.append(a_concat)

            # Build ffmpeg remux command
            ff_cmd = ["ffmpeg", "-y", "-nostats", "-loglevel", "error", "-i", v_concat]
            for ac in a_concats:
                ff_cmd.extend(["-i", ac])
            ff_cmd.extend(["-map", "0:v"])
            for k in range(len(a_concats)):
                ff_cmd.extend(["-map", f"{k+1}:a"])
                track_name = audio_tracks[k]["name"] if k < len(audio_tracks) else f"Audio {k+1}"
                ff_cmd.extend([f"-metadata:s:a:{k}", f"handler_name={track_name}"])
                if "turk" in track_name.lower():
                    ff_cmd.extend([f"-metadata:s:a:{k}", "language=tur"])
                elif "orig" in track_name.lower() or "eng" in track_name.lower():
                    ff_cmd.extend([f"-metadata:s:a:{k}", "language=eng"])

            ff_cmd.extend(["-c", "copy", "-movflags", "+faststart", target_path])

            remux_res = subprocess.run(ff_cmd, capture_output=True, text=True)
            if remux_res.returncode != 0:
                log(f"Remux error: {remux_res.stderr}")
                raise RuntimeError(f"FFmpeg remux failed: {remux_res.stderr}")

            # Verify target path
            if not os.path.exists(target_path) or os.path.getsize(target_path) < 1024*1024:
                raise RuntimeError("Remuxed file is missing or too small")

            final_size = os.path.getsize(target_path)
            log(f"Successfully completed parallel download {dl_id}: {format_bytes(final_size)}")

            # Cleanup temp directory ONLY on successful remux
            shutil.rmtree(temp_dir, ignore_errors=True)

            with self.lock:
                self._on_download_completed(item)
                self.workers.pop(dl_id, None)

            return True

        except Exception as e:
            log(f"Parallel HLS exception for {dl_id}: {e}")
            # Keep temp_dir intact so download can resume from where it left off!
            with self.lock:
                if item["status"] not in ["cancelled", "completed"]:
                    item["status"] = "paused"
                    item["speed"] = "Ağ hatası (Duraklatıldı)"
                    item["eta"] = "Devam etmeyi bekliyor"
                self.workers.pop(dl_id, None)
                self.save_history()
            return False

    def _run_ytdlp_download(self, item):
        dl_id = item["id"]
        url = item["url"]
        src = item.get("source_page") or ""
        format_sel = item.get("format")
        target_path = item["target_path"]
        save_dir = os.path.dirname(target_path)
        os.makedirs(save_dir, exist_ok=True)

        # Determine best download URL (prefer social page URL if available or if url is an internal stream)
        dl_url = url
        if self._is_social_url(src):
            is_generic_feed = ("tiktok.com" in src and "/video/" not in src)
            if not is_generic_feed:
                if not self._is_social_url(dl_url) or any(cdn in dl_url for cdn in ["googlevideo.com", "cdninstagram", "fbcdn", "twimg", "blob:"]):
                    dl_url = src

        # Clean YouTube video URL: strip playlist and radio query params only if not a playlist download
        is_playlist_url = bool(item.get("is_playlist") or ("youtube.com/playlist" in dl_url) or (("list=" in dl_url or "list=" in src) and item.get("is_playlist")))
        if is_playlist_url:
            if "list=" in src and "list=" not in dl_url:
                dl_url = src
        else:
            if "youtube.com/watch" in dl_url or "youtu.be/" in dl_url:
                dl_url = re.sub(r'[?&](list|index|start_radio)=[^&]+', '', dl_url)
                if "?" not in dl_url and "&" in dl_url:
                    dl_url = dl_url.replace("&", "?", 1)

        if "tiktok.com" in dl_url and "/video/" not in dl_url:
            log(f"Cannot run yt-dlp on non-video TikTok feed URL: {dl_url}")
            with self.lock:
                item["status"] = "failed"
                item["speed"] = "Geçersiz TikTok URL'si"
                self.save_history()
            return

        log(f"Starting yt-dlp download for {dl_id} (URL: {dl_url}, format: {format_sel})")

        root, _ = os.path.splitext(target_path)
        if is_playlist_url:
            if os.path.isdir(target_path):
                out_template = os.path.join(target_path, "%(playlist_index,autonumber)02d - %(title)s.%(ext)s")
            else:
                out_template = os.path.join(save_dir, "%(playlist_title,playlist,title|Mix)s", "%(playlist_index,autonumber)02d - %(title)s.%(ext)s")
        else:
            out_template = f"{root}.%(ext)s"

        ytdlp_bin = shutil.which("yt-dlp") or os.path.expanduser("~/.local/bin/yt-dlp")
        node_bin = shutil.which("node") or "/home/dream/.nvm/versions/node/v22.23.2/bin/node"

        cmd = [
            ytdlp_bin,
            "--newline",
            "--no-warnings",
            "--progress",
            "--progress-template", "LDM_PROG:%(progress._percent_str)s|%(progress._speed_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress._eta_str)s|%(info.playlist_index)s|%(info.n_entries)s|%(info.title)s",
            "--print", "after_move:filepath",
            "-c",
            "--retries", "10",
            "--fragment-retries", "10",
            "--socket-timeout", "15",
            "-N", "8",
            "-o", out_template
        ]

        if is_playlist_url:
            cmd.append("--yes-playlist")
        else:
            cmd.append("--no-playlist")

        if node_bin and os.path.exists(node_bin):
            cmd.extend(["--js-runtimes", f"node:{node_bin}"])

        # Speed limit
        speed_limit = self.settings.get("speed_limit_kbps", 0)
        if speed_limit and speed_limit > 0:
            cmd.extend(["--limit-rate", f"{speed_limit}K"])

        # Format handling
        if format_sel == "audio_flac":
            cmd.extend([
                "-f", "ba/b",
                "-x",
                "--audio-format", "flac",
                "--audio-quality", "0",
                "--embed-thumbnail",
                "--embed-metadata",
                "--convert-thumbnails", "jpg"
            ])
        elif format_sel == "audio_m4a":
            cmd.extend([
                "-f", "ba/b",
                "-x",
                "--audio-format", "m4a",
                "--audio-quality", "0",
                "--embed-thumbnail",
                "--embed-metadata",
                "--convert-thumbnails", "jpg"
            ])
        elif format_sel in ["audio_mp3_320", "ba/b"] or (format_sel and "audio" in str(format_sel).lower() and "video" not in str(format_sel).lower()):
            cmd.extend([
                "-f", "ba/b",
                "-x",
                "--audio-format", "mp3",
                "--audio-quality", "0",
                "--embed-thumbnail",
                "--embed-metadata",
                "--convert-thumbnails", "jpg"
            ])
        elif format_sel:
            f_str = str(format_sel)
            if not f_str.endswith("/b") and not f_str.endswith("/best"):
                f_str = f"{f_str}/b"
            cmd.extend(["-f", f_str, "--merge-output-format", "mp4", "--embed-metadata", "--embed-subs", "--sub-langs", "tr,en"])
        else:
            cmd.extend(["-f", "bv*+ba/b", "--merge-output-format", "mp4", "--embed-metadata", "--embed-subs", "--sub-langs", "tr,en"])

        headers = item.get("headers") or {}
        referer = headers.get("Referer") or headers.get("referer")
        user_agent = headers.get("User-Agent") or headers.get("user-agent")
        cookie = headers.get("Cookie") or headers.get("cookie")
        if referer:
            cmd.extend(["--referer", referer])
        if user_agent:
            cmd.extend(["--user-agent", user_agent])
        if cookie:
            cmd.extend(["--add-header", f"Cookie:{cookie}"])

        # For social media platforms (Instagram, Facebook, TikTok, etc.), load cookies from Chrome browser
        if any(site in dl_url for site in ["instagram.com", "facebook.com", "fb.watch", "tiktok.com", "twitter.com", "x.com", "reddit.com"]):
            cmd.extend(["--cookies-from-browser", "chrome"])

        # TikTok watermark-free direct stream extraction
        if "tiktok.com" in dl_url:
            cmd.extend(["--extractor-args", "tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com;app_name=musical_ly"])

        cmd.append(dl_url)

        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
            with self.lock:
                self.processes[dl_id] = proc

            stderr_lines = []
            def _drain_stderr():
                try:
                    for err_line in iter(proc.stderr.readline, ''):
                        if not err_line:
                            break
                        err_line = err_line.strip()
                        if err_line:
                            if len(stderr_lines) >= 30:
                                stderr_lines.pop(0)
                            stderr_lines.append(err_line)
                except Exception:
                    pass

            stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
            stderr_thread.start()

            final_filepath = None
            for line in iter(proc.stdout.readline, ''):
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue

                if line.startswith("LDM_PROG:"):
                    parts = line[9:].split("|")
                    try:
                        pct_str = parts[0].replace('%', '').strip()
                        spd_str = parts[1].strip()
                        if spd_str and spd_str != "NA":
                            item["speed"] = spd_str

                        p_idx = parts[5].strip() if len(parts) > 5 else ""
                        p_tot = parts[6].strip() if len(parts) > 6 else ""
                        p_title = parts[7].strip() if len(parts) > 7 else ""

                        if is_playlist_url and p_idx and p_idx.isdigit() and p_tot and p_tot.isdigit() and int(p_tot) > 0:
                            idx_val = int(p_idx)
                            tot_val = int(p_tot)
                            sub_pct = float(pct_str) if pct_str else 0.0
                            overall_pct = round(((idx_val - 1) + (sub_pct / 100.0)) / tot_val * 100.0, 1)
                            item["progress"] = min(99.9, max(item["progress"], overall_pct))
                            item["title"] = f"[{idx_val}/{tot_val}] {p_title or item.get('title', 'Parça')}"
                        elif pct_str:
                            item["progress"] = max(item["progress"], round(float(pct_str), 1))

                        if len(parts) > 2 and parts[2].isdigit():
                            dl_bytes = int(parts[2])
                            item["downloaded_bytes"] = dl_bytes
                            item["downloaded_str"] = format_bytes(dl_bytes)

                        if len(parts) > 3 and parts[3].isdigit():
                            tot_bytes = int(parts[3])
                            item["total_bytes"] = tot_bytes
                            item["total_str"] = format_bytes(tot_bytes)
                            rem_bytes = max(0, tot_bytes - item["downloaded_bytes"])
                            item["remaining_str"] = format_bytes(rem_bytes)

                        if len(parts) > 4:
                            eta_s = parts[4].strip()
                            if eta_s and eta_s != "NA":
                                item["eta"] = eta_s
                    except Exception:
                        pass
                elif os.path.isabs(line) and not line.startswith("["):
                    final_filepath = line.strip()

            proc.wait()
            ret = proc.returncode
            stderr_thread.join(timeout=1.0)

            with self.lock:
                if item["status"] == "downloading":
                    if ret == 0:
                        resolved_path = target_path if is_playlist_url else (final_filepath or target_path)
                        if not is_playlist_url and not os.path.exists(resolved_path):
                            matches = glob.glob(f"{root}.*")
                            if matches:
                                resolved_path = matches[0]

                        item["target_path"] = resolved_path
                        item["filename"] = os.path.basename(resolved_path)
                        item["progress"] = 100.0
                        item["status"] = "completed"
                        item["speed"] = "Tamamlandı"
                        if is_playlist_url:
                            item["title"] = f"✅ {os.path.basename(target_path)} (Tüm Mix İndirildi)"
                        self._on_download_completed(item)
                    else:
                        fallback_stream = item.get("url")
                        if fallback_stream and fallback_stream != dl_url and not fallback_stream.startswith("blob:"):
                            log(f"yt-dlp download failed for {dl_id}. Falling back to direct stream HTTP downloader: {fallback_stream[:80]}")
                            item["status"] = "downloading"
                            self.processes.pop(dl_id, None)
                            threading.Thread(target=self._run_segmented_http_download, args=(item,), daemon=True).start()
                            return

                        item["status"] = "failed"
                        item["speed"] = "Hata"
                        log(f"yt-dlp download {dl_id} failed with exit code {ret}. Last stderr:\n" + "\n".join(stderr_lines[-10:]))

                self.processes.pop(dl_id, None)
                self.save_history()

        except Exception as e:
            log(f"Exception running yt-dlp for {dl_id}: {e}")
            with self.lock:
                if item["status"] == "downloading":
                    item["status"] = "failed"
                    item["speed"] = "Hata"
                self.processes.pop(dl_id, None)
                self.save_history()
            raise

    def _run_segmented_http_download(self, item):
        dl_id = item["id"]
        url = item["url"]
        headers = dict(item.get("headers") or {})
        target_path = item["target_path"]
        save_dir = os.path.dirname(target_path)
        os.makedirs(save_dir, exist_ok=True)

        pause_event = threading.Event()
        pause_event.set()
        cancel_event = threading.Event()

        session = requests.Session()
        session.verify = False
        adapter = HTTPAdapter(max_retries=Retry(total=5, backoff_factor=0.5, status_forcelist=[500, 502, 503, 504]))
        session.mount("https://", adapter)
        session.mount("http://", adapter)

        with self.lock:
            self.workers[dl_id] = {
                "type": "segmented_http",
                "pause_event": pause_event,
                "cancel_event": cancel_event,
                "session": session
            }

        req_hdrs = dict(headers)
        if not req_hdrs.get("User-Agent") and not req_hdrs.get("user-agent"):
            req_hdrs["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        if any(tok in url for tok in ["tiktokcdn.com", "akamaized.net", "tiktok.com", "byteoversea.com", "ibyteimg.com"]):
            if not req_hdrs.get("Referer") and not req_hdrs.get("referer"):
                req_hdrs["Referer"] = "https://www.tiktok.com/"

        log(f"Probing segmented HTTP capabilities for {dl_id}: {url}")

        total_bytes = None
        accept_ranges = False

        try:
            head_resp = session.head(url, headers=req_hdrs, timeout=8, allow_redirects=True)
            if head_resp.status_code in [200, 206]:
                cl = head_resp.headers.get("Content-Length")
                if cl and cl.isdigit():
                    total_bytes = int(cl)
                if head_resp.headers.get("Accept-Ranges", "").lower() == "bytes":
                    accept_ranges = True
        except Exception as e:
            log(f"HEAD check failed for {dl_id}: {e}")

        # If HEAD didn't confirm ranges, probe with 0-0 byte range request
        if not accept_ranges or not total_bytes:
            test_hdrs = dict(req_hdrs)
            test_hdrs["Range"] = "bytes=0-0"
            try:
                probe_resp = session.get(url, headers=test_hdrs, timeout=8, stream=True)
                if probe_resp.status_code == 206:
                    accept_ranges = True
                    cr = probe_resp.headers.get("Content-Range", "")
                    m = re.search(r'/(\d+)', cr)
                    if m:
                        total_bytes = int(m.group(1))
                probe_resp.close()
            except Exception as e:
                log(f"Range probe failed for {dl_id}: {e}")

        with self.lock:
            if total_bytes and total_bytes > 0:
                item["total_bytes"] = total_bytes
                item["total_str"] = format_bytes(total_bytes)

        # Multi-connection segmented download if Range is supported and file is >= 256KB
        if accept_ranges and total_bytes and total_bytes >= 256 * 1024:
            num_workers = min(8, max(2, total_bytes // (512 * 1024)))
            log(f"Segmented multi-range download for {dl_id}: {num_workers} parallel connections, total {total_bytes} bytes")
            chunk_size = total_bytes // num_workers
            ranges = []
            for i in range(num_workers):
                start_byte = i * chunk_size
                end_byte = (i + 1) * chunk_size - 1 if i < num_workers - 1 else total_bytes - 1
                ranges.append((start_byte, end_byte))

            threads = []
            worker_errors = []

            def _part_worker(part_idx, r_start, r_end):
                part_path = f"{target_path}.ldm_part_{part_idx}"
                existing_bytes = os.path.getsize(part_path) if os.path.exists(part_path) else 0
                part_target_len = r_end - r_start + 1

                if existing_bytes >= part_target_len:
                    return

                cur_start = r_start + existing_bytes
                part_hdrs = dict(req_hdrs)
                part_hdrs["Range"] = f"bytes={cur_start}-{r_end}"

                for attempt in range(5):
                    if cancel_event.is_set():
                        return
                    pause_event.wait()
                    try:
                        r = session.get(url, headers=part_hdrs, stream=True, timeout=15)
                        if r.status_code in [200, 206]:
                            with open(part_path, "ab") as pf:
                                for chunk in r.iter_content(chunk_size=64 * 1024):
                                    if cancel_event.is_set():
                                        return
                                    pause_event.wait()
                                    if chunk:
                                        pf.write(chunk)
                            break
                        else:
                            raise ValueError(f"HTTP {r.status_code}")
                    except Exception as err:
                        if attempt == 4:
                            worker_errors.append(f"Worker {part_idx} error: {err}")
                        time.sleep(1)

            for i, (rs, re_byte) in enumerate(ranges):
                t = threading.Thread(target=_part_worker, args=(i, rs, re_byte))
                t.daemon = True
                t.start()
                threads.append(t)

            last_dl = 0
            last_time = time.time()
            while any(t.is_alive() for t in threads):
                if cancel_event.is_set():
                    return False
                time.sleep(0.5)

                current_dl = 0
                for i in range(num_workers):
                    p_file = f"{target_path}.ldm_part_{i}"
                    if os.path.exists(p_file):
                        current_dl += os.path.getsize(p_file)

                now = time.time()
                dt = now - last_time
                if dt >= 1.0:
                    spd_bytes = max(0, (current_dl - last_dl) / dt)
                    last_dl = current_dl
                    last_time = now
                    with self.lock:
                        if item["status"] == "downloading":
                            item["downloaded_bytes"] = current_dl
                            item["downloaded_str"] = format_bytes(current_dl)
                            if total_bytes > 0:
                                prg = min(99.9, round((current_dl / total_bytes) * 100, 1))
                                item["progress"] = prg
                                rem_b = max(0, total_bytes - current_dl)
                                item["remaining_str"] = format_bytes(rem_b)
                                if spd_bytes > 0:
                                    eta_sec = int(rem_b / spd_bytes)
                                    item["eta"] = format_duration(eta_sec)
                            item["speed"] = f"{format_bytes(int(spd_bytes))}/s"
                            item["speed_bytes"] = int(spd_bytes)

            for t in threads:
                t.join(timeout=2.0)

            if worker_errors:
                log(f"Segmented download encountered worker errors: {worker_errors}")
                return False

            # Assemble parts into final target_path
            with open(target_path, "wb") as outfile:
                for i in range(num_workers):
                    p_file = f"{target_path}.ldm_part_{i}"
                    if os.path.exists(p_file):
                        with open(p_file, "rb") as infile:
                            shutil.copyfileobj(infile, outfile, length=1024 * 1024)
                        try:
                            os.remove(p_file)
                        except Exception:
                            pass

            with self.lock:
                self._on_download_completed(item)
                self.workers.pop(dl_id, None)
            return True

        else:
            # Single connection streaming download fallback
            log(f"Single connection streaming HTTP download for {dl_id}: {url}")
            r = session.get(url, headers=req_hdrs, stream=True, timeout=20)
            if r.status_code not in [200, 206]:
                return False

            cl = r.headers.get("Content-Length")
            if cl and cl.isdigit() and not total_bytes:
                total_bytes = int(cl)
                with self.lock:
                    item["total_bytes"] = total_bytes
                    item["total_str"] = format_bytes(total_bytes)

            downloaded = 0
            last_dl = 0
            last_time = time.time()
            with open(target_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=64 * 1024):
                    if cancel_event.is_set():
                        return False
                    pause_event.wait()
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)

                        now = time.time()
                        dt = now - last_time
                        if dt >= 1.0:
                            spd = max(0, (downloaded - last_dl) / dt)
                            last_dl = downloaded
                            last_time = now
                            with self.lock:
                                if item["status"] == "downloading":
                                    item["downloaded_bytes"] = downloaded
                                    item["downloaded_str"] = format_bytes(downloaded)
                                    if total_bytes and total_bytes > 0:
                                        item["progress"] = min(99.9, round((downloaded / total_bytes) * 100, 1))
                                        rem = max(0, total_bytes - downloaded)
                                        item["remaining_str"] = format_bytes(rem)
                                        if spd > 0:
                                            item["eta"] = format_duration(int(rem / spd))
                                    item["speed"] = f"{format_bytes(int(spd))}/s"

            with self.lock:
                self._on_download_completed(item)
                self.workers.pop(dl_id, None)
            return True

    def _run_ffmpeg_download(self, item):
        dl_id = item["id"]
        url = item["url"]
        headers = item["headers"]
        target_path = item["target_path"]

        log(f"Starting ffmpeg fallback for {dl_id}: {url}")

        # Resolve duration and total size before or during download
        try:
            dur_sec, tot_bytes = self._resolve_media_info(url, headers)
            if dur_sec and dur_sec > 0:
                item["duration_seconds"] = dur_sec
                item["duration"] = format_duration(dur_sec)
                log(f"Resolved duration for {dl_id}: {item['duration']} ({dur_sec:.1f}s)")
            if tot_bytes and tot_bytes > 0:
                item["total_bytes"] = tot_bytes
                item["total_str"] = format_bytes(tot_bytes)
        except Exception as e:
            log(f"Could not resolve media info: {e}")

        referer = headers.get("Referer") or headers.get("referer") or ""
        user_agent = headers.get("User-Agent") or headers.get("user-agent") or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

        header_str = ""
        if referer:
            header_str += f"Referer: {referer}\r\n"
        if user_agent:
            header_str += f"User-Agent: {user_agent}\r\n"
        for k, v in headers.items():
            if k.lower() not in ["referer", "user-agent"]:
                header_str += f"{k}: {v}\r\n"

        cmd = [
            "ffmpeg",
            "-y",
            "-allowed_extensions", "ALL",
            "-allowed_segment_extensions", "ALL",
            "-extension_picky", "0",
            "-reconnect", "1",
            "-reconnect_at_eof", "1",
            "-reconnect_streamed", "1",
            "-reconnect_delay_max", "5",
            "-nostats",
            "-progress", "pipe:1",
            "-headers", header_str,
            "-i", url,
            "-map", "0:v?",
            "-map", "0:a?",
            "-c", "copy",
            "-movflags", "+faststart",
            target_path
        ]

        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
            with self.lock:
                self.processes[dl_id] = proc

            stderr_lines = []
            def _drain_stderr():
                try:
                    for err_line in iter(proc.stderr.readline, ''):
                        if not err_line:
                            break
                        err_line = err_line.strip()
                        if err_line:
                            if len(stderr_lines) >= 30:
                                stderr_lines.pop(0)
                            stderr_lines.append(err_line)
                except Exception:
                    pass

            stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
            stderr_thread.start()

            last_size = 0
            last_time = time.time()

            for line in iter(proc.stdout.readline, ''):
                if not line:
                    break
                line = line.strip()
                if not line or "=" not in line:
                    continue

                k, v = line.split("=", 1)
                if k == "total_size":
                    try:
                        curr_size = int(v)
                        now = time.time()
                        elapsed = now - last_time
                        if elapsed >= 0.8:
                            diff = curr_size - last_size
                            if diff > 0:
                                speed_bps = diff / elapsed
                                if item.get("speed_bytes") and item["speed_bytes"] > 0:
                                    speed_bps = (item["speed_bytes"] * 0.6) + (speed_bps * 0.4)
                                item["speed_bytes"] = int(speed_bps)
                                item["speed"] = f"{format_bytes(speed_bps)}/s"
                                last_size = curr_size
                                last_time = now
                            elif elapsed > 4.0:
                                item["speed_bytes"] = 0
                                item["speed"] = "0.0 B/s"
                                last_time = now

                        item["downloaded_bytes"] = curr_size
                        item["downloaded_str"] = format_bytes(curr_size)

                        if item.get("total_bytes") and item["total_bytes"] > 0:
                            rem = max(0, item["total_bytes"] - curr_size)
                            item["remaining_str"] = format_bytes(rem)
                    except Exception:
                        pass

                elif k == "speed":
                    item["multiplier"] = v

                elif k == "out_time_ms":
                    try:
                        out_ms = int(v)
                        out_sec = out_ms / 1000000.0

                        dur_sec = item.get("duration_seconds")
                        if dur_sec and dur_sec > 0:
                            progress = min(99.9, (out_sec / dur_sec) * 100.0)
                            item["progress"] = round(progress, 1)

                            if out_sec > 2 and item["downloaded_bytes"] > 0:
                                bitrate = item["downloaded_bytes"] / out_sec
                                est_total = int(bitrate * dur_sec)
                                item["total_bytes"] = est_total
                                item["total_str"] = format_bytes(est_total)
                                rem_bytes = max(0, est_total - item["downloaded_bytes"])
                                item["remaining_str"] = format_bytes(rem_bytes)
                                if item.get("speed_bytes") and item["speed_bytes"] > 0:
                                    eta_sec = rem_bytes / item["speed_bytes"]
                                    item["eta_seconds"] = int(eta_sec)
                                    item["eta"] = format_duration(eta_sec)
                        elif item.get("total_bytes") and item["total_bytes"] > 0:
                            curr = item["downloaded_bytes"]
                            progress = min(99.9, (curr / item["total_bytes"]) * 100.0)
                            item["progress"] = round(progress, 1)
                            rem_bytes = max(0, item["total_bytes"] - curr)
                            item["remaining_str"] = format_bytes(rem_bytes)
                            if item.get("speed_bytes") and item["speed_bytes"] > 0:
                                eta_sec = rem_bytes / item["speed_bytes"]
                                item["eta_seconds"] = int(eta_sec)
                                item["eta"] = format_duration(eta_sec)
                        else:
                            item["duration"] = format_duration(out_sec)
                    except Exception:
                        pass

                elif k == "progress" and v == "end":
                    item["progress"] = 100.0

            proc.wait()
            ret = proc.returncode
            stderr_thread.join(timeout=1.0)

            with self.lock:
                if item["status"] == "downloading":
                    if ret == 0:
                        self._on_download_completed(item)
                    else:
                        item["status"] = "failed"
                        item["speed"] = "Hata"
                        log(f"Download {dl_id} failed with exit code {ret}. Last stderr:\n" + "\n".join(stderr_lines[-10:]))

                self.processes.pop(dl_id, None)
                self.save_history()

            log(f"Download {dl_id} finished with status {item['status']}")

        except Exception as e:
            log(f"Exception downloading {dl_id}: {e}")
            with self.lock:
                item["status"] = "failed"
                self.processes.pop(dl_id, None)
                self.save_history()

manager = DownloadManager()

class RequestHandler(BaseHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ["/", "/index.html"]:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            try:
                with open("/home/dream/linux-download-manager/browser/chromium/popup.html", "rb") as f:
                    self.wfile.write(f.read())
            except Exception:
                self.wfile.write(b"<h1>Linux Download Manager</h1>")
        elif parsed.path == "/api/downloads":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            with manager.lock:
                data = {"downloads": manager.downloads}
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        elif parsed.path == "/api/settings":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "settings": manager.settings}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        content_length = int(self.headers.get("Content-Length", 0))
        post_data = self.rfile.read(content_length) if content_length > 0 else b"{}"
        try:
            body = json.loads(post_data.decode("utf-8")) if post_data else {}
        except Exception:
            body = {}

        if parsed.path == "/api/downloads/add":
            url = body.get("url")
            title = body.get("title") or body.get("sourceTitle")
            headers = body.get("headers") or body.get("httpHeaders")
            source_page = body.get("sourcePageUrl")
            save_dir = body.get("saveDir")
            format_opt = body.get("format")
            force_ytdlp = body.get("forceYtdlp", False)
            is_playlist = body.get("isPlaylist", False) or body.get("is_playlist", False)

            if not url:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "Missing url"}')
                return

            item = manager.add_download(
                url,
                title=title,
                headers=headers,
                source_page=source_page,
                save_dir=save_dir,
                format=format_opt,
                force_ytdlp=force_ytdlp,
                is_playlist=is_playlist
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "download": item}).encode("utf-8"))

        elif parsed.path == "/api/downloads/pause":
            dl_id = body.get("id")
            ok = manager.pause_download(dl_id)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": ok}).encode("utf-8"))

        elif parsed.path == "/api/downloads/resume":
            dl_id = body.get("id")
            ok = manager.resume_download(dl_id)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": ok}).encode("utf-8"))

        elif parsed.path == "/api/downloads/cancel":
            dl_id = body.get("id")
            ok = manager.cancel_download(dl_id)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": ok}).encode("utf-8"))

        elif parsed.path == "/api/downloads/clear":
            ok = manager.clear_history()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": ok}).encode("utf-8"))

        elif parsed.path == "/api/open-folder":
            dl_id = body.get("id")
            item = manager.get_download(dl_id)
            if item and item.get("target_path"):
                target = item["target_path"]
                folder = target if os.path.isdir(target) else os.path.dirname(target)
                if os.path.exists(folder):
                    try:
                        env = os.environ.copy()
                        if "DISPLAY" not in env: env["DISPLAY"] = ":0"
                        if "WAYLAND_DISPLAY" not in env and os.path.exists(f"/run/user/{os.getuid()}/wayland-0"): env["WAYLAND_DISPLAY"] = "wayland-0"
                        if "DBUS_SESSION_BUS_ADDRESS" not in env and os.path.exists(f"/run/user/{os.getuid()}/bus"): env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path=/run/user/{os.getuid()}/bus"
                        subprocess.Popen(["xdg-open", folder], env=env)
                    except Exception:
                        pass
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok": true}')

        elif parsed.path == "/api/open-file":
            dl_id = body.get("id")
            item = manager.get_download(dl_id)
            if item and item.get("target_path") and os.path.exists(item["target_path"]):
                file_path = item["target_path"]
                try:
                    env = os.environ.copy()
                    if "DISPLAY" not in env: env["DISPLAY"] = ":0"
                    if "WAYLAND_DISPLAY" not in env and os.path.exists(f"/run/user/{os.getuid()}/wayland-0"): env["WAYLAND_DISPLAY"] = "wayland-0"
                    if "DBUS_SESSION_BUS_ADDRESS" not in env and os.path.exists(f"/run/user/{os.getuid()}/bus"): env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path=/run/user/{os.getuid()}/bus"
                    subprocess.Popen(["xdg-open", file_path], env=env)
                except Exception:
                    pass
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok": true}')

        elif parsed.path == "/api/settings":
            speed_limit = body.get("speed_limit_kbps")
            if speed_limit is not None:
                try:
                    manager.settings["speed_limit_kbps"] = max(0, int(speed_limit))
                except Exception:
                    pass
            if "auto_shutdown" in body:
                manager.settings["auto_shutdown"] = bool(body["auto_shutdown"])
            manager.save_settings()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "settings": manager.settings}).encode("utf-8"))

        else:
            self.send_response(404)
            self.end_headers()

def run_server():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), RequestHandler)
    log(f"LDM Parallel Daemon server started on http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == "__main__":
    run_server()
