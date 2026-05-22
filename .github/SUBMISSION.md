# Chrome Web Store submission checklist

Working notes for getting this extension into the Chrome Web Store.

## Pre-submission checks

- [x] **Manifest V3** -- already in [../src/manifest.json](../src/manifest.json)
- [x] **Icons** at 16, 48, 128 px -- in [../src/icons/](../src/icons/)
- [x] **Description in manifest** under 132 chars
- [x] **`homepage_url`** in manifest -- points to GitHub repo
- [x] **No remote code loading** -- FFmpeg.wasm is vendored locally
- [x] **No inline `<script>` or `eval`** -- verified via CSP `script-src 'self' 'wasm-unsafe-eval'`
- [x] **Host permissions narrowly scoped** -- `*.wiktionary.org` and `*.wikimedia.org` only
- [x] **`web_accessible_resources` narrowly scoped** -- not the open `*://*/*`
- [x] **Privacy policy** -- [../PRIVACY.md](../PRIVACY.md); host the rendered URL when submitting
- [ ] **Screenshots** -- 1-3 PNGs at 1280x800, see "Screenshots to capture" below
- [ ] **Small promo tile** (optional but recommended) -- 440x280 PNG
- [ ] **Marquee promo tile** (optional) -- 1400x560 PNG
- [ ] **Verified email** -- Google asks for one tied to the publishing account
- [ ] **Listing categories** -- choose Productivity or Accessibility

## Listing copy

### Short description (132 chars max, shown on tiles + search)

> Download Wiktionary pronunciation audio. Save the original file or convert to WAV locally on your device.

(108 chars.)

### Detailed description (16,000 chars max, shown on the listing page)

> Wiktionary Audio Downloader finds pronunciation audio on any Wiktionary entry and saves it to your Downloads folder. You can save the original file (typically Ogg or MP3), convert it to a WAV copy on your computer, or save both.
>
> Features
> - Discovers audio on every Wiktionary language edition automatically
> - Save the original audio file as published on Wikimedia Commons
> - Or convert to a standardized WAV (16-bit PCM, mono, 48 kHz) using FFmpeg.wasm running locally in your browser
> - Preview each audio file before downloading
> - Friendly file naming: `english_australian_water.ogg` instead of cryptic source names
> - Batch downloads land in a per-page subfolder so they do not clutter Downloads
>
> Privacy
> - No data collection, no analytics, no tracking
> - WAV conversion runs entirely on your computer; nothing is uploaded
> - The extension only contacts Wiktionary and Wikimedia servers, exactly like your browser does when you load a Wiktionary page
> - Open source: https://github.com/jhnwnstd/wiktionary-audio-extension-chrome
>
> Permissions
> - Downloads: to save audio files to your Downloads folder
> - Storage: to remember your Original/Convert/Both preference
> - Offscreen: to host the local FFmpeg.wasm conversion worker
> - Access to Wiktionary and Wikimedia only -- the extension has no access to other websites

## Per-permission justifications

Chrome Web Store reviewers ask for a one-sentence reason per permission. Paste these into the submission form:

- **`downloads`** -- The extension's core function is saving audio files to the user's Downloads folder when they click Download.
- **`storage`** -- The extension remembers the user's chosen download mode (Original, Convert, or Both) via `chrome.storage.sync` so they do not have to re-pick it on every page.
- **`offscreen`** -- WAV conversion uses FFmpeg.wasm, which requires a DOM context (Web Workers, SharedArrayBuffer, etc.). MV3 service workers cannot host these, so the extension uses an offscreen document as a hidden DOM environment for the conversion worker. The offscreen document has no network access of its own.
- **Host access to `*.wiktionary.org`** -- The content script needs to inspect Wiktionary pages to discover audio files and render the on-page panel.
- **Host access to `*.wikimedia.org`** -- Audio files referenced on Wiktionary pages are served from `upload.wikimedia.org` (a Wikimedia subdomain). The extension fetches them from there for both Original and Convert modes.

## Single-purpose statement

> This extension has one purpose: downloading pronunciation audio from Wiktionary entries, with an optional local WAV conversion for compatibility with general-purpose audio tools.

## Screenshots to capture

Before submission, take these screenshots at 1280x800 (or 640x400):

1. **The on-page panel** on a popular entry such as `en.wiktionary.org/wiki/water`, with multiple audio items visible.
2. **The popup** showing the three radio modes.
3. **A batch download in progress** (the panel showing `3/5 Downloaded` or similar feedback) -- optional.

To capture cleanly:
- Use Chrome at 100% zoom.
- Use a 1280x800 window (resize Chrome to that size).
- Avoid distracting browser-chrome elements: hide bookmarks bar, etc.
- Save as PNG.

## Where to host the privacy policy

The submission form asks for a public URL. Options:

1. Push to `main` and link to `https://github.com/jhnwnstd/wiktionary-audio-extension-chrome/blob/main/PRIVACY.md` -- GitHub renders Markdown directly.
2. Enable GitHub Pages and link to `https://jhnwnstd.github.io/wiktionary-audio-extension-chrome/PRIVACY` -- slightly nicer URL but requires Pages setup.

The first option is sufficient.

## After submission

Google's review for a small, open-source, narrowly-scoped extension is typically 1-3 business days. If they flag anything, it usually comes back as a specific request (rewording a permission justification, more detail on data handling, etc.). Source-code review is automated unless something looks unusual.
