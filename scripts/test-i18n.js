#!/usr/bin/env node
'use strict';
/*
 * 介面翻譯覆蓋測試：把 index.html 的 I18N 表抽出來，逐語言比對 key 與殘留中文。
 *   node scripts/test-i18n.js
 */
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');

const start = html.indexOf('var I18N = {');
if (start < 0) throw new Error('找不到 I18N');
// 找對應的結尾：從 I18N 起算的括號平衡
let i = html.indexOf('{', start), depth = 0, end = -1;
for (; i < html.length; i++) {
  const c = html[i];
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const literal = html.slice(html.indexOf('{', start), end);
const I18N = new Function('return ' + literal)();

// runtime 會把 EXTRA 併進 I18N，測試也要照做，否則會誤判成缺 key
const exStart = html.indexOf('var EXTRA = {');
if (exStart > 0) {
  let j = html.indexOf('{', exStart), d2 = 0, e2 = -1;
  for (; j < html.length; j++) { if (html[j] === '{') d2++; else if (html[j] === '}') { d2--; if (!d2) { e2 = j + 1; break; } } }
  const EXTRA = new Function('return ' + html.slice(html.indexOf('{', exStart), e2))();
  for (const L in EXTRA) { if (!I18N[L]) continue; for (const K in EXTRA[L]) if (I18N[L][K] === undefined) I18N[L][K] = EXTRA[L][K]; }
}

const LANGS = Object.keys(I18N);
const BASE = 'zh-Hant';
const baseKeys = Object.keys(I18N[BASE]);

// 程式碼裡實際用到的 key：t('x') 與 t("x")
const used = new Set();
const tRe = /\bt\(\s*['"]([A-Za-z0-9_]+)['"]/g;
let m;
while ((m = tRe.exec(html))) used.add(m[1]);
// 以 id="t-xxx" 對應的 key（標題、副標等）
const idRe = /id="t-([A-Za-z0-9_]+)"/g;
while ((m = idRe.exec(html))) used.add(m[1]);

const CJK = /[\u4e00-\u9fff]/;
const report = { langs: [], missing: {}, fallbackToEnglish: {}, sameAsBase: {}, cjkLeft: {}, ok: true };

for (const lang of LANGS) {
  const d = I18N[lang];
  const keys = Object.keys(d);
  const missing = baseKeys.filter(k => d[k] === undefined);
  const same = baseKeys.filter(k => lang !== 'zh-Hans' && lang !== BASE && typeof d[k] === 'string' && d[k] === I18N[BASE][k]);
  const cjk = keys.filter(k => typeof d[k] === 'string' && CJK.test(d[k]) && lang !== BASE && lang !== 'zh-Hans' && lang !== 'ja');
  report.langs.push({ lang, keys: keys.length, missing: missing.length, sameAsBase: same.length, cjkValues: cjk.length });
  if (missing.length) report.missing[lang] = missing;
  if (same.length) report.sameAsBase[lang] = same;
  if (cjk.length) report.cjkLeft[lang] = cjk;
  if (missing.length || cjk.length) report.ok = false;
}

// 程式碼用到但字典裡沒有的 key（會直接顯示 key 本身）
// mtNote 由 MTNOTE 提供（9 語，中文兩語不需要）
const mtNoteLangs = (html.match(/var MTNOTE = \{([\s\S]*?)\};/) || [,''])[1].match(/'?[a-zA-Z-]+'?:/g) || [];
const orphan = [...used].filter(k => !baseKeys.includes(k) && !Object.keys(I18N.en).includes(k) && k !== 'mtNote');

console.log('語言數：', LANGS.length, '｜基準 key 數：', baseKeys.length, '｜程式碼用到 key：', used.size);
report.langs.forEach(l => console.log(`  ${l.lang.padEnd(8)} keys=${String(l.keys).padStart(3)} 缺=${l.missing} 同基準=${l.sameAsBase} 殘留中文=${l.cjkValues}`));
if (orphan.length) { console.log('字典缺的 key（會顯示原文 key）：', orphan.join(', ')); report.ok = false; }
if (Object.keys(report.missing).length) console.log('缺 key：', JSON.stringify(report.missing, null, 1));
if (Object.keys(report.cjkLeft).length) console.log('殘留中文：', JSON.stringify(report.cjkLeft, null, 1));
console.log(report.ok ? '結論：介面 11 語全數覆蓋，無缺 key、無殘留中文。' : '結論：有缺口，見上。');

fs.writeFileSync(path.resolve(__dirname, '..', 'data', 'i18n-coverage.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), languages: LANGS.length, baseKeys: baseKeys.length, usedKeys: used.size, orphan, ...report
}, null, 1));
