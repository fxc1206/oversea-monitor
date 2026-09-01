# 海外竞品心智监控系统

监控海外社交/内容产品在全球各市场占据的**用户心智**与**量级动能**，数据每日采集、本地存档、可逐步积累成时间序列数据库。

纯 Node.js 实现，零第三方依赖。所有数据落本地文件，可离线重算、可交给 Codex 接管改造。

---

## 1. 快速开始

```bash
cd oversea-monitor
node --version          # 需 v18+

# 首次：小范围验证环境通不通
node collectors/mindshare.js --cc us,jp --dim recipes,news_public --limit 8

# 全量心智扫描（39 国 × 16 维度 = 624 次请求，约 15 分钟）
node collectors/mindshare.js --limit 10

# 竞品指标采集（11 App × 39 国，首次会解析各国 App ID）
node collectors/app_metrics.js

# 3. 榜单动能（分类免费榜榜位，39国×9分类，约6分钟）
node collectors/charts.js --limit 100

# 生成报告（读本地快照，不发网络请求）
node collectors/report.js

# 构建可访问的静态看板
node collectors/build_site.js
```

产出位置：
- `docs/index.html` — **交互式看板，可直接部署 GitHub Pages**（部署见 `DEPLOY.md`）
- `reports/report_<date>.md` — 完整分析报告
- `reports/mindshare_<date>.csv` — 扁平数据，可直接进 Excel/BI
- `reports/analysis_<date>.json` — 结构化分析结果

看板数据内联在 HTML 中（无 fetch、无 CORS），所以双击本地文件也能打开。

---

## 2. 目录结构

```
oversea-monitor/
├── config/
│   ├── markets.json            # 10 大区 39 国
│   ├── mindshare_terms.json    # 16 心智维度 × 16 语言词库
│   └── apps.json               # 11 竞品 + 社交/游戏识别正则
├── collectors/
│   ├── mindshare.js            # 心智占位扫描
│   ├── app_metrics.js          # 竞品指标 + 跨国 ID 解析
│   ├── charts.js               # 榜单动能（分类免费榜榜位）
│   ├── report.js               # Markdown 报告 + CSV
│   └── build_site.js           # 静态看板构建
├── docs/                       # GitHub Pages 根目录
│   ├── index.html              # 交互式看板（数据已内联）
│   └── data.json               # 结构化数据，供外部消费
├── .github/workflows/daily.yml # 每日自动采集与发布
├── DEPLOY.md                   # GitHub Pages 部署说明
├── lib/
│   ├── core.js                 # 限速 HTTP / raw 存档 / 快照追加
│   └── analyze.js              # 6 类洞察计算（纯本地）
└── data/
    ├── raw/<date>/<hash>.json  # 每次响应原始存档
    ├── snapshots/
    │   ├── mindshare/<date>.jsonl
    │   └── app_metrics/<date>.jsonl
    └── app_id_map.json         # (app,country) -> trackId 映射
```

---

## 3. 数据架构的三个设计决定

**① 原始响应先落盘，再解析。** 每次外部响应存到 `data/raw/<date>/`。解析逻辑改了可以重跑历史 raw，不必重新打接口。同一天内重复请求同一 URL 直接复用缓存 —— 调试解析逻辑时不消耗配额。

**② 快照 JSONL 追加，永不覆盖。** 每天一个文件、每行一条记录。这是逐步积累时间序列的基础，也让「某天数据采错了」只影响那一天。

**③ 采集与分析彻底分离。** `collectors/` 负责取数存档，`lib/analyze.js` 只读本地快照、不碰网络。所以口径改了可以离线把所有历史数据重算一遍。

---

## 4. 数据源现状（实测于 2026-08-31）

| 源 | 状态 | 说明 |
|---|---|---|
| iTunes Search API | ✅ 全通 | 需求词占位扫描的基础，支持按国家切分 |
| iTunes Lookup API | ✅ 全通 | 评分数/均分/版本/发版日/本地化描述 |
| iTunes 评论 RSS | ✅ 可用 | 每国每 App 50 条最新评论，未接入采集器 |
| Apple 榜单 RSS | ⚠️ 待测 | `rss.applemarketingtools.com`，本地大概率可用 |
| Google Play | ❌ 未实现 | 无官方接口，需解析网页；且安装量是分桶常量，对大 App 无分辨力 |
| Google Trends | ❌ 不建议 | 非公开 API，对自动化极敏感，建议手动导 CSV |
| Reddit JSON | ❌ 受限 | 官方 API 需 OAuth；建议按需专项检索而非入管线 |
| Sensor Tower | — | 你有账号。Enterprise 档才有 API，否则网页导 CSV |

### 待你在本地验证的一件事

Apple 榜单 RSS 在受限网络下会被拦，本地应该能通：

```bash
curl -sL "https://rss.applemarketingtools.com/api/v2/us/apps/top-free/50/apps.json" | head -c 300
```

返回 JSON 就说明可用，可以再加一个 `collectors/charts.js` 采集每日榜单排名 —— 这是比评分数更直接的量级代理。

---

## 5. 指标口径（重要，别读反）

### 心智占位扫描

测量的是**「某需求词在该国 App Store 内的搜索结果排序」**。

⚠️ **最大局限**：搜索排名受商店文案关键词匹配度影响极大。综合社交产品的商店描述里不会写 "recipes"，所以它们在生活决策类需求词下天然搜不出来。

**「社交产品缺席某需求词」≠「用户心智里社交产品不承担该需求」。** 真实情况可能是用户做饭时确实先打开 TikTok，但商店搜 recipes 搜不到它。

✅ 正确用途：跨国比较供给结构（本土 vs 国际谁把住入口）、纵向监测占位变化。
❌ 不能回答：用户实际心智归属、DAU、留存。

### 评分数（userRatingCount）

累计值，不是当期值。**日增**才是量级代理。

评分数 ≈ 累计下载 × 评分转化率，而转化率跨 App 差异巨大。

✅ 同一 App 同一国家的纵向趋势对比
❌ 跨 App 比绝对值（Threads 印尼 15 万 vs Instagram 印尼 335 万 **不代表**用户规模比例）

### 三层心智模型

| 层 | 数据 | 含义 |
|---|---|---|
| 宣称心智 | 本地化商店名称/描述/品类 | 它想让用户把它当什么 |
| 货架心智 | 需求词搜索排名、分类榜 | 渠道把谁推给有此需求的用户 |
| 实际心智 | 评论文本用例提取 | 用户实际拿它干什么 |

三层之间的**落差**比单层数值更有信息量。例：Threads 日区宣称「通过对话发现新视角」，而日区最新评论出现「業者ばかり」「普通の人いない」（全是营销号／没有真人）—— 这个落差就是它在日本的软肋。

---

## 6. 挂定时任务

### macOS launchd（推荐，比 cron 可靠）

`~/Library/LaunchAgents/com.oversea.monitor.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.oversea.monitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd /ABSOLUTE/PATH/oversea-monitor && node collectors/mindshare.js --limit 10 && node collectors/app_metrics.js && node collectors/charts.js --limit 100 && node collectors/report.js</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/tmp/oversea-monitor.log</string>
  <key>StandardErrorPath</key><string>/tmp/oversea-monitor.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.oversea.monitor.plist
```

### 或 cron

```
0 9 * * * cd /ABSOLUTE/PATH/oversea-monitor && node collectors/mindshare.js --limit 10 && node collectors/app_metrics.js && node collectors/charts.js --limit 100 && node collectors/report.js >> /tmp/oversea-monitor.log 2>&1
```

---

## 7. 被限速/拦截时

`lib/core.js` 里 `RATE` 可用环境变量覆盖：

```bash
OM_INTERVAL_MS=3000 OM_MAX_RETRIES=5 node collectors/mindshare.js
```

判断依据：日志里 `blocked` 计数上升，说明返回了 HTML 拦截页而非 JSON。把 `OM_INTERVAL_MS` 调大即可。

分批跑也能规避：

```bash
node collectors/mindshare.js --region 东南亚
node collectors/mindshare.js --region 东亚
```

---

## 8. 交给 Codex 时怎么说

这套代码为本地接管设计。给 Codex 的上下文建议：

> 项目在 `oversea-monitor/`，纯 Node 零依赖。三层结构：`collectors/` 取数存档、`lib/core.js` 提供限速 HTTP 与快照追加、`lib/analyze.js` 只读本地快照做分析。
> 数据在 `data/snapshots/<dataset>/<date>.jsonl`，追加式永不覆盖；原始响应在 `data/raw/<date>/`，可用于重跑解析。
> 配置全在 `config/` 三个 JSON 里，加市场/加词/加竞品都只改配置不改代码。

常见改造任务：

| 想做什么 | 改哪里 |
|---|---|
| 加市场 | `config/markets.json` |
| 加心智词 | `config/mindshare_terms.json`（注意加对应语言） |
| 加竞品 | `config/apps.json` 的 `tracked_apps` |
| 加榜单采集 | 新建 `collectors/charts.js`，复用 `lib/core.js` |
| 加评论文本分析 | 接 `itunes.apple.com/<cc>/rss/customerreviews/id=<id>/sortBy=mostRecent/json` |
| 接 Sensor Tower CSV | 新建 `collectors/import_st.js`，写入 `data/snapshots/st_metrics/` |
| 改分析口径 | 只改 `lib/analyze.js`，然后重跑 `report.js` 即可回算全部历史 |

---

## 9. 已踩过的坑

**① 同一 App 跨国 trackId 不同。** TikTok 美区 `835599320`，日本/印尼 `1235601864`。用美区 ID 查日本会返回「无上架」—— 数据错了但不报错，是最危险的失败模式。`app_metrics.js` 因此强制先按国家解析 ID，并用 `seller_hint` 校验正主防山寨。

**② 批量请求会被拦成 HTML。** 同一接口小批量返回 JSON、大批量返回 HTML 拦截页。`core.js` 内建串行限速 + 指数退避，并把 `looksHTML` 单独计数便于诊断。

**③ 部分语言的需求词匹配质量差。** 泰语「ร้านอาหาร」(餐厅) 搜出来是 My Hot Pot Story、Cooking Madness 等游戏。已内建 `game_regex` 标记 `signal_quality`，低质市场需换词。

**④ 首日只有横截面，没有趋势。** iTunes 接口只给当下快照。评分数日增、排名变化等要连续采集 2 天以上才出现。这是时间问题，不是技术问题 —— 越早跑起来越好。
