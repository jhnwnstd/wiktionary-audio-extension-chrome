# Wiktionary Audio Downloader

A Chrome (Manifest V3) extension that finds pronunciation audio on any Wiktionary page and lets you **download the original file** or **convert it to WAV locally** with FFmpeg.wasm. No servers, no external code.

## What it does

* Detects audio on all Wiktionary language editions (UI localized for EN/DE/FR/ES/IT/JA/ZH; English fallback everywhere).
* Two modes:

  * **Original** — save the source file (OGG/OPUS/MP3/etc.).
  * **Convert** — transcode to **16-bit PCM WAV, mono, 48 kHz** in the browser via WebAssembly.
* Batch support: download one file or **Download All**.
* Compact, **minimizable** on-page panel; simple popup to pick mode.

## How it works

1. The content script discovers audio via the MediaWiki REST API, with the Action API as a fallback.
2. For conversion, an **offscreen document** loads **FFmpeg.wasm (single-thread core)** and performs the transcode.
3. The service worker saves the result to your **Downloads** folder.

Everything runs locally. FFmpeg is vendored with the extension.

## Supported formats

* Detects by MIME first, then extension. Works with **OGG/Opus, MP3, WAV, WebM, AAC/MP4, FLAC** and more.
* Output (Convert mode): **WAV (PCM 16-bit, mono, 48 kHz)**.

## Install

1. Clone the repo.
2. Open `chrome://extensions/` → enable **Developer mode**.
3. **Load unpacked** → select the project folder.
4. (Optional) Pin the extension.

## Use

1. Visit a Wiktionary entry (e.g., `https://en.wiktionary.org/wiki/water`).
2. Choose **Original** or **Convert** in the extension popup.
3. Use the on-page “Audio Files” panel to **Download** items or **Download All**.
4. Minimize/restore the panel with the −/+ control.

## Files of interest

* `content-script.js` — UI on the page, discovery, minimize panel.
* `background.js` — service worker, download handling.
* `offscreen.js` / `offscreen.html` — FFmpeg.wasm integration.
* `popup.html` / `popup.js` — settings UI.
* `vendor/ffmpeg/` — FFmpeg.wasm core and worker (bundled).

## Permissions & compliance

* Minimal MV3 permissions (`downloads`, `storage`, `offscreen`).
* No remote code; respectful API usage.
* Accessible UI with keyboard focus states and clear status messages.

## Troubleshooting

* Slow first run is expected (Wasm compile). Later runs are much faster.
* Files save to your default **Downloads** folder with sanitized filenames.

## License

**GNU General Public License v3.0 (GPL-3.0-only).**

This extension is Free Software: you can redistribute and/or modify it under the terms of the GPL-3.0.  
If you distribute the extension (e.g., via the Chrome Web Store), you must make the corresponding source code available under the same license and include a copy of the license.

See [`LICENSE`](LICENSE) for the full text.
