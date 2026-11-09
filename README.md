# Skill 商店聚合工作台 · GitHub Pages 版

不需要伺服器、不需要付費。資料由 GitHub Actions 每 6 小時抓一次，寫進 `data/skills.json`，Pages 直接把這份快照讀出來排序顯示。

```
index.html                    前端（讀 ./data/skills.json，找不到才退回 /api/skills）
scripts/collect.js            抓取腳本：CocoLoop + ClawHub + skills.sh → data/skills.json
data/skills.json              Actions 產生的快照（目前 1,249 筆，約 465 KB）
.github/workflows/sync-and-deploy.yml   排程 + 部署
.nojekyll                     避免 Pages 跑 Jekyll 處理
```

## Bot 榜單（`/bots/`）

跨平台 bot 的合併榜單，跟商店工作台同一個站、獨立一頁（`bots/index.html`，資料 `data/bots.json`）。

```bash
node scripts/collect-bots.js            # 收 GitHub / Discord / Telegram / 人工核對
DISCORD_LIMIT=300 TG_PAGES=8 node scripts/collect-bots.js   # 可調數量
```

- **GitHub**：8 組搜尋主題（discord-bot、telegram-bot、qqbot、chatbot、bot、trading-bot 等），依 stars 取前列；會過濾書／清單／prompt 洩漏類非 bot 專案。
- **Discord**：`discord.bots.gg` 公開 API，取 `guildCount`（伺服器數）、`verified`、上線狀態。
- **Telegram**：`telegram-store.com/catalog/bots` 目錄（JSON-LD，約 7,074 筆），依目錄排序換算分數；該站不公開訂閱數。
- **人工核對**：`data/bots-seed.json`，逐筆附出處（top.gg 評分、第三方實測分數）。
- **抖音**：`data/bots-douyin.json`，只放「在講哪些 bot」的線索卡與原影片連結，讚數不進排名（影片數字未核實）。
- 綜合分 0–100：人數／星數取對數正規化，再加重驗證與近期活躍。各來源原始指標不同，頁面上分欄顯示，不混算。

## Bot 聚合分析與模型適配（`data/bots-analysis.json`）

```bash
node scripts/analyze-bots.js
```

把榜單按用途分成 9 組（開源框架、角色扮演、社群管理、交易、翻譯、工具查詢、內容生成、AI 聊天助手、多模型聚合），逐組給「建議模型、成本、為什麼」。分類是**依用途與描述做規則判斷**，不是 bot 宣稱支援的模型清單。

## 源碼安全掃描（`/risk/`、`data/risk-report.json`）

```bash
node scripts/scan-risk.js                 # 4～6 個 worker 可並跑：
STRIDE=6 OFFSET=0 node scripts/scan-risk.js   # OFFSET 0..5
MERGE=1 node scripts/scan-risk.js         # 合併各 worker 結果 → data/risk-report.json
```

- 只掃**有公開 GitHub 倉庫**的項目：`codeload.github.com` 下載 tarball、解到 `.scan-tmp/`、正則掃描，**不執行任何抓回來的程式碼**。
- 依檔案層級給權重：使用者會實際執行的檔案（安裝腳本、`bin/`、`Dockerfile`、`package.json`）命中才算高風險；一般原始碼降一級；CI／測試／範例只記錄不升等級。
- 規則涵蓋：遠端腳本餵 shell、混淆後執行（base64→eval）、讀 SSH／雲端憑證、外傳端點、把環境變數送出、破壞性刪除、排程／開機持久化、提示注入、零寬隱藏字元、postinstall 連網、命令拼字注入。
- 進度寫在 `.scan-cache/`，可中斷續跑。
- 覆蓋率誠實標示：閉源 bot 標「無法掃描」；命中不等於惡意，未命中也不等於安全。

## 介面翻譯覆蓋測試

```bash
node scripts/test-i18n.js      # 產出 data/i18n-coverage.json
```

比對 11 種語言的 key 是否齊全、是否有殘留中文、程式碼用到但字典沒有的 key。

## 來源管理（新增／移除商店）

右上角「商店來源」按鈕開面板：

- 內建三源可一鍵「移除」（暫時隱藏，資料仍在快照裡），再按「加入」復原。
- 貼上任何回傳 JSON 的網址即可新增來源，例如 GitHub 搜尋 API：`https://api.github.com/search/repositories?q=topic:claude-skill&sort=stars&per_page=20`
- 支援的 JSON 形狀：`{items:[]}`、`{data:[]}`、`{skills:[]}`、`{results:[]}` 或純陣列；欄位自動對應 `name / displayName / title / full_name`、`stars / stargazers_count`、`downloads / installs`、`url / html_url`。
- 目標網址必須允許跨網域（CORS），否則會提示 CORS 被擋；純靜態 `.json` 網址一律可用。
- 新增的來源存在該瀏覽器的 `localStorage`（`skh-customs`），只對你這台裝置生效；要全站共用，就在 `scripts/collect.js` 多加一個抓取器，把資料併進快照。
- 每個商店固定一色：CocoLoop 青綠、ClawHub 琥珀、skills.sh 靛藍，自訂來源由網址雜湊自動配色；卡片、篩選 chip、左側色條、圖例一致對應。

## 內容翻譯（Skill 名稱／描述）

介面文字 100% 內建翻譯（11 種語言）。Skill 本身的 `name` / `summary` 是各商店的原文，要一起翻譯需先跑一次翻譯腳本，產生的檔案前端會自動疊上去：

```bash
# DeepL（免費 50 萬字/月）
TRANSLATE_PROVIDER=deepl TRANSLATE_KEY=xxxx:fx LANGS=en,ja,ko,es,de,fr,pt,ru,ar node scripts/translate.js

# Google Cloud Translation
TRANSLATE_PROVIDER=google TRANSLATE_KEY=xxxx LANGS=en,ja node scripts/translate.js

# Azure / OpenAI 相容端點 / 自架 LibreTranslate
TRANSLATE_PROVIDER=azure TRANSLATE_KEY=xxx TRANSLATE_REGION=eastasia node scripts/translate.js
TRANSLATE_PROVIDER=openai TRANSLATE_KEY=sk-xxx TRANSLATE_BASE=https://api.openai.com/v1 node scripts/translate.js
TRANSLATE_PROVIDER=libre TRANSLATE_BASE=http://localhost:5000 node scripts/translate.js
```

- 產出 `data/i18n/<lang>.json`；前端切到該語言時自動讀取並覆蓋描述，沒有檔案就照原文顯示。
- 可中斷續跑：已翻過的條目會沿用舊檔，只補缺的（資料更新後重跑即可）。
- `FIELDS=summary`（預設）只翻描述，名稱保留原文——名稱常是安裝識別碼，翻了會找不到對應指令；要連名稱一起翻用 `FIELDS=name,summary`。
- 量級參考：1,239 筆描述約 8.1 萬字元，9 種語言約 73 萬字元。DeepL／Google 免費額度每月各 50 萬字，一個月內可跑完主要語言。

## 語言切換（11 種）

頁面右上角有語言選單，一鍵切換：繁體中文、简体中文、English、日本語、한국어、Español、Deutsch、Français、Português、Русский、العربية（阿拉伯語自動切 RTL 由右至左排版）。

- 介面文字全部內嵌在 `index.html` 的 `I18N` 字典，沒有外部請求，離線也能切。
- 選擇會存在 `localStorage`，下次打開沿用；也可用網址參數直接指定：`?lang=en`、`?lang=ja`、`?lang=ar`。
- 沒有記錄時依瀏覽器語言自動判斷（繁中 / 簡中會分開）。
- Skill 名稱與描述保留各商店原文（多為英文），只翻譯介面，避免二次翻譯失真；頁尾有註明。
- 新增語言：在 `I18N` 加一組 key（照 `en` 的欄位逐項翻），再在 `LANGS` 陣列補一行即可。

## 部署步驟（約 3 分鐘）

1. 在 GitHub 建一個新 repo（public 或 private 都可以，Pages 要 public 除非有 Pro）。
2. 把這個資料夾裡的東西全部推上去（注意 `.github` 資料夾是隱藏的，別漏）：
   ```bash
   cd skill-hub-pages
   git init -b main
   git add -A
   git commit -m "init skill hub"
   git remote add origin https://github.com/<你的帳號>/<repo>.git
   git push -u origin main
   ```
3. 到 repo → **Settings → Pages → Build and deployment → Source 選「GitHub Actions」**（不要選 Deploy from a branch）。
4. 到 **Actions** 分頁，等 `Sync skill data & deploy Pages` 跑完（第一次約 1 分鐘）；也可以直接按 **Run workflow** 手動觸發。
5. 網址會是 `https://<你的帳號>.github.io/<repo>/`。

之後每天 4 次（00:00 / 06:00 / 12:00 / 18:00 UTC）自動更新資料，有新資料才提交，不會產生空 commit。

## 想改成別的更新頻率

編輯 `.github/workflows/sync-and-deploy.yml` 的 cron：

| 頻率 | cron |
|---|---|
| 每 12 小時 | `0 */12 * * *` |
| 每天一次 | `0 1 * * *`（UTC 01:00 = 台北 09:00） |
| 每小時 | `0 * * * *` |

> 注意：太頻繁會增加對 CocoLoop 的請求量，建議 6 小時以上。

## 抓多少資料

在 workflow 的 `抓取三個商店資料` 步驟調環境變數：

- `COCO_PAGES`：CocoLoop 抓幾頁（每頁 20 筆），預設 20 = 400 筆
- `CLAW_LIMIT`：ClawHub 上限，預設 300
- `SKILLSIO_ENABLED: "0"`：可關掉 skills.sh
- `SKILLSIO_KEYWORDS`：skills.sh 的搜尋關鍵字，逗號分隔

資料量越大，`data/skills.json` 越大，Pages 載入越慢；1,000～2,000 筆大約 400～800 KB，算輕量。

## 加新商店

改 `scripts/collect.js`：寫一個 `loadXxx()` 回傳 `{ items: [...], note: '...' }`，欄位照現有的 `{id, source, sourceLabel, name, summary, category, rating, stars, downloads, author, url, updatedAt}`，再塞進 `jobs` 陣列即可。前端會自動出現新的來源 chip。

前端要加對應的顏色：`index.html` 裡的 `.badge.coco / .badge.claw / .badge.skillsio` 與 `SRC_NAME` 物件。

## 這版的限制

- **是快照，不是即時**：資料延遲最多 6 小時；要即時就用原本的 `server.js` 版本（本機或部署到 Railway / Vercel / Cloudflare Workers）。
- **Pages 只能靜態**：任何需要後端的東西（登入、上傳、收藏、即時查詢）這版做不到。
- **CocoLoop 介面非官方**：對方改版可能導致該來源抓取失敗；workflow 有逐源錯誤處理，單源失敗時其他兩源照樣部署，`data/skills.json` 的 `sources` 欄位會標記 `ok:false`，頁面來源卡會顯示紅點。
- 若三個來源全掛，腳本會 `exit 1`，Pages 保留上一次成功的快照。

## 翻譯：三種可行通道

實測結論（2026-11，本機與雲端資料中心 IP）：`translate.googleapis.com`、`translate.google.com`、
`clients5.google.com` 全部 timeout；`lingva.ml` 403（Cloudflare）；MyMemory 429（每日額度）；
LibreTranslate 六個鏡像 502／403／憑證錯誤；Microsoft Edge 免 token 端點 404；Yandex 403。
**資料中心 IP 基本被這些免費服務封鎖，靠本機腳本直翻走不通。**

可行路徑三條：

1. **GitHub Actions runner（推薦）** — `.github/workflows/translate.yml`，用 `TRANSLATE_PROVIDER=gtx`
   （免金鑰，逐一呼叫 Google 公開端點、3 次退避重試、失敗保留原文），跑完自動 commit `data/i18n/*.json`。
   注意：倉庫 token 需有 `workflow` scope 才推得上去，沒有時請在 GitHub 網頁手動新增此檔。
2. **有付費 key** — `TRANSLATE_PROVIDER=deepl|google|azure|openai`，一條命令跑完 1,249 筆 × N 語。
3. **瀏覽器端「翻譯描述」按鈕（免金鑰、免部署）** — 前端用 MyMemory 直翻，結果寫 localStorage，
   額度用完會停，隔天再按會從中斷處續跑（`skh-mt:<lang>` 快取）。

介面文案（73 個 key × 11 語）已 100% 覆蓋，可用 `node scripts/test-i18n.js` 重跑驗證。
