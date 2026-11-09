#!/usr/bin/env node
'use strict';
/*
 * 內容翻譯：把 data/skills.json 的 name / summary 翻成多語言，
 * 輸出 data/i18n/<lang>.json（前端會自動讀取，語言一換就顯示譯文）。
 *
 * 用法（挑一種 provider）：
 *   TRANSLATE_PROVIDER=deepl  TRANSLATE_KEY=xxxx:fx           LANGS=en,ja node scripts/translate.js
 *   TRANSLATE_PROVIDER=google TRANSLATE_KEY=xxxx              LANGS=en,ja node scripts/translate.js
 *   TRANSLATE_PROVIDER=azure  TRANSLATE_KEY=xxxx TRANSLATE_REGION=eastasia node scripts/translate.js
 *   TRANSLATE_PROVIDER=openai TRANSLATE_KEY=sk-xxx TRANSLATE_BASE=https://api.openai.com/v1 TRANSLATE_MODEL=gpt-4o-mini
 *   TRANSLATE_PROVIDER=libre  TRANSLATE_BASE=https://libretranslate.example.com
 *
 * 可中斷續跑：已翻過的條目會沿用既有檔案，只補缺的。
 * FIELDS 可設 name,summary（預設只翻 summary，名稱多為安裝識別碼，建議保留原文）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IN = path.join(ROOT, 'data', 'skills.json');
const OUT_DIR = path.join(ROOT, 'data', 'i18n');

const PROVIDER = (process.env.TRANSLATE_PROVIDER || '').toLowerCase();
const KEY = process.env.TRANSLATE_KEY || '';
const BASE = process.env.TRANSLATE_BASE || '';
const REGION = process.env.TRANSLATE_REGION || '';
const MODEL = process.env.TRANSLATE_MODEL || 'gpt-4o-mini';
const LANGS = (process.env.LANGS || 'en,ja,ko,es,de,fr,pt,ru,ar').split(',').map(s => s.trim()).filter(Boolean);
const FIELDS = (process.env.FIELDS || 'summary').split(',').map(s => s.trim()).filter(Boolean);
const BATCH = Number(process.env.BATCH || 20);
const CONC = Number(process.env.CONC || 3);

const LANG_NAME = {
  en: 'English', ja: 'Japanese', ko: 'Korean', es: 'Spanish', de: 'German',
  fr: 'French', pt: 'Portuguese', ru: 'Russian', ar: 'Arabic',
  'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese'
};

function langCode(p, lang) {
  if (p === 'google' || p === 'libre' || p === 'openai') return lang;
  if (p === 'deepl') return { en: 'EN-US', ja: 'JA', ko: 'KO', es: 'ES', de: 'DE', fr: 'FR', pt: 'PT-BR', ru: 'RU', ar: 'AR', 'zh-Hans': 'ZH', 'zh-Hant': 'ZH-HANT' }[lang] || lang.toUpperCase();
  if (p === 'azure') return { 'zh-Hans': 'zh-Hans', 'zh-Hant': 'zh-Hant' }[lang] || lang;
  return lang;
}

async function post(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

/* 回傳：與輸入等長的字串陣列（失敗則丟錯） */
async function translateBatch(texts, lang) {
  const code = langCode(PROVIDER, lang);
  if (PROVIDER === 'deepl') {
    const host = KEY.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const j = await post(host + '/v2/translate',
      { 'Content-Type': 'application/json', Authorization: 'DeepL-Auth-Key ' + KEY },
      { text: texts, target_lang: code });
    return j.translations.map(t => t.text);
  }
  if (PROVIDER === 'gtx') {
    // Google 翻譯的公開 endpoint（GitHub Actions runner 或一般家用網路通常可達；資料中心 IP 常被擋）
    const out = [];
    for (const t of texts) {
      let ok = false, tries = 0;
      while (!ok && tries < 3) {
        tries++;
        try {
          const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-TW&tl=' +
            encodeURIComponent(code) + '&dt=t&q=' + encodeURIComponent(t);
          const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const j = await r.json();
          const s2 = (j && j[0] ? j[0].map(x => x && x[0]).filter(Boolean).join('') : '');
          out.push(s2 || t);
          ok = true;
        } catch (e) {
          if (tries >= 3) { out.push(t); ok = true; }
          else await new Promise(res => setTimeout(res, 800 * tries));
        }
      }
    }
    return out;
  }
  if (PROVIDER === 'google') {
    const j = await post('https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(KEY),
      { 'Content-Type': 'application/json' },
      { q: texts, target: code, format: 'text' });
    return j.data.translations.map(t => t.translatedText);
  }
  if (PROVIDER === 'azure') {
    const j = await post('https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=' + code,
      { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': KEY, 'Ocp-Apim-Subscription-Region': REGION },
      texts.map(t => ({ Text: t })));
    return j.map(x => x.translations[0].text);
  }
  if (PROVIDER === 'libre') {
    const j = await post((BASE || 'https://libretranslate.com') + '/translate',
      { 'Content-Type': 'application/json' },
      { q: texts, source: 'auto', target: code, format: 'text' });
    return Array.isArray(j.translatedText) ? j.translatedText : texts;
  }
  if (PROVIDER === 'openai') {
    const sys = 'You are a professional UI localizer. Translate every input string into ' + (LANG_NAME[lang] || lang) +
      '. Keep product names, CLI commands, code and URLs untouched. Return ONLY a JSON array of the same length, no commentary.';
    const j = await post((BASE || 'https://api.openai.com/v1') + '/chat/completions',
      { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      { model: MODEL, temperature: 0, messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify(texts) }] });
    const raw = j.choices[0].message.content.trim().replace(/^```json\s*|```$/g, '');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error('openai 回傳長度不符');
    return arr.map(String);
  }
  throw new Error('未設定 TRANSLATE_PROVIDER（deepl/google/azure/openai/libre/gtx）');
}

async function pool(items, n, worker) {
  const out = [];
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return out;
}

(async function main() {
  if (!PROVIDER) { console.error('缺少 TRANSLATE_PROVIDER'); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const items = data.items || [];
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`來源 ${items.length} 筆，欄位 ${FIELDS.join('+')}，語言 ${LANGS.join(',')}，provider=${PROVIDER}`);

  for (const lang of LANGS) {
    const file = path.join(OUT_DIR, lang + '.json');
    let doc = { lang, provider: PROVIDER, generatedAt: null, items: {} };
    if (fs.existsSync(file)) { try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); doc.items = doc.items || {}; } catch (e) {} }

    // 收集待翻文字
    const jobs = [];
    for (const it of items) {
      const cur = doc.items[it.id] || {};
      for (const f of FIELDS) {
        const src = (it[f] || '').trim();
        if (!src) continue;
        if (cur[f]) continue;                       // 已翻過
        jobs.push({ id: it.id, field: f, text: src });
      }
    }
    console.log(`[${lang}] 待翻 ${jobs.length} 段 / 既有 ${Object.keys(doc.items).length} 筆`);
    for (let s = 0; s < jobs.length; s += BATCH) {
      const slice = jobs.slice(s, s + BATCH);
      try {
        const res = await translateBatch(slice.map(j => j.text), lang);
        slice.forEach((j, k) => {
          const rec = doc.items[j.id] || (doc.items[j.id] = {});
          rec[j.field] = res[k] || j.text;
        });
      } catch (e) {
        console.error(`[${lang}] 批次失敗（跳過，可重跑續補）：${e.message}`);
      }
      process.stdout.write(`\r[${lang}] ${Math.min(s + BATCH, jobs.length)}/${jobs.length}`);
      if (s % (BATCH * 10) === 0) { doc.generatedAt = new Date().toISOString(); fs.writeFileSync(file, JSON.stringify(doc, null, 0)); }
    }
    doc.generatedAt = new Date().toISOString();
    doc.provider = PROVIDER;
    fs.writeFileSync(file, JSON.stringify(doc, null, 0));
    console.log(`\n[${lang}] 已寫入 ${path.relative(ROOT, file)}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
