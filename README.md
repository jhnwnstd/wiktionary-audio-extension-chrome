# Wiktionary Audio Downloader

[![CI](https://github.com/jhnwnstd/wiktionary-audio-extension-chrome/actions/workflows/ci.yml/badge.svg)](https://github.com/jhnwnstd/wiktionary-audio-extension-chrome/actions/workflows/ci.yml)

Chrome extension that converts Wiktionary pronunciation audio into WAV files locally.

Converted output is 16-bit PCM at 48 kHz, mono, with triangular dither. The original source files (OGG, Opus, MP3) are also downloadable as-is.

## Features

- Praat-ready WAV file output 
- Original source files (OGG, Opus, MP3) downloadable as-is
- Finds pronunciation audio across Wiktionary language editions
- Plays a preview before download
- Names files with parsed metadata, for example `english_australian_water.ogg`

## Install

1. Clone the repository or download and unzip the [latest release](https://github.com/jhnwnstd/wiktionary-audio-extension-chrome/releases/latest).
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

The extension requires Manifest V3 and `chrome.offscreen`, which is available in Chrome 109 and newer. Other Chromium based browsers should work if they support the same extension APIs.

## Permissions

- `downloads` to save audio files
- `storage` to remember the selected mode
- `offscreen` to run local FFmpeg.wasm conversion
- Host access limited to Wiktionary and Wikimedia

The extension collects no data and contacts no third-party servers. See [PRIVACY.md](PRIVACY.md).

## Development

```bash
git clone https://github.com/jhnwnstd/wiktionary-audio-extension-chrome.git
cd wiktionary-audio-extension-chrome
npm install
npm run check       # lint + unit tests
npm run test:e2e    # Playwright tests against local fixtures
npm run test:live   # live tests against real Wiktionary URLs
```

Vendored FFmpeg core: `@ffmpeg/core@0.12.10` at `src/vendor/ffmpeg/core/`. Conversion args live in `runTranscode` in `src/offscreen.js`; the live convert test verifies them against the vendored core.

## License

[GPL-3.0-only](LICENSE)
