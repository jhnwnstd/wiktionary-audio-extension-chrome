# Privacy Policy

**Wiktionary Audio Downloader** is designed to work without collecting personal information.

## What this extension collects

Nothing. The extension does not use analytics, telemetry, usage tracking, error reporting, or user identifiers.

## Persistent settings

The extension stores the selected download mode setting on your device using Chrome's built-in `storage.sync` API. This allows the extension to remember your preference for Original, Convert, or Both modes.

If you are signed in to Chrome and have sync enabled, Chrome may sync this setting across your own Chrome installations. The extension stores nothing else.

## Network requests

The extension makes web requests only to:

- `*.wiktionary.org`, to query the MediaWiki API and find audio files on the entry you are viewing
- `commons.wikimedia.org`, to query file metadata from Wikimedia Commons
- `upload.wikimedia.org`, to fetch audio files when you click Preview or Download

The extension does not contact any analytics, advertising, error reporting, nor conversion server.

## Conversion location

WAV conversion uses vendored FFmpeg.wasm, which runs inside your browser on your own machine. Audio bytes are not uploaded to a conversion server.

## Permission details

- `downloads`, so the extension can save files to your Downloads folder when you click Download. The extension does not access files you have already downloaded.
- `storage`, to remember your Original, Convert, or Both mode preference.
- `offscreen`, to host the local FFmpeg.wasm conversion worker.
- Host access to `*.wiktionary.org` and `*.wikimedia.org`, to fetch the page's audio file list and the audio files themselves. The extension does not request access to other websites.

## Source code

The extension is open source: <https://github.com/jhnwnstd/wiktionary-audio-extension-chrome>. You can inspect the source code to confirm what the extension does.

## Contact

For questions about this policy or the extension, open an issue on the GitHub repository.