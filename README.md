# Wiktionary Audio Downloader

Chrome extension that finds pronunciation audio on Wiktionary pages.

Download the original audio file or convert it to WAV locally with vendored FFmpeg.wasm.

## Features

- Finds pronunciation audio across Wiktionary language editions  
- Supports Original mode for source files such as OGG, Opus, and MP3  
- Supports Convert mode for a local WAV copy, 16 bit PCM, mono, 48 kHz  
- Supports Save Both mode for the original and the WAV copy in one click  
- Supports individual and batch downloads  
- Runs conversion locally in the browser  

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
2. Open the extension popup.
3. Choose Original or Convert.
4. Use the page panel to download one file or all files.

## Permissions

The extension uses these permissions.

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
npm run check