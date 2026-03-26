# Wiktionary Audio Downloader

Chrome extension (Manifest V3) that finds pronunciation audio on any Wiktionary page and lets you download the original file or convert it to WAV locally via FFmpeg.wasm. No servers, no remote code.

## Features

- Discovers audio on all Wiktionary language editions (UI: EN/DE/FR/ES/IT/JA/ZH)
- **Original** mode — download the source file (OGG/Opus, MP3, etc.)
- **Convert** mode — transcode to 16-bit PCM WAV (mono, 48 kHz) in-browser
- Batch download, minimizable on-page panel

## Install

1. Clone the repo
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → select this folder
3. Pin the extension (optional)

## Usage

1. Visit any Wiktionary entry (e.g. `en.wiktionary.org/wiki/water`)
2. Pick **Original** or **Convert** in the popup
3. Use the on-page panel to download individual files or all at once

## How it works

```
Content Script → Service Worker → Offscreen (FFmpeg.wasm) → Downloads
```

1. Content script discovers audio via MediaWiki REST API (Action API fallback)
2. Service worker routes downloads — direct save or conversion
3. Offscreen document runs FFmpeg.wasm (single-thread, vendored) for WAV transcoding
4. Files save to your default Downloads folder with sanitized filenames

## Troubleshooting

- **Slow first conversion** is expected (WASM compilation). Subsequent runs are fast.
- **"Extension Reloaded"** — refresh the Wiktionary tab after updating the extension.

## License

[GPL-3.0-only](LICENSE)
