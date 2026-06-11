# ⚓ SubSync

A polished desktop subtitle sync tool for the WiseTech eLearning team.  
Powered by [anchor-sub-sync](https://github.com/ellite/anchor-sub-sync) + OpenAI Whisper.

**End users need nothing pre-installed.** Python, ffmpeg, and all packages are bundled inside the installer.

---

## What it does

| Feature | Description |
|---|---|
| **AI Auto-Sync** | Uses Whisper to listen to your video and align every subtitle line automatically |
| **Manual editing** | Click any cue to edit timecodes, tweak text, nudge timing ±0.1s / ±1s |
| **Global offset** | Shift all cues forward or backward by any amount |
| **Live preview** | Watch subtitles play over the video in real time |
| **Export** | Download a clean, renumbered `.srt` ready for your LMS |

---

## For end users (eLearning team)

1. Run `SubSync Setup x.x.x.exe`
2. Click **Next → Install → Finish**
3. Open SubSync from the desktop shortcut
4. Done — no Python, no terminal, no PATH configuration needed

> **Note:** On first use of AI Auto-Sync, Whisper will download the selected model (~150MB for
> "Small"). This happens once and is cached. A progress bar shows the download status.

---

## For developers (building the installer)

### Prerequisites
- Windows 10/11 (64-bit)
- [Node.js 18+](https://nodejs.org)
- Internet connection (the build script downloads Python + ffmpeg automatically)

### Steps

```
git clone <this-repo>
cd subsync-app

# One-time: install Node deps + Python venv for local dev
scripts\setup-dev.bat

# Run locally for testing
npm start

# Build the self-contained Windows installer (~600MB)
# This downloads Python embeddable + all packages + ffmpeg automatically
scripts\build-full.bat
```

The installer is created at `dist\SubSync Setup 1.0.0.exe`.

### What `build-full.bat` does automatically
1. Downloads **Python 3.11 embeddable** (no system Python needed on users' machines)
2. Bootstraps **pip** into the embeddable Python
3. Installs `flask`, `flask-cors`, `anchor-sub-sync`, `openai-whisper`, `torch` (CPU) into the bundle
4. Downloads **ffmpeg-essentials** static binary
5. Copies `python/server.py` into the bundle
6. Runs `electron-builder` to package everything into an NSIS `.exe` installer

Downloads are cached in `build-cache\` so re-runs are fast.

---

## Project structure

```
subsync-app/
├── main.js              # Electron main process — window, IPC, Python launcher
├── preload.js           # Secure IPC bridge (contextIsolation)
├── package.json         # App config + electron-builder settings
│
├── src/
│   ├── index.html       # Main app UI
│   ├── app.js           # All renderer logic (subtitle editing, API calls)
│   ├── splash.html      # Loading screen while Python starts
│   └── error.html       # Shown if Python backend fails
│
├── python/
│   ├── server.py        # Flask API wrapping anchor-sub-sync
│   └── requirements.txt # Dev Python dependencies
│
├── python-bundle/       # Created by build-full.bat — NOT committed to git
│   ├── python.exe       # Embeddable Python 3.11
│   ├── ffmpeg.exe       # Static ffmpeg binary
│   ├── server.py        # Copy of the Flask server
│   └── Lib/site-packages/  # All installed Python packages
│
├── build-cache/         # Downloaded zips (cached, NOT committed to git)
│
├── resources/
│   ├── icon.ico         # App icon (Windows)
│   └── icon.png         # App icon (general)
│
└── scripts/
    ├── setup-dev.bat    # One-time developer setup (npm start only)
    └── build-full.bat   # Full automated build → self-contained .exe installer
```

---

## How the architecture works

```
[User double-clicks SubSync shortcut]
         |
  [Electron window] ── shows splash.html
         |
   [main.js] ─── spawns ──> [python-bundle/python.exe server.py]
                                     Flask on localhost:57832
                                            |
                              [anchor CLI + Whisper + ffmpeg]
                                    (all bundled, no PATH)
```

1. Installer unpacks everything to `%LOCALAPPDATA%\Programs\SubSync\`
2. Electron launches → splash screen shows
3. `main.js` spawns the bundled `python.exe` running `server.py`
4. Flask starts on `localhost:57832` — Electron polls `/health` until ready
5. Main UI loads
6. "AI Auto-Sync" POSTs job to `/sync/auto` → Flask spawns `anchor` CLI
7. UI polls `/job/<id>` every 800ms for progress updates
8. Completed `.srt` is loaded back into the timeline editor

---

## Installer size estimate

| Component | Size |
|---|---|
| Electron runtime | ~120MB |
| Python 3.11 embeddable | ~15MB |
| PyTorch CPU + Whisper | ~500MB |
| anchor-sub-sync + Flask | ~10MB |
| ffmpeg static binary | ~80MB |
| **Total installer** | **~700MB** |

> The installer compresses well with NSIS — expect ~300–400MB download size.

---

## Whisper model sizes (downloaded on first use)

| Model | Size | Speed | Accuracy |
|---|---|---|---|
| Tiny | ~75MB | Very fast | Good |
| Small | ~150MB | Fast | Better — **recommended** |
| Medium | ~300MB | Moderate | High |
| Large | ~600MB | Slow (GPU recommended) | Best |
