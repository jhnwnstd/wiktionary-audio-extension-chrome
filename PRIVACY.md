# Privacy Policy

**Wiktionary Audio Downloader** runs entirely on your machine. It contacts no analytics or telemetry service, has no access to websites other than Wiktionary, and never uploads your audio anywhere.

## What this extension collects

Nothing. No analytics, no telemetry, no usage tracking, no error reporting, no user identifiers.

## Persistent settings

The extension stores your selected download mode (Original, Convert, or Both) using Chrome's built-in `storage.sync` API. If you are signed in to Chrome with sync enabled, Chrome may sync this single setting across your own installations. The extension stores nothing else.

## Network requests

The extension makes HTTPS requests only to:

- `*.wiktionary.org`, to query the MediaWiki API and find audio on the entry you are viewing
- `upload.wikimedia.org`, to fetch audio files when you click Preview or Download

Requests are sent without cookies or credentials. After any redirect, the response URL is rechecked against this allowlist; a redirect to anywhere else is rejected and the bytes discarded. The extension contacts no analytics, advertising, or third-party server.

## Audio processing

WAV conversion runs in your browser using a bundled copy of FFmpeg.wasm. Audio bytes are never uploaded. The FFmpeg code ships inside the extension package itself; nothing is loaded from the network at runtime.

## Permissions

- `downloads`: save files to your Downloads folder when you click Download. The extension does not read your existing downloads.
- `storage`: remember your mode preference.
- `offscreen`: host the local FFmpeg.wasm worker.
- Host access limited to `*.wiktionary.org` and `*.wikimedia.org`. The extension cannot read or modify any other website.

## Source code

The extension is open source: <https://github.com/jhnwnstd/wiktionary-audio-extension-chrome>. You can read the source to confirm what the extension does and does not touch.

## Contact

For questions about this policy or the extension, open an issue on the GitHub repository.