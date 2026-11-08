# Skill 商店聚合工作台 · GitHub Pages 版

不需要伺服器、不需要付費。資料由 GitHub Actions 每 6 小時抓一次，寫進 `data/skills.json`，Pages 直接把這份快照讀出來排序顯示。

```
index.html                    前端（讀 ./data/skills.json，找不到才退回 /api/skills）
scripts/collect.js            抓取腳本：CocoLoop + ClawHub + skills.sh → data/skills.json
data/skills.json              Actions 產生的快照（目前 1,249 筆，約 465 KB）
.github/workflows/sync-and-deploy.yml   排程 + 部署
.nojekyll                     避免 Pages 跑 Jekyll 處理
```

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
