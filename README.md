# Skill 商店聚合工作台 · GitHub Pages 版

不需要伺服器、不需要付費。資料由 GitHub Actions 每 6 小時抓一次，寫進 `data/skills.json`，Pages 直接把這份快照讀出來排序顯示。

```
index.html                    前端（讀 ./data/skills.json，找不到才退回 /api/skills）
scripts/collect.js            抓取腳本：CocoLoop + ClawHub + skills.sh → data/skills.json
data/skills.json              Actions 產生的快照（目前 1,249 筆，約 465 KB）
.github/workflows/sync-and-deploy.yml   排程 + 部署
.nojekyll                     避免 Pages 跑 Jekyll 處理
```

## 來源管理（新增／移除商店）

右上角「商店來源」按鈕開面板：

- 內建三源可一鍵「移除」（暫時隱藏，資料仍在快照裡），再按「加入」復原。
- 貼上任何回傳 JSON 的網址即可新增來源，例如 GitHub 搜尋 API：`https://api.github.com/search/repositories?q=topic:claude-skill&sort=stars&per_page=20`
- 支援的 JSON 形狀：`{items:[]}`、`{data:[]}`、`{skills:[]}`、`{results:[]}` 或純陣列；欄位自動對應 `name / displayName / title / full_name`、`stars / stargazers_count`、`downloads / installs`、`url / html_url`。
- 目標網址必須允許跨網域（CORS），否則會提示 CORS 被擋；純靜態 `.json` 網址一律可用。
- 新增的來源存在該瀏覽器的 `localStorage`（`skh-customs`），只對你這台裝置生效；要全站共用，就在 `scripts/collect.js` 多加一個抓取器，把資料併進快照。
- 每個商店固定一色：CocoLoop 青綠、ClawHub 琥珀、skills.sh 靛藍，自訂來源由網址雜湊自動配色；卡片、篩選 chip、左側色條、圖例一致對應。

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
