#!/usr/bin/env node
'use strict';
/*
 * Bot 聚合分析 + 模型適配分類。
 *   node scripts/analyze-bots.js
 * 讀 data/bots.json → 產出 data/bots-analysis.json（前端同一頁渲染）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'bots.json');
const OUT = path.join(ROOT, 'data', 'bots-analysis.json');

// 用途 → 建議模型。順序即優先序，先命中者為準。
const FIT = [
  {
    key: 'framework', label: '開源框架（可自架）',
    re: /astrbot|nanobot|kirara|agentscope|botpy|nonebot|koishi|框架|framework|self-?host|自架/i,
    needLLM: true,
    models: ['自選：OpenAI / Claude / Gemini', '本地：Ollama（Llama 3 / Qwen 3）'],
    why: '框架本身不帶模型，你接誰就是誰。想零成本、資料不出門就接本地模型；追效果就接雲端 API。',
    cost: '低（本地）～中（雲端 API）'
  },
  {
    key: 'roleplay', label: '角色扮演／陪伴',
    re: /角色|roleplay|rp\b|persona|人格|anime|動漫|陪伴|角色扮演|記憶/i,
    needLLM: true,
    models: ['Claude Sonnet', 'Gemini 2.5 Pro', 'GPT-4o'],
    why: '要吃長上下文與人格一致性，還要壓得住越界。上下文短、便宜的模型很容易「出戲」。',
    cost: '中高（每次對話都帶長角色設定）'
  },
  {
    key: 'moderation', label: '社群管理／邀請追蹤',
    re: /moderat|管理|invite|邀請|welcome|歡迎|auto-?role|giveaway|抽獎|等級|level/i,
    needLLM: false,
    models: ['不需要 LLM（規則型）', '要摘要時：GPT-4o-mini / Gemini Flash'],
    why: '絕大多數是規則與資料庫操作，接 LLM 只會變慢變貴；只有「聊天摘要」「自動回覆」才需要小模型。',
    cost: '極低'
  },
  {
    key: 'trading', label: '交易／金融',
    re: /trad|交易|stock|股票|量化|backtest|回測|crypto|行情|合約/i,
    needLLM: false,
    models: ['規則／回測引擎（不接 LLM）', 'LLM 只做研究摘要：Claude / GPT-4o'],
    why: '下單與風控不能交給會幻覺的模型。LLM 適合讀新聞、寫研究筆記，不適合執行。',
    cost: '低（不接 LLM 時）'
  },
  {
    key: 'translate', label: '翻譯',
    re: /translat|翻譯|i18n|語言/i,
    needLLM: false,
    models: ['DeepL API', 'Google Cloud Translation', 'LLM 次選：GPT-4o-mini / Claude Haiku'],
    why: '專用翻譯 API 在穩定度與成本上都贏過 LLM；LLM 只在「帶語氣、帶術語表」時有優勢。',
    cost: '低'
  },
  {
    key: 'tool', label: '工具型查詢（機票／匯率／統計／遊戲數據）',
    re: /flight|機票|匯率|price|價格|stats|統計|trivia|quiz|wiki|天氣|weather|匯率|查詢/i,
    needLLM: false,
    models: ['不需要 LLM（API ＋ 規則）'],
    why: '這類 bot 的價值在資料源與通知時機，不在語言能力。接 LLM 只是多一層費用與延遲。',
    cost: '極低'
  },
  {
    key: 'content', label: '內容生成（圖／影片／文案）',
    re: /image|圖像|影片|video|繪圖|midjourney|生成|創作|music|音樂/i,
    needLLM: true,
    models: ['圖像：GPT-Image / Seedream / Midjourney', '影片：Seedance / Veo', '文案：GPT-4o / Gemini'],
    why: '生成品質取決於生成模型，不是聊天模型；編排與提示詞才交給 LLM。',
    cost: '中高（按張／按秒計價）'
  },
  {
    key: 'assistant', label: 'AI 聊天助手',
    re: /助手|assistant|chat|聊天|對話|問答|bot\b/i,
    needLLM: true,
    models: ['日常：GPT-4o-mini / Gemini Flash', '難題：GPT-4o / Claude Sonnet'],
    why: '這類 bot 的品質幾乎等於背後模型。日常問答用小模型省錢，需要長文推理時再切大模型。',
    cost: '低～中（看路由）'
  },
  {
    key: 'multi', label: '多模型切換／聚合',
    re: /multi-?model|多模型|chatgpt|claude|gemini|deepseek|切換|proxy|中轉/i,
    needLLM: true,
    models: ['多模型路由：OpenAI ＋ Claude ＋ Gemini ＋ DeepSeek'],
    why: '這類 bot 本體就是路由層，價值在「同一個餘額／同一個入口」；挑最便宜的通道做日常，貴的留給難題。',
    cost: '中（看你怎麼路由）'
  },
  {
    key: 'other', label: '其他／未分類',
    re: /./, needLLM: null,
    models: ['依實際接入的模型而定'], why: '資訊不足，無法判斷它接哪個模型。', cost: '—'
  }
];

const CAT_MAP = {
  '社群工具': 'moderation', '工具效率': 'tool', 'AI 助手': 'assistant', '交易金融': 'trading',
  '角色扮演': 'roleplay', '翻譯': 'translate', '遊戲娛樂': 'content', '學習解題': 'assistant'
};

function classify(it) {
  const hay = ((it.name || '') + ' ' + (it.desc || '')).toLowerCase();
  // 有描述時先看內容；描述太短（<8 字）就用收錄時的分類
  if ((it.desc || '').length >= 8) {
    const byText = FIT.find(f => f.key !== 'other' && f.re.test(hay));
    if (byText) return byText;
  }
  const byCat = CAT_MAP[it.category];
  if (byCat) return FIT.find(f => f.key === byCat);
  if (it.desc && it.desc.length >= 8) return FIT[FIT.length - 1];
  return FIT.find(f => f.key === 'assistant');
}

function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 : 0; }

function main() {
  const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const items = data.items || [];
  const total = items.length;

  const byPlatform = {}, byCategory = {}, bySource = {}, byFit = {};
  let verified = 0, openSource = 0, big = 0;
  const bands = { '90+': 0, '80–89': 0, '70–79': 0, '60–69': 0, '<60': 0 };

  for (const it of items) {
    byPlatform[it.platform] = (byPlatform[it.platform] || 0) + 1;
    byCategory[it.category || '未分類'] = (byCategory[it.category || '未分類'] || 0) + 1;
    bySource[it.source] = (bySource[it.source] || 0) + 1;
    if (it.verified === true) verified++;
    if (it.source === 'github' || /github\.com/i.test(it.url || '')) openSource++;
    const s = it.score || 0;
    if (s >= 90) bands['90+']++;
    else if (s >= 80) bands['80–89']++;
    else if (s >= 70) bands['70–79']++;
    else if (s >= 60) bands['60–69']++;
    else bands['<60']++;
    if ((it.users || 0) >= 10000 || (it.stars || 0) >= 1000) big++;
    const f = classify(it);
    byFit[f.key] = byFit[f.key] || { count: 0, examples: [], top: null };
    byFit[f.key].count++;
    if (byFit[f.key].examples.length < 4) byFit[f.key].examples.push(it.name);
    if (!byFit[f.key].top || s > byFit[f.key].top.score) byFit[f.key].top = { name: it.name, score: s };
  }

  const groups = Object.keys(byFit).map(k => {
    const f = FIT.find(x => x.key === k);
    return {
      key: k, label: f.label, count: byFit[k].count, share: pct(byFit[k].count, total),
      needLLM: f.needLLM, models: f.models, why: f.why, cost: f.cost,
      examples: byFit[k].examples, top: byFit[k].top
    };
  }).sort((a, b) => b.count - a.count);

  const ranked = items.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  const picks = {};
  for (const g of ['framework', 'roleplay', 'moderation', 'trading', 'translate']) {
    picks[g] = ranked.filter(it => classify(it).key === g).slice(0, 3).map(it => ({ name: it.name, platform: it.platform, score: it.score, url: it.url }));
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    total, byPlatform, byCategory, bySource, bands,
    verified, openSource, reachBig: big,
    verifiedShare: pct(verified, total),
    openShare: pct(openSource, total),
    bigShare: pct(big, total),
    groups,
    picks,
    note: '模型適配是依 bot 的用途與描述做規則分類，不是它宣稱支援的模型清單；實際可用模型以各 bot 文件為準。'
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
  console.log('平台', byPlatform);
  console.log('適配分組', groups.map(g => `${g.label} ${g.count}`).join(' | '));
  console.log('→', OUT);
}

main();
