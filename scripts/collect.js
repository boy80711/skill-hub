'use strict';
/**
 * GitHub Actions 用的抓取腳本：
 * 抓 CocoLoop / ClawHub / skills.sh，輸出 data/skills.json 給 GitHub Pages 靜態頁直接讀。
 * 用法：node scripts/collect.js
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'skills.json');
const COCO_PAGES = Number(process.env.COCO_PAGES || 20);
const CLAW_LIMIT = Number(process.env.CLAW_LIMIT || 300);
const SKILLSIO_KEYWORDS = (process.env.SKILLSIO_KEYWORDS ||
  'agent,code,data,design,video,writing,research,security,office,test')
  .split(',').map(s => s.trim()).filter(Boolean);
const SKILLSIO_ON = process.env.SKILLSIO_ENABLED !== '0';
const CACHE_TTL_SEC = 6 * 60 * 60;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const COUNT_RE = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmMwW万])?\s*$/;
function parseCount(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (!s || s === '-' || s === '—') return null;
  const m = s.match(COUNT_RE);
  if (!m) { const n = Number(s.replace(/[, ]/g, '')); return Number.isFinite(n) ? n : null; }
  const num = parseFloat(m[1]);
  const unit = (m[2] || '').toLowerCase();
  const mult = unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : (unit === 'w' || unit === '万') ? 1e4 : 1;
  return Math.round(num * mult);
}

function getJson(url, headers = {}, timeout = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  return fetch(url, {
    signal: ctrl.signal,
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8', ...headers },
  }).then(async res => {
    if (!res.ok) throw new Error('HTTP ' + res.status + ' @ ' + url);
    const t = await res.text();
    return JSON.parse(t);
  }).finally(() => clearTimeout(timer));
}

const clip = (s, n = 220) => {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

async function loadCoco() {
  const items = [];
  let total = null, pages = null;
  for (let p = 1; p <= COCO_PAGES; p++) {
    const r = await getJson(`https://api.cocoloop.cn/api/v1/store/skills?page=${p}&pageSize=20`,
      { Referer: 'https://hub.cocoloop.cn/' });
    if (r.code !== 0) throw new Error('CocoLoop code=' + r.code);
    const d = r.data || {};
    total = d.total != null ? d.total : total;
    pages = d.pages != null ? d.pages : pages;
    const list = d.items || [];
    if (!list.length) break;
    for (const it of list) {
      items.push({
        id: 'coco:' + it.id, source: 'coco', sourceLabel: 'CocoLoop',
        name: it.name || '(未命名)',
        summary: clip([it.subtitle, it.brief].filter(Boolean).join(' — ')),
        category: it.category || '', rating: it.security_level || '',
        stars: parseCount(it.github_stars), downloads: parseCount(it.downloads),
        author: it.author || '', url: `https://hub.cocoloop.cn/skills/${it.id}`,
        updatedAt: null,
      });
    }
    if (pages && p >= pages) break;
  }
  return {
    items,
    note: `CocoLoop 全站 ${total ? total.toLocaleString('en-US') : '?'} 筆，取前 ${items.length} 筆（介面預設即下載量降序）`,
  };
}

async function loadClaw() {
  const items = [];
  let cursor = null, guard = 0;
  do {
    const qs = new URLSearchParams({ sort: 'stars', limit: '50' });
    if (cursor) qs.set('cursor', cursor);
    const r = await getJson('https://hub.openclaw.ai/api/v1/skills?' + qs);
    for (const it of (r.items || [])) {
      const st = it.stats || {};
      items.push({
        id: 'claw:' + (it.ownerHandle || '') + '/' + (it.slug || ''),
        source: 'claw', sourceLabel: 'ClawHub',
        name: it.displayName || it.slug || '(未命名)',
        summary: clip(it.summary || it.description || ''),
        category: (it.topics || [])[0] || '', rating: '',
        stars: parseCount(st.stars), downloads: parseCount(st.downloads),
        author: it.ownerHandle || '', url: `https://hub.openclaw.ai/skills/${it.slug}`,
        updatedAt: it.updatedAt || null,
      });
    }
    cursor = r.nextCursor || null; guard++;
  } while (cursor && items.length < CLAW_LIMIT && guard < 20);
  return { items, note: `ClawHub 取星數前 ${items.length} 筆（官方介面支援 sort=stars）` };
}

async function loadSkillsIO() {
  const map = new Map();
  for (const kw of SKILLSIO_KEYWORDS) {
    try {
      const r = await getJson('https://skills.sh/api/search?q=' + encodeURIComponent(kw) + '&limit=100');
      for (const s of (r.skills || [])) {
        const id = 'skillsio:' + s.id;
        if (map.has(id)) continue;
        map.set(id, {
          id, source: 'skillsio', sourceLabel: 'skills.sh',
          name: s.name || s.skillId, summary: clip(s.source || ''),
          category: '', rating: '', stars: null, downloads: parseCount(s.installs),
          author: (s.source || '').split('/')[0] || '',
          url: `https://www.skills.sh/${s.source}/${s.skillId}`, updatedAt: null,
        });
      }
    } catch (e) { /* 單一關鍵字失敗忽略 */ }
  }
  return { items: Array.from(map.values()), note: `skills.sh 以 ${SKILLSIO_KEYWORDS.length} 組關鍵字彙整 ${map.size} 筆（僅安裝數、無星數）` };
}

(async function main() {
  const started = Date.now();
  const sources = [];
  const items = [];

  const jobs = [['coco', loadCoco], ['claw', loadClaw]]
    .concat(SKILLSIO_ON ? [['skillsio', loadSkillsIO]] : []);

  for (const [id, fn] of jobs) {
    const t0 = Date.now();
    try {
      const p = await fn();
      items.push(...p.items);
      sources.push({ id, label: p.items[0] ? p.items[0].sourceLabel : id, ok: true,
        count: p.items.length, note: p.note, error: null, ms: Date.now() - t0 });
      console.log(`[ok]   ${id}: ${p.items.length}`);
    } catch (e) {
      sources.push({ id, label: id, ok: false, count: 0, note: '', error: e.message, ms: Date.now() - t0 });
      console.log(`[fail] ${id}: ${e.message}`);
    }
  }

  if (!items.length) {
    console.error('三個來源全部失敗，保留舊快照');
    process.exit(1);
  }

  const payload = {
    ok: true,
    mode: 'snapshot',
    items,
    sources,
    total: items.length,
    returned: items.length,
    generatedAt: Date.now(),
    cacheTtlSec: CACHE_TTL_SEC,
    takenMs: Date.now() - started,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload), 'utf8');
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`寫入 ${OUT}：${items.length} 筆 / ${kb} KB / ${payload.takenMs}ms`);
})();
