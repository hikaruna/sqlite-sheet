// 画面の言語（日本語・英語）。日本語の文をそのままキーにして、英語のときだけ辞書（locales/en.js）で引く。
// 差し込みは {0} {1} …（t('「{0}」を開く', [name])）。英語の訳は文字列か、単数・複数などを扱う関数 (p) => '…'
import en from './locales/en.js';

const KEY = 'lang';
export const LANGS = { ja: '日本語', en: 'English' };

/** 今の言語。選んだものがあればそれ、なければ端末の言語（日本語以外は英語） */
export const lang = (() => {
  try { const v = localStorage.getItem(KEY); if (v in LANGS) return v; } catch { /* 無視 */ }
  return /^ja\b/i.test(navigator.language || '') ? 'ja' : 'en';
})();
document.documentElement.lang = lang;

const missing = new Set();

/** 文を今の言語にする。params は差し込む値の配列 */
export function t(s, params) {
  let out = s;
  if (lang === 'en') {
    const v = en[s];
    if (v == null) { if (!missing.has(s)) { missing.add(s); console.debug('[i18n] 英訳がありません:', s); } }
    else out = typeof v === 'function' ? v(params || []) : v;
  }
  if (params && typeof out === 'string') out = out.replace(/\{(\d+)\}/g, (m, i) => (i in params ? String(params[i]) : m));
  return out;
}

/** 言語を切り替える（画面を作り直すため、ページを読み込み直す） */
export function setLang(l) {
  try { localStorage.setItem(KEY, l); } catch { /* 無視 */ }
  location.reload();
}

/** 日付・数の書式に使う言語の名前 */
export const locale = lang === 'ja' ? 'ja-JP' : 'en-US';
