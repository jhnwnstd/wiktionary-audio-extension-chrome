# Wiktionary Audio Downloader

Chrome extension using Manifest V3 that finds pronunciation audio on Wiktionary pages and lets you download the original file or convert it to WAV locally with FFmpeg.wasm.

No conversion servers are used. FFmpeg.wasm is vendored and runs locally in the browser. The extension only contacts Wiktionary and Wikimedia endpoints needed to locate and fetch audio files.

## Features

- Discovers audio on Wiktionary language editions
- Supports English, German, French, Spanish, Italian, Japanese, and Chinese Wiktionary UI variants
- Downloads source audio files such as OGG, Opus, and MP3
- Converts audio to 16-bit PCM WAV, mono, 48 kHz
- Supports batch downloads
- Provides a minimizable on-page download panel

## Requirements

- Google Chrome or Chromium
- Node.js and npm, only if you want to run lint or tests
- Debian on WSL2 and VS Code are the maintainer's development environment, but any OS that runs Chrome will work

## Install

This is a zero-build extension. The `src/` folder is loaded directly into Chrome.

1. Clone the repository.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Select Load unpacked.
5. **Select the `src/` folder inside the cloned repository** — not the repository root.
6. Pin the extension, if desired.

The repository root contains only development tooling (tests, lint config, package.json). Everything Chrome needs to run the extension lives under `src/`.

## Usage

1. Visit a Wiktionary entry, such as `en.wiktionary.org/wiki/water`.
2. Open the extension popup.
3. Select Original or Convert.
4. Use the on-page panel to download individual files or all discovered files.

## How it works

```text
Content Script -> Service Worker -> Offscreen Document -> Downloads
```

1. The content script discovers audio through the MediaWiki REST API, with an Action API fallback.
2. The service worker routes download requests.
3. Original mode saves the source audio file directly.
4. Convert mode sends the file to an offscreen document.
5. The offscreen document runs single-threaded vendored FFmpeg.wasm.
6. The converted WAV file is saved through Chrome downloads.

## Permissions

The extension uses browser permissions to inspect Wiktionary pages, communicate between extension contexts, run an offscreen conversion worker, and save audio files through Chrome downloads. Audio conversion runs locally in the browser.

- `downloads` — save audio files to your Downloads folder
- `storage` — remember your Original or Convert mode setting
- `offscreen` — host the FFmpeg.wasm conversion worker
- Host access — `*.wiktionary.org` and `*.wikimedia.org` only

## Development

There is no build step. Edit the source files in place and reload the extension.

```bash
git clone https://github.com/jhnwnstd/wiktionary-audio-extension-chrome.git
cd wiktionary-audio-extension-chrome
npm install   # optional, only needed for lint and tests
npm run check # runs lint + unit tests
```

After editing extension files, reload the extension from `chrome://extensions`, then refresh any open Wiktionary tabs.

To enable debug logging, set `const DEBUG = true;` at the top of [src/content-script.js](src/content-script.js), [src/background.js](src/background.js), or [src/offscreen.js](src/offscreen.js). Content script logs appear in the page DevTools; the service worker has its own console under `chrome://extensions`.

## Troubleshooting

### First conversion is slow

The first conversion may be slow because the browser compiles the WASM module. Later conversions should be faster.

### Extension reloaded

After updating or reloading the extension, refresh the Wiktionary tab before using the panel again.

### No audio found

Check that the Wiktionary page contains pronunciation audio. Some entries do not include audio files.

## Privacy

The extension does not send files to a conversion server. Audio discovery and downloads use Wiktionary and Wikimedia resources only. Conversion runs locally in the browser.

## License

[GPL-3.0-only](LICENSE)
