#!/usr/bin/env node
'use strict';
/*
 * Bot 榜單收集器：把多個來源的 bot 拉回來、算綜合分、寫成 data/bots.json
 * 來源：
 *   github    GitHub 搜尋（stars 為主）
 *   discord   discord.bots.gg 公開 API（1,281 個，guildCount 為主）
 *   telegram  telegram-store 目錄 JSON-LD（7,074 個，依目錄排序）
 *   curated   人工核對過的榜單數字（top.gg 評分 / Telegram 實測分數）
 * 用法：node scripts/collect-bots.js
 *   env：GH_TOPICS  GH_PER_PAGE  DISCORD_LIMIT  TG_LIMIT
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'bots.json');
const SEED = path.join(ROOT, 'data', 'bots-seed.json');

const DISCORD_LIMIT = Number(process.env.DISCORD_LIMIT || 300);
const TG_LIMIT = Number(process.env.TG_LIMIT || 400);
const GH_PER_PAGE = Number(process.env.GH_PER_PAGE || 25);

const GH_QUERIES = [
  { q: 'topic:discord-bot', platform: 'Discord', category: '社群工具' },
  { q: '"discord bot" in:name,description stars:>300', platform: 'Discord', category: '社群工具' },
  { q: 'topic:telegram-bot', platform: 'Telegram', category: 'AI 助手' },
  { q: '"telegram bot" in:name,description stars:>200', platform: 'Telegram', category: '工具效率' },
  { q: 'topic:qqbot', platform: 'QQ', category: '社群工具' },
  { q: 'topic:chatbot stars:>1000', platform: '多平台', category: 'AI 助手' },
  { q: 'topic:ai-agent stars:>800', platform: '多平台', category: 'AI 助手' },
  { q: 'topic:trading-bot stars:>500', platform: '多平台', category: '交易金融' }
];

const UA = { 'User-Agent': 'skill-hub-bot-board/1.0', Accept: 'application/json' };
const log = (...a) => console.log(...a);
const num = v => (Number.isFinite(+v) ? +v : 0);
const lg = (x, cap) => Math.max(0, Math.min(1, Math.log10(1 + x) / Math.log10(1 + cap)));
const daysAgo = iso => (iso ? Math.max(0, (Date.now() - Date.parse(iso)) / 86400000) : 9999);

function curlRaw(args) {
  const { execFileSync } = require('child_process');
  return execFileSync('curl', ['-sS', '-L', '--http1.1', '-m', '30', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

async function getJSON(url) {
  const hdr = [];
  for (const k in UA) hdr.push('-H', k + ': ' + UA[k]);
  if (process.env.GH_TOKEN && url.includes('api.github.com')) hdr.push('-H', 'Authorization: Bearer ' + process.env.GH_TOKEN);
  const txt = curlRaw([...hdr, url]);
  try { return JSON.parse(txt); } catch (e) { throw new Error('非 JSON 回應：' + txt.slice(0, 120)); }
}

/* ---------- GitHub ---------- */
async function fromGithub() {
  const out = [];
  for (const item of GH_QUERIES) {
    const url = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(item.q) +
      '&sort=stars&order=desc&per_page=' + GH_PER_PAGE;
    try {
      const j = await getJSON(url);
      for (const r of j.items || []) {
        const stars = num(r.stargazers_count);
        const fresh = daysAgo(r.pushed_at) < 60 ? 1 : 0;
        out.push({
          id: 'gh:' + r.full_name,
          name: r.name,
          platform: item.platform,
          category: item.category,
          source: 'github',
          desc: (r.description || '').slice(0, 180),
          stars,
          users: 0,
          author: r.owner ? r.owner.login : '',
          url: r.html_url,
          verified: false,
          lang: r.language || '',
          updatedAt: r.pushed_at,
          tags: (r.topics || []).slice(0, 5),
          score: Math.round((62 * lg(stars, 150000) + 14 * fresh + 8 * (stars > 3000 ? 1 : 0) + 6 * (stars > 15000 ? 1 : 0)) * 10) / 10
        });
      }
      log(`  github ${item.q} → ${(j.items || []).length}`);
    } catch (e) { log('  github 失敗：' + e.message); }
    await new Promise(r => setTimeout(r, 3000)); // 尊重匿名搜尋限流
  }
  return out;
}

/* ---------- Discord (discord.bots.gg) ---------- */
async function fromDiscord() {
  const out = [];
  for (let page = 0; page < 4; page++) {
    try {
      const j = await getJSON(`https://discord.bots.gg/api/v1/bots?limit=100&page=${page}`);
      for (const b of j.bots || []) {
        const guilds = num(b.guildCount);
        const fresh = daysAgo(b.lastOnlineChange) < 7 ? 1 : 0;
        out.push({
          id: 'dc:' + b.clientId,
          name: b.globalName || b.username,
          platform: 'Discord',
          category: (b.guildCount > 50000 ? '社群工具' : '社群工具'),
          source: 'discord',
          desc: (b.shortDescription || '').slice(0, 180),
          users: guilds,
          stars: 0,
          author: b.owner ? b.owner.username : '',
          url: b.website || ('https://discord.com/application-directory/' + b.clientId),
          verified: !!b.verified,
          online: b.status === 'online',
          sourceRepo: b.openSource || '',
          updatedAt: b.lastOnlineChange,
          score: Math.round((55 * lg(guilds, 80000) + 13 * (b.verified ? 1 : 0) + 9 * fresh + 8 * (b.status === 'online' ? 1 : 0)) * 10) / 10
        });
      }
      if ((j.bots || []).length < 100) break;
    } catch (e) { log('  discord 失敗：' + e.message); break; }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, DISCORD_LIMIT);
}

/* ---------- Telegram (telegram-store 目錄 JSON-LD，分頁抓) ---------- */
function curlText(url) {
  return curlRaw(['-A', 'Mozilla/5.0 (compatible; bot-board/1.0)', url]);
}

const TG_PAGES = Number(process.env.TG_PAGES || 8);

async function fromTelegram() {
  const out = [];
  let pos = 1;
  for (let page = 1; page <= TG_PAGES; page++) {
    try {
      const html = curlText('https://telegram-store.com/catalog/bots?page=' + page);
      const blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
      let list = null;
      for (const block of blocks) {
        try {
          const j = JSON.parse(block.replace(/<\/?script[^>]*>/g, ''));
          const cand = j && j.mainEntity && j.mainEntity.itemListElement;
          if (Array.isArray(cand) && cand.length > 10) { list = cand; break; }
        } catch (e) {}
      }
      if (!list) { log('  telegram page ' + page + ' 無清單'); break; }
      for (const it of list) {
        const slug = (it.url || '').split('/').pop();
        out.push({
          id: 'tg:' + slug,
          name: it.name,
          platform: 'Telegram',
          category: '工具效率',
          source: 'telegram',
          desc: '',
          users: 0,
          stars: 0,
          author: '',
          url: it.url,
          verified: false,
          rankInSource: pos,
          updatedAt: null,
          score: Math.round((56 - 38 * Math.pow(Math.min(1, (pos - 1) / 640), 0.45)) * 10) / 10
        });
        pos++;
      }
      log(`  telegram 第 ${page} 頁 → 累計 ${out.length}`);
    } catch (e) { log('  telegram page ' + page + ' 失敗：' + e.message); break; }
  }
  return out.slice(0, TG_LIMIT);
}

/* ---------- 人工核對榜單 ---------- */
function fromSeed() {
  if (!fs.existsSync(SEED)) return [];
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  return (seed.items || []).map((b, i) => ({
    id: 'cur:' + (b.handle || b.name).replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() || ('x' + i),
    name: b.name,
    platform: b.platform,
    category: b.category,
    source: 'curated',
    desc: b.desc || '',
    users: num(b.users),
    stars: 0,
    rating: b.rating || 0,
    author: b.handle || '',
    url: b.url,
    verified: !!b.verified,
    updatedAt: null,
    score: num(b.score)
  }));
}

(async function main() {
  log('收集 Bot 榜單…');
  const [gh, dc, tg] = [await fromGithub(), await fromDiscord(), await fromTelegram()];
  const curated = fromSeed();

  const all = [...curated, ...gh, ...dc, ...tg];
  const seen = new Set();
  const items = all.filter(x => {
    const k = (x.name || '').toLowerCase().trim() + '|' + x.platform;
    if (!x.name || seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((a, b) => b.score - a.score);

  const counts = items.reduce((m, x) => { m[x.source] = (m[x.source] || 0) + 1; return m; }, {});
  const doc = {
    generatedAt: new Date().toISOString(),
    source: 'bot-board',
    counts,
    total: items.length,
    note: '分數為跨來源可比的 0–100 綜合分：人數/星數取對數、加上驗證與近期活躍；不同來源的原始指標口徑不同，已在欄位標明。',
    items
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc));
  log(`完成：${items.length} 筆（${JSON.stringify(counts)}）→ ${path.relative(ROOT, OUT)}`);
})().catch(e => { console.error(e); process.exit(1); });
