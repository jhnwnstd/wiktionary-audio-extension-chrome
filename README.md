# Wiktionary Audio Downloader

Chrome extension that finds pronunciation audio on Wiktionary pages.

Download the original audio file or convert it to WAV locally with vendored FFmpeg.wasm.

## Features

- Finds pronunciation audio across all Wiktionary language editions
- Supports Original mode for source files such as OGG, Opus, and MP3
- Supports Convert mode for a local WAV copy, 16 bit PCM, mono, 48 kHz, with triangular dithering on bit depth reduction
- Plays a preview of each audio file before download
- Names files with parsed metadata, for example `english_australian_water.ogg`
- Batch downloads land in a `Wiktionary-{edition}-{page}` subfolder of Downloads
- Supports single-file and batch download

## Install

This is a zero build extension. Chrome loads `src/` directly.

1. Clone the repository.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Select Load unpacked.
5. Select the `src/` folder, not the repository root.
6. Pin the extension if desired.

## Usage

1. Open a Wiktionary entry, such as [https://en.wiktionary.org/wiki/friendo](https://en.wiktionary.org/wiki/friendo).
2. Open the extension popup and choose a mode: Original, Convert, or Both.
3. Use the on-page panel to preview a file, download one file, or download all files.

Batch downloads are grouped into a single subfolder named `Wiktionary-{edition}-{page}` so they do not clutter the Downloads folder.

## Permissions

- `downloads` saves audio files
- `storage` remembers the selected mode
- `offscreen` runs FFmpeg.wasm conversion
- Host permissions allow access only to Wiktionary pages and Wikimedia audio resources

## Development

The repository root contains development tooling. The extension itself lives in `src/`.

```bash
git clone https://github.com/jhnwnstd/wiktionary-audio-extension-chrome.git
cd wiktionary-audio-extension-chrome
npm install
npm run check       # lint + unit tests
npm run test:e2e    # deterministic Playwright tests against a local fixture
npm run test:live   # live tests against real Wiktionary URLs (slower)
```

The vendored FFmpeg core is `@ffmpeg/core@0.12.10` ESM at `src/vendor/ffmpeg/core/`. The conversion profile is set in `src/offscreen.js` via `FFMPEG_CORE_PROFILE` and is verified by the live convert test.
