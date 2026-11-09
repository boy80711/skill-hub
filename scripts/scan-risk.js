#!/usr/bin/env node
'use strict';
/*
 * 來源碼風險掃描：把榜單裡「有公開倉庫」的項目抓下來靜態掃一遍。
 *
 *   node scripts/scan-risk.js                 # 全部
 *   LIMIT=10 node scripts/scan-risk.js       # 只掃前 10 個（測試用）
 *   ONLY=gh:AstrBotDevs/AstrBot node scripts/scan-risk.js
 *
 * 產出 data/risk-report.json。只用唯讀方式（下載 tarball → 解到暫存目錄 → 正則掃），
 * 不執行任何抓回來的程式碼。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BOTS = path.join(ROOT, 'data', 'bots.json');
const OUT = path.join(ROOT, 'data', 'risk-report.json');
const TMP = path.join(ROOT, '.scan-tmp');
const LIMIT = Number(process.env.LIMIT || 0);
const ONLY = process.env.ONLY || '';
const STRIDE = Number(process.env.STRIDE || 1);
const OFFSET = Number(process.env.OFFSET || 0);
const PARTS = path.join(ROOT, '.scan-cache');
const MAX_TGZ = 40 * 1024 * 1024;   // 單一倉庫上限
const MAX_FILE = 700 * 1024;       // 單檔上限
const MAX_FILES = 900;             // 單庫掃描檔案上限

const CODES = /\.(js|mjs|cjs|ts|jsx|tsx|py|sh|bash|ps1|bat|cmd|rb|pl|php|go|java|kt|yml|yaml|json|toml|ini|cfg|dockerfile|env|txt)$/i;
const SCRIPTY = /\.(sh|bash|ps1|bat|cmd)$/i;
const PROMPTY = /\.(md|txt)$/i;
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|vendor|\.venv|venv|__pycache__|test|tests|docs\/assets|assets)\//i;

const RULES = [
  // ---- 高風險：對外抓取後直接執行 / 反彈連線 / 憑證外傳 / 破壞性刪除 / 持久化
  { id: 'R1', sev: 'high', scope: 'code', re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|;]{0,120}\|\s*(sudo\s+)?(ba|z|k)?sh\b/i, name: '遠端腳本直接餵給 shell' },
  { id: 'R2', sev: 'high', scope: 'code', re: /\/dev\/tcp\/|nc\s+(-[a-z]+\s+)*[\w.\-]+\s+(-e|--exec)|\bbash\s+-i\s+>&/i, name: '反彈 shell／反向連線' },
  { id: 'R3', sev: 'high', scope: 'code', re: /base64\s+(-d|--decode)[^\n|;]{0,60}\|\s*(ba|z)?sh|eval\s*\(\s*(Buffer\.from|atob)\s*\(|exec\s*\(\s*(base64\.b64decode|Buffer\.from)/i, name: '混淆後執行（base64 → eval/sh）' },
  { id: 'R4', sev: 'high', scope: 'code', re: /(\.ssh\/id_(rsa|ed25519|ecdsa)|\.aws\/credentials|\.npmrc|\.netrc|Library\/Keychains|login\.keychain)/i, name: '讀取 SSH／雲端憑證或金鑰庫' },
  { id: 'R5', sev: 'high', scope: 'code', re: /(webhook\.site|pipedream\.net|requestbin|ngrok\.io|burpcollaborator)/i, name: '資料外傳端點' },
  { id: 'R6', sev: 'high', scope: 'code', re: /process\.env[^\n]{0,60}(fetch|axios|https?\.request|sendBeacon)|os\.environ[^\n]{0,60}(requests\.(post|get)|urlopen)/i, name: '把環境變數往網路送出' },
  { id: 'R7', sev: 'high', scope: 'code', re: /rm\s+-rf?\s+(\/|~|\$HOME|\$\{?HOME\}?)(\s|$)/i, name: '破壞性刪除（家目錄／根目錄）' },
  { id: 'R8', sev: 'high', scope: 'code', re: /crontab\s+(-|\S+\.txt)|LaunchAgents\/|systemd\/system\/|>>\s*~?\/?\.(bashrc|zshrc|bash_profile|profile)\b/i, name: '寫入開機／排程持久化' },
  { id: 'R9', sev: 'high', scope: 'prompt', re: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions|disregard\s+(the\s+)?(system|previous)|do\s+not\s+(tell|inform|mention\s+to)\s+the\s+user|send\s+.{0,60}(api[_\s-]?key|token|credential|password)/i, name: '提示注入：要模型忽略規則或偷偷外傳' },
  { id: 'R10', sev: 'med', scope: 'code', re: /\b(sudo\s+)?chmod\s+(777|-R\s+777)|\bchown\s+-R\s+root/i, name: '權限放寬到任何人可寫' },

  // ---- 中風險：安裝期連網、遙測、命令注入面、過寬權限
  { id: 'M1', sev: 'med', scope: 'code', re: /"postinstall"\s*:\s*"[^"]{0,120}(curl|wget|node\s+-e|powershell)/i, name: '安裝即連網執行（postinstall）' },
  { id: 'M2', sev: 'med', scope: 'code', re: /(child_process|subprocess|os\.system|execSync|spawn)\s*\([^)\n]{0,80}(\+|`|\$\{|\$\(|f"|format\()/i, name: '把外部輸入拼進系統指令' },
  { id: 'M3', sev: 'med', scope: 'code', re: /(google-analytics|googletagmanager|mixpanel|segment\.io|posthog|sentry\.io)/i, name: '遙測／追蹤上報' },
  { id: 'M4', sev: 'med', scope: 'code', re: /pip\s+install\s+git\+http|npm\s+i\s+(git\+)?https?:\/\/|gem\s+install\s+https?:/i, name: '直接從網路位址安裝依賴' },
  { id: 'M5', sev: 'med', scope: 'code', re: /(Administrator|admin|root)\s*(權限|privilege|rights)|runas\s+\/user:|Start-Process\s+-Verb\s+RunAs/i, name: '要求提權執行' },
  { id: 'M6', sev: 'med', scope: 'prompt', re: /(\.env|環境變數|env\s*file)[^\n]{0,40}(讀|read|上傳|upload|貼|paste)|(貼上|paste)[^\n]{0,30}(\.env|token)/i, name: '提示要求讀取並外貼環境變數' },

  // ---- 低風險：需要人工看一眼的訊號
  { id: 'L1', sev: 'low', scope: 'code', re: /\beval\s*\(|\bexec\s*\(|new\s+Function\s*\(/i, name: '動態執行（eval/exec）' },
  { id: 'L2', sev: 'low', scope: 'code', re: /https?:\/\/[\w.\-]+\/(api|hook|webhook)/i, name: '對外 API／回呼位址' },
  { id: 'L3', sev: 'low', scope: 'prompt', re: /\b(system prompt|系統提示|prompt)\b[^\n]{0,40}(洩漏|leak|顯示|print|輸出)/i, name: '提示要求輸出系統提示' }
];

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

function sh(cmd, args, opts) {
  return execFileSync(cmd, args, Object.assign({ encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }, opts || {}));
}

function fetchTgz(owner, repo, dest) {
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/HEAD`;
  try {
    sh('curl', ['-sSL', '--max-time', '90', '--max-filesize', String(MAX_TGZ), '-o', dest, url]);
    return fs.existsSync(dest) && fs.statSync(dest).size > 1024;
  } catch (e) { return false; }
}

function listArchive(tgz) {
  const out = sh('tar', ['tzf', tgz]);
  return out.split('\n').filter(Boolean);
}

function extract(tgz, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  sh('tar', ['xzf', tgz, '-C', dir, '--no-same-owner']);
  return fs.readdirSync(dir)[0];
}

function walk(dir, base, acc, budget) {
  if (acc.length >= MAX_FILES) return acc;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (ent.isDirectory()) {
      if (SKIP_DIR.test('/' + rel + '/')) continue;
      walk(full, base, acc, budget);
    } else {
      if (!CODES.test(ent.name) || !(SCRIPTY.test(ent.name) || PROMPTY.test(ent.name) || CODES.test(ent.name))) continue;
      let st; try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.size > MAX_FILE) continue;
      if (budget.bytes > 30 * 1024 * 1024) continue;
      budget.bytes += st.size;
      acc.push({ full: full, rel: rel });
      if (acc.length >= MAX_FILES) return acc;
    }
  }
  return acc;
}

function tierOf(rel) {
  if (/^(\.github|\..*)\/|^\.github\//.test(rel)) return 'ci';
  if (/(^|\/)(tests?|__tests__|spec|examples?|demos?|benchmarks?|docs?|website)\//i.test(rel)) return 'dev';
  if (/\.(md|txt|mdx)$/i.test(rel)) return 'prompt';
  if (/^(Dockerfile|Makefile|package\.json|setup\.py|pyproject\.toml|install\.sh|setup\.sh)$/i.test(rel)) return 'A';
  if (/^(bin|scripts|install|setup)\//i.test(rel) && /\.(sh|bash|py|js|mjs|ps1)$/i.test(rel)) return 'A';
  if (/\.(sh|bash|ps1|bat|cmd)$/i.test(rel)) return 'A';
  return 'code';
}

const DOWN = { high: 'med', med: 'low', low: 'info' };

function scanRepo(item) {
  const m = /github\.com\/([^/]+)\/([^/#?]+)/i.exec(item.url || '');
  if (!m) return null;
  const owner = m[1], repo = m[2].replace(/\.git$/, '');
  const tag = owner + '_' + repo;
  const tgz = path.join(TMP, tag + '.tgz');
  const dir = path.join(TMP, tag);
  fs.mkdirSync(TMP, { recursive: true });
  if (!fetchTgz(owner, repo, tgz)) return { ok: false, reason: '下載失敗' };
  let root;
  try { root = extract(tgz, dir); } catch (e) { return { ok: false, reason: '解壓失敗' }; }
  const files = walk(path.join(dir, root), path.join(dir, root), [], { bytes: 0 });
  const hits = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f.full, 'utf8'); } catch (e) { continue; }
    if (!text || text.length < 1) continue;
    const lines = text.split('\n');
    for (const rule of RULES) {
      const isPromptFile = PROMPTY.test(f.rel);
      if (rule.scope === 'prompt' && !isPromptFile) continue;
      if (rule.scope === 'code' && PROMPTY.test(f.rel) && !SCRIPTY.test(f.rel)) {
        // 文件裡提到的指令只降級記錄，避免 README 範例造成誤報
        if (rule.sev === 'high' && !/```/.test(text)) continue;
      }
      if (rule.id === 'L1' && !SCRIPTY.test(f.rel) && !/\.(js|mjs|cjs|ts|py)$/i.test(f.rel)) continue;
      const tier = tierOf(f.rel);
      let ln = 0;
      for (const line of lines) {
        ln++;
        if (line.length > 400) continue;
        if (!rule.re.test(line)) continue;
        if (/^\s*(#|\/\/|\*|<!--)/.test(line) && rule.sev === 'high') continue; // 註解／說明文字不算
        if (rule.id === 'R4' && !/\b(open|read|cat|cp|scp|upload|requests\.(post|put)|axios|fetch|send)\b/i.test(line)) continue;
        if (rule.id === 'L1' && /\.eval\s*\(|model\.eval|def eval|\.exec\s*\(/.test(line)) continue;
        let sev = rule.sev;
        if (tier === 'ci' || tier === 'dev') sev = 'info';
        else if (tier === 'code') sev = DOWN[sev];
        else if (tier === 'prompt' && SCRIPTY.test(f.rel)) sev = rule.sev;
        hits.push({ rule: rule.id, name: rule.name, sev: sev, tier: tier, file: f.rel, line: ln,
                    snippet: line.trim().replace(/\s+/g, ' ').slice(0, 140) });
        break;
      }
    }
    if (PROMPTY.test(f.rel)) {
      const zw = (text.match(ZERO_WIDTH) || []).length;
      if (zw >= 8) hits.push({ rule: 'R11', name: '隱藏字元（零寬／雙向控制字）', sev: 'high', tier: 'prompt', file: f.rel, line: 1, snippet: `零寬字元 ${zw} 個` });
    }
  }
  const sevRank = { high: 3, med: 2, low: 1, info: 0 };
  const level = hits.reduce((a, h) => (sevRank[h.sev] > (sevRank[a] || 0) ? h.sev : a), 'none');
  const byRule = {};
  for (const h of hits) byRule[h.rule] = (byRule[h.rule] || 0) + 1;
  hits.sort((a, b) => (sevRank[b.sev] || 0) - (sevRank[a.sev] || 0));
  return { ok: true, owner, repo, files: files.length, hits: hits.slice(0, 40), hitCount: hits.length, level, byRule };
}

function mergeParts() {
  const files = fs.readdirSync(PARTS).filter(f => f.endsWith('.jsonl'));
  const results = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(PARTS, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { results.push(JSON.parse(line)); } catch (e) {}
    }
  }
  const data = JSON.parse(fs.readFileSync(BOTS, 'utf8'));
  const targets = data.items.filter(x => /github\.com/i.test(x.url || ''));
  const seen = {};
  const uniq = [];
  for (const r of results) { if (!seen[r.id]) { seen[r.id] = 1; uniq.push(r); } }
  // 覆核：R1「curl | bash」在專案自己的安裝腳本裡是常見寫法，降為待覆核；
  // 真正的高風險留給隱藏執行、持久化、憑證外傳、反連、破壞性刪除。
  const rank = { high: 3, med: 2, low: 1, info: 0 };
  for (const r of uniq) {
    if (!r.hits) continue;
    for (const h of r.hits) if (h.rule === 'R1' && h.sev === 'high') h.sev = 'med';
    r.level = r.hits.reduce((a, h) => (rank[h.sev] > (rank[a] || 0) ? h.sev : a), 'none');
  }
  const counts = {};
  for (const r of uniq) counts[r.level] = (counts[r.level] || 0) + 1;
  const payload = {
    generatedAt: new Date().toISOString(),
    scanned: uniq.length,
    catalogTotal: data.items.length,
    openSource: targets.length,
    counts: counts,
    note: '靜態字串掃描：只讀不執行。命中不等於惡意，需人工覆核；未命中也不等於安全。',
    items: uniq
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
  console.log('merged', uniq.length, JSON.stringify(counts));
}

function main() {
  if (process.env.MERGE === '1') return mergeParts();
  fs.mkdirSync(PARTS, { recursive: true });
  const partFile = path.join(PARTS, 'w' + OFFSET + '.jsonl');
  const data = JSON.parse(fs.readFileSync(BOTS, 'utf8'));
  const targets = data.items.filter(x => /github\.com/i.test(x.url || ''));
  let list = ONLY ? targets.filter(x => x.id === ONLY) : targets;
  if (STRIDE > 1) list = list.filter((x, i) => i % STRIDE === OFFSET);
  if (LIMIT) list = list.slice(0, LIMIT);
  const done = new Set();
  try {
    for (const f of fs.readdirSync(PARTS)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of fs.readFileSync(path.join(PARTS, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { done.add(JSON.parse(line).id); } catch (e) {}
      }
    }
  } catch (e) {}
  list = list.filter(x => !done.has(x.id));
  console.log(`worker ${OFFSET}/${STRIDE}：待掃 ${list.length} 個倉庫（已跳過 ${done.size} 筆）`);
  list.forEach((it, i) => {
    const r = scanRepo(it);
    const row = { id: it.id, name: it.name, platform: it.platform, url: it.url, score: it.score };
    if (!r) { row.level = 'skip'; row.note = '非 GitHub 倉庫'; }
    else if (!r.ok) { row.level = 'error'; row.note = r.reason; }
    else { row.level = r.level; row.files = r.files; row.hits = r.hits; row.hitCount = r.hitCount; row.byRule = r.byRule; }
    fs.appendFileSync(partFile, JSON.stringify(row) + '\n');
    console.log(`[${OFFSET}:${String(i + 1).padStart(3)}/${list.length}] ${row.level.toUpperCase()} ${it.name} (${row.hitCount || 0})`);
  });
  console.log('worker done', OFFSET);
}

main();
