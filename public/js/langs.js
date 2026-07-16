// Supported languages. `code` is the translation/BCP-47 base code used for
// both MyMemory translation and the Web Speech API (which wants a locale, so
// we pair each with a sensible default `speech` locale).
export const LANGS = [
  { code: 'en', name: 'English',            native: 'English',   speech: 'en-US' },
  { code: 'zh', name: 'Chinese (Mandarin)', native: '中文',       speech: 'zh-CN' },
  { code: 'es', name: 'Spanish',            native: 'Español',   speech: 'es-ES' },
  { code: 'fr', name: 'French',             native: 'Français',  speech: 'fr-FR' },
  { code: 'de', name: 'German',             native: 'Deutsch',   speech: 'de-DE' },
  { code: 'ja', name: 'Japanese',           native: '日本語',     speech: 'ja-JP' },
  { code: 'ko', name: 'Korean',             native: '한국어',     speech: 'ko-KR' },
  { code: 'ru', name: 'Russian',            native: 'Русский',   speech: 'ru-RU' },
  { code: 'ar', name: 'Arabic',             native: 'العربية',    speech: 'ar-SA' },
  { code: 'hi', name: 'Hindi',              native: 'हिन्दी',      speech: 'hi-IN' },
  { code: 'pt', name: 'Portuguese',         native: 'Português', speech: 'pt-BR' },
  { code: 'it', name: 'Italian',            native: 'Italiano',  speech: 'it-IT' },
  { code: 'vi', name: 'Vietnamese',         native: 'Tiếng Việt', speech: 'vi-VN' },
  { code: 'th', name: 'Thai',               native: 'ไทย',        speech: 'th-TH' },
];

export const LANG_BY_CODE = Object.fromEntries(LANGS.map((l) => [l.code, l]));

export function langName(code) {
  const l = LANG_BY_CODE[code];
  return l ? `${l.name} · ${l.native}` : code;
}

export function speechLocale(code) {
  return LANG_BY_CODE[code]?.speech || code;
}

/** Populate a <select> with language <option>s. */
export function fillLangSelect(sel, { includeNone = false, selected = '' } = {}) {
  sel.innerHTML = '';
  if (includeNone) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '— None —';
    sel.appendChild(o);
  }
  for (const l of LANGS) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = `${l.name} · ${l.native}`;
    if (l.code === selected) o.selected = true;
    sel.appendChild(o);
  }
}
