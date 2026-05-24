// UI string table. One entry per supported Wiktionary edition. Every locale
// must declare every key; the unit test for `i18n` cross-checks that the
// `en` keys exist in every other locale so a new key can't silently fall
// back to undefined in the UI.
//
// Loaded by the content-script bundle (browser) and by Node unit tests.
// All accessors are pure functions of the supplied hostname so this module
// has no runtime dependency on `location`, `chrome`, or DOM.

export const i18n = {
  en: {
    downloadButton: 'Download',
    downloadAllButton: 'Download All',
    audioFiles: 'Audio Files',
    downloaded: 'Downloaded',
    failed: 'Failed',
    preparingConverter: 'Converting...',
    extensionReloaded: 'Extension Reloaded',
    refreshMessage: 'Please refresh this page to continue using Wiktionary Audio Downloader.',
    refreshButton: 'Refresh'
  },
  de: {
    downloadButton: 'Download',
    downloadAllButton: 'Alle herunterladen',
    audioFiles: 'Audiodateien',
    downloaded: 'Heruntergeladen',
    failed: 'Fehlgeschlagen',
    preparingConverter: 'Konvertiere...',
    extensionReloaded: 'Extension neu geladen',
    refreshMessage: 'Bitte aktualisiere diese Seite, um Wiktionary Audio Downloader weiter zu verwenden.',
    refreshButton: 'Aktualisieren'
  },
  fr: {
    downloadButton: 'Télécharger',
    downloadAllButton: 'Tout télécharger',
    audioFiles: 'Fichiers audio',
    downloaded: 'Téléchargé',
    failed: 'Échec',
    preparingConverter: 'Conversion...',
    extensionReloaded: 'Extension rechargée',
    refreshMessage: 'Veuillez actualiser cette page pour continuer à utiliser Wiktionary Audio Downloader.',
    refreshButton: 'Actualiser'
  },
  es: {
    downloadButton: 'Descargar',
    downloadAllButton: 'Descargar todo',
    audioFiles: 'Archivos de audio',
    downloaded: 'Descargado',
    failed: 'Falló',
    preparingConverter: 'Convirtiendo...',
    extensionReloaded: 'Extensión recargada',
    refreshMessage: 'Por favor actualiza esta página para continuar usando Wiktionary Audio Downloader.',
    refreshButton: 'Actualizar'
  },
  it: {
    downloadButton: 'Scarica',
    downloadAllButton: 'Scarica tutto',
    audioFiles: 'File audio',
    downloaded: 'Scaricato',
    failed: 'Fallito',
    preparingConverter: 'Conversione...',
    extensionReloaded: 'Estensione ricaricata',
    refreshMessage: 'Si prega di aggiornare questa pagina per continuare a utilizzare Wiktionary Audio Downloader.',
    refreshButton: 'Aggiorna'
  },
  ja: {
    downloadButton: 'ダウンロード',
    downloadAllButton: 'すべてダウンロード',
    audioFiles: '音声ファイル',
    downloaded: 'ダウンロード済み',
    failed: '失敗',
    preparingConverter: '変換中...',
    extensionReloaded: '拡張機能が再読み込みされました',
    refreshMessage: 'Wiktionary Audio Downloaderを続けて使用するには、このページを更新してください。',
    refreshButton: '更新'
  },
  zh: {
    downloadButton: '下载',
    downloadAllButton: '下载全部',
    audioFiles: '音频文件',
    downloaded: '已下载',
    failed: '失败',
    preparingConverter: '转换中...',
    extensionReloaded: '扩展已重新加载',
    refreshMessage: '请刷新此页面以继续使用Wiktionary Audio Downloader。',
    refreshButton: '刷新'
  }
};

/**
 * Pick a locale code from a Wiktionary hostname. Falls back to `en` for
 * non-Wiktionary hosts or for editions we don't ship translations for.
 * @param {string | null | undefined} hostname
 * @returns {string}
 */
export function pickLocale(hostname) {
  if (typeof hostname !== 'string') return 'en';
  const match = hostname.match(/^([a-z]{2,3})\.wiktionary\.org$/);
  const lang = match?.[1] || 'en';
  return i18n[lang] ? lang : 'en';
}

/**
 * Return the translation table for the given hostname.
 * @param {string | null | undefined} hostname
 */
export function translations(hostname) {
  return i18n[pickLocale(hostname)];
}

// Convenience: pre-resolved `t` for the current page when imported in a
// browser context. Falls back to English in Node/SW where `location` is
// absent or empty (tests, future SW usage). Importers that want the
// page-specific translations should keep using this; importers in any
// context where `location` may not match a Wiktionary host should call
// `translations(hostname)` explicitly.
const hostname = typeof location !== 'undefined' && location?.hostname ? location.hostname : '';
export const t = translations(hostname);
