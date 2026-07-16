// Offline demo phrasebook.
//
// The live translation provider (MyMemory) needs outbound network access. In a
// locked-down environment that host may be blocked by egress policy, so this
// small, hand-checked phrasebook lets the demo still show real translation for
// a handful of common conversational phrases. It is a *fallback*, not the main
// engine — anything not listed here goes to the live provider when reachable.
//
// Keyed by normalized (lowercased, punctuation-stripped) source phrase.

const PHRASES = [
  { en: 'hello',            zh: '你好',        es: 'hola',          fr: 'bonjour',      de: 'hallo',        ja: 'こんにちは' },
  { en: 'hi',               zh: '嗨',          es: 'hola',          fr: 'salut',        de: 'hi',           ja: 'やあ' },
  { en: 'good morning',     zh: '早上好',      es: 'buenos días',   fr: 'bonjour',      de: 'guten morgen', ja: 'おはようございます' },
  { en: 'good night',       zh: '晚安',        es: 'buenas noches', fr: 'bonne nuit',   de: 'gute nacht',   ja: 'おやすみなさい' },
  { en: 'goodbye',          zh: '再见',        es: 'adiós',         fr: 'au revoir',    de: 'auf wiedersehen', ja: 'さようなら' },
  { en: 'thank you',        zh: '谢谢',        es: 'gracias',       fr: 'merci',        de: 'danke',        ja: 'ありがとう' },
  { en: 'thanks',           zh: '谢谢',        es: 'gracias',       fr: 'merci',        de: 'danke',        ja: 'ありがとう' },
  { en: 'you are welcome',  zh: '不客气',      es: 'de nada',       fr: 'de rien',      de: 'bitte',        ja: 'どういたしまして' },
  { en: 'yes',              zh: '是的',        es: 'sí',            fr: 'oui',          de: 'ja',           ja: 'はい' },
  { en: 'no',               zh: '不',          es: 'no',            fr: 'non',          de: 'nein',         ja: 'いいえ' },
  { en: 'please',           zh: '请',          es: 'por favor',     fr: 's’il vous plaît', de: 'bitte',     ja: 'お願いします' },
  { en: 'how are you',      zh: '你好吗',      es: '¿cómo estás?',  fr: 'comment ça va', de: 'wie geht es dir', ja: '元気ですか' },
  { en: 'i am fine',        zh: '我很好',      es: 'estoy bien',    fr: 'je vais bien', de: 'mir geht es gut', ja: '元気です' },
  { en: 'nice to meet you', zh: '很高兴认识你', es: 'mucho gusto',  fr: 'enchanté',     de: 'freut mich',   ja: 'はじめまして' },
  { en: 'what is your name', zh: '你叫什么名字', es: '¿cómo te llamas?', fr: 'comment tu t’appelles', de: 'wie heißt du', ja: 'お名前は' },
  { en: 'i love you',       zh: '我爱你',      es: 'te quiero',     fr: 'je t’aime',    de: 'ich liebe dich', ja: '愛してる' },
  { en: 'excuse me',        zh: '打扰一下',    es: 'disculpe',      fr: 'excusez-moi',  de: 'entschuldigung', ja: 'すみません' },
  { en: 'sorry',            zh: '对不起',      es: 'lo siento',     fr: 'désolé',       de: 'entschuldigung', ja: 'ごめんなさい' },
  { en: 'welcome',          zh: '欢迎',        es: 'bienvenido',    fr: 'bienvenue',    de: 'willkommen',   ja: 'ようこそ' },
  { en: 'let us begin',     zh: '让我们开始吧', es: 'empecemos',    fr: 'commençons',   de: 'fangen wir an', ja: '始めましょう' },
];

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .trim()
    .replace(/[.!?¿¡,。！？、]/g, '')
    .replace(/\s+/g, ' ');
}

// Build a lookup: for every language a phrase appears in, map its normalized
// form to the whole row, so we can translate from any listed language.
const INDEX = new Map(); // `${lang}|${normalizedText}` -> row
for (const row of PHRASES) {
  for (const [lang, text] of Object.entries(row)) {
    INDEX.set(`${lang}|${normalize(text)}`, row);
  }
}

/**
 * Look up an offline translation.
 * @returns {string|null} translated text, or null if not in the phrasebook.
 */
export function offlineTranslate(text, from, to) {
  const row = INDEX.get(`${from}|${normalize(text)}`);
  if (row && row[to]) return row[to];
  return null;
}
