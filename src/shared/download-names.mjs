// What the two download modes name their output. Pure: no chrome.* or DOM.
//
// Both names are derived from the same clamped filename, so the collision
// test is provably identical on each side: Original and Convert land on one
// name exactly when the clamped source is already a .wav, and Chrome would
// then save the second as "... (1).wav" with nothing to say which file is
// which. That is not a rare case. LinguaLibre records in WAV, so every LL-Q*
// item on a Wiktionary entry hits it, and for a Praat-oriented tool the
// ambiguity is the damaging kind: you cannot tell the lossy source from the
// standardized conversion.
//
// Any other source keeps its plain name. Its own extension already
// distinguishes it from the .wav conversion, so there is nothing to
// disambiguate and no reason to churn the names users already have.

import { AUDIO_EXT_RE } from './audio-info.mjs';

const WAV_EXT_RE = /\.wav$/i;
const TRAILING_EXT_RE = /\.[^.]+$/;

/**
 * Clamp a filename's trailing extension to an audio type. If the trailing
 * extension already matches AUDIO_EXT_RE it is returned unchanged; otherwise
 * any non-audio extension is stripped and `.ogg` (Wikimedia's legacy default)
 * appended. Defense in depth, so an upstream mediatype misclassification
 * can't round-trip a deceptive extension to the user's disk.
 * @param {unknown} filename
 * @returns {string}
 */
export function ensureAudioExtension(filename) {
  if (typeof filename !== 'string' || !filename) return 'audio.ogg';
  if (AUDIO_EXT_RE.test(filename)) return filename;
  const stripped = filename.replace(/\.[a-z0-9]+$/i, '');
  return (stripped || 'audio') + '.ogg';
}

/**
 * Filename for an Original-mode download.
 * @param {unknown} filename  source filename, e.g. `english_water_Speaker.wav`
 * @returns {string}
 */
export function originalDownloadName(filename) {
  const clamped = ensureAudioExtension(filename);
  return WAV_EXT_RE.test(clamped) ? clamped.replace(WAV_EXT_RE, '_raw.wav') : clamped;
}

/**
 * Base name, without extension, handed to offscreen for a Convert-mode
 * download; offscreen appends `.wav`. Shared by the click path and the
 * speculative transcode: they key the transcode cache by URL, so a name
 * computed two different ways would serve a click the wrong filename.
 * @param {unknown} filename  source filename
 * @returns {string}
 */
export function convertedBaseName(filename) {
  const clamped = ensureAudioExtension(filename);
  const stem = clamped.replace(TRAILING_EXT_RE, '');
  return WAV_EXT_RE.test(clamped) ? `${stem}_48k-mono` : stem;
}
