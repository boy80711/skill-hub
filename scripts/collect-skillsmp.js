#!/usr/bin/env node
/**
 * 把 SkillsMP 的 API dump 併進 data/skills.json
 *
 * 為什麼要兩步：skillsmp.com 的 /api/skills 有 Cloudflare 保護，資料中心 IP 直接 403，
 * 必須先用已通過驗證的瀏覽器工作階段把 JSON 抓下來（見 README「SkillsMP 抓取」），
 * 再用這支腳本轉成站內格式。純 curl 抓不到，不要再試。
 *
 * 用法：
 *   node scripts/collect-skillsmp.js <dump.json> [--occupation <slug>] [--label 財金營運職類]
 *
 * dump.json 內容需為 { skills: [...] } 或直接是陣列；每筆需有 id / name / author / description /
 * githubUrl / stars。
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith('--'));
if (!input) {
  console.error('用法：node scripts/collect-skillsmp.js <dump.json> [--label 分類名]');
  process.exit(1);
}
const labelIdx = args.indexOf('--label');
const label = labelIdx >= 0 && args[labelIdx + 1] ? args[labelIdx + 1] : 'SkillsMP';

const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const list = Array.isArray(raw) ? raw : (raw.skills || []);
if (!list.length) { console.error('dump 裡沒有 skills'); process.exit(1); }

const out = path.join(__dirname, '..', 'data', 'skills.json');
const data = JSON.parse(fs.readFileSync(out, 'utf8'));
const existing = new Set(data.items.map(x => x.id));

let added = 0;
for (const s of list) {
  const id = 'smp:' + s.id;
  if (existing.has(id)) continue;
  data.items.push({
    id,
    source: 'smp',
    sourceLabel: 'SkillsMP',
    name: s.name || '',
    summary: s.description || '',
    category: label,
    rating: '',
    stars: s.stars || 0,
    downloads: 0,
    author: s.author || '',
    url: s.githubUrl || '',
    updatedAt: s.updatedAt ? s.updatedAt * 1000 : null
  });
  existing.add(id);
  added++;
}

fs.writeFileSync(out, JSON.stringify(data), 'utf8');
console.log(`dump ${list.length} 筆，新增 ${added} 筆，總計 ${data.items.length} 筆 → ${out}`);
