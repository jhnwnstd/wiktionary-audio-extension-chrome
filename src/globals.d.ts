// Ambient type declarations so JSDoc `@ts-check` works without pulling in
// @types/chrome as a devDep. Anything beyond simple shape-checking of our
// own code uses `any` -- that's the trade-off for keeping zero build step.
// If type fidelity on the Chrome API surface ever matters, add @types/chrome.

declare const chrome: any;
declare const mw: any;

// Shape returned to the content script after a download attempt. Used by
// safeSendMessage's @returns annotation; declared ambient so every file
// shares one definition.
declare interface DownloadResponse {
  ok: boolean;
  error?: string;
}
