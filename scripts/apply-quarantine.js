#!/usr/bin/env node
'use strict';
/* 把掃描結果寫回榜單：高風險項目標 quarantined，並輸出隔離清單。
 *   node scripts/apply-quarantine.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const R = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'risk-report.json'), 'utf8'));
const BOTSF = path.join(ROOT, 'data', 'bots.json');
const B = JSON.parse(fs.readFileSync(BOTSF, 'utf8'));

const ACTION = { 'discord-mass-DM-GO': 'remove', 'danghuangshang': 'hold' };
const list = [];
for (const it of B.items) {
  const r = (R.items || []).filter(x => x.id === it.id)[0];
  delete it.quarantined; delete it.riskLevel;
  if (!r) continue;
  it.riskLevel = r.level;
  if (r.level === 'high') {
    it.quarantined = true;
    const reasons = (r.hits || []).filter(h => h.sev === 'high').slice(0, 3).map(h => `${h.name}（${h.file}:${h.line}）`);
    list.push({ id: it.id, name: it.name, platform: it.platform, url: it.url, reasons, action: ACTION[it.name] || 'hold' });
  }
}
B.note = (B.note || '') ;
B.counts = B.counts || {};
fs.writeFileSync(BOTSF, JSON.stringify(B, null, 1));
fs.writeFileSync(path.join(ROOT, 'data', 'risk-quarantine.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  total: list.length,
  policy: '高風險項目預設從榜單隱藏（隔離），不刪資料；確認後可從 data/bots.json 移除該筆，或把 quarantined 改回 false。',
  items: list
}, null, 1));
console.log('隔離', list.length, '筆：', list.map(x => x.name + ' → ' + x.action).join('、'));
