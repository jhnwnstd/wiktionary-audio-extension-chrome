# Wiktionary Audio Downloader

[![CI](https://github.com/jhnwnstd/wiktionary-audio-extension-chrome/actions/workflows/ci.yml/badge.svg)](https://github.com/jhnwnstd/wiktionary-audio-extension-chrome/actions/workflows/ci.yml)

Chrome extension for downloading Wiktionary audio as the original file or a locally converted WAV copy.

## Features

- Finds pronunciation audio across Wiktionary language editions
- Original mode: source files such as OGG, Opus, and MP3
- Convert mode: 16-bit WAV Linear PCM, 48 kHz, mono, TPDF-dithered
- Plays a preview of each audio file before download
- Names files with parsed metadata, for example `english_australian_water.ogg`

## Install

Install directly from this repository.

1. Clone the repository or download and unzip the latest release.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Select Load unpacked.
5. Select the `src/` folder only, not the repository root.

## Usage

1. Open a Wiktionary entry, such as [friendo on Wiktionary](https://en.wiktionary.org/wiki/friendo).
2. Open the extension popup and choose Original, Convert, or Both.
3. Use the on-page panel to preview one file, download one file, or download all files.

Batch downloads are grouped into a single subfolder named `Wiktionary-{edition}-{page}`.

## Supported browsers

The extension requires Manifest V3 and `chrome.offscreen`, which is available in Chrome 109 and newer. Other Chromium based browsers may work if they support the same extension APIs, but Chrome is the supported target.

## Permissions

- `downloads` to save audio files
- `storage` to remember the selected mode
- `offscreen` to run local FFmpeg.wasm conversion
- Host access limited to Wiktionary and Wikimedia

The extension collects no data and contacts no third-party servers. See [PRIVACY.md](PRIVACY.md) for the full breakdown of permissions and network behavior.

## Development

```bash
git clone https://github.com/jhnwnstd/wiktionary-audio-extension-chrome.git
cd wiktionary-audio-extension-chrome
npm install
npm run check       # lint + unit tests
npm run test:e2e    # Playwright tests against local fixtures
npm run test:live   # live tests against real Wiktionary URLs
```

The vendored FFmpeg core is `@ffmpeg/core@0.12.10` ESM at `src/vendor/ffmpeg/core/`. The conversion profile is set in `src/offscreen.js` with `FFMPEG_CORE_PROFILE` and verified by the live convert test.

## License

[GPL-3.0-only](LICENSE)
