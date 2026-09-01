# 部署到 GitHub Pages

看板是纯静态页面，数据内联在 HTML 里（无 fetch、无 CORS 问题），双击本地文件也能打开。

---

## 方案 A：本地采集 + 推送（推荐先用这个）

最稳，因为采集在你自己的网络里跑，不受 Actions 限流影响。

```bash
cd oversea-monitor

# 1. 初始化仓库
git init
git add -A
git commit -m "feat: 海外竞品心智监控系统"

# 2. 关联远端（先在 GitHub 上建一个空仓库）
git remote add origin git@github.com:<你的账号>/<仓库名>.git
git branch -M main
git push -u origin main
```

然后在 GitHub 仓库页面：

**Settings → Pages → Build and deployment**
- Source 选 `Deploy from a branch`
- Branch 选 `main`，目录选 **`/docs`**
- Save

一两分钟后访问：`https://<你的账号>.github.io/<仓库名>/`

### 之后每天更新

```bash
node collectors/mindshare.js --limit 10
node collectors/charts.js --limit 100
node collectors/app_metrics.js
node collectors/report.js
node collectors/build_site.js

git add data/snapshots reports docs
git commit -m "chore: $(date +%F) 数据更新"
git push
```

推上去 Pages 会自动重新发布。可以把这四行 + git 提交写进一个 `update.sh`，挂 launchd 每天跑（README 第 6 节有配置）。

---

## 方案 B：GitHub Actions 全自动

⚠️ **首次部署时这个文件没有推上去** —— 用于部署的 token 只勾了 `repo`，而推送 `.github/workflows/` 下的文件额外需要 `workflow` scope，GitHub 会直接拒绝：

```
refusing to allow a Personal Access Token to create or update workflow
`.github/workflows/daily.yml` without `workflow` scope
```

要启用自动采集，需要重新生成一个同时勾选 `repo` + `workflow` 的 token，然后把工作流文件加回去：

```bash
# workflow 文件内容见本文件末尾附录，或从交付包里取
mkdir -p .github/workflows
# 放入 daily.yml 后
git add .github && git commit -m "ci: 每日自动采集" && git push
```

工作流内容：每天北京时间 09:00 自动采集、构建、发布。

启用步骤：

1. **Settings → Pages → Source** 改成 `GitHub Actions`
2. **Settings → Actions → General → Workflow permissions** 选 `Read and write permissions`
3. 到 **Actions** 标签页手动触发一次 `每日采集并发布看板`，确认能跑通

**要注意的一点**：Actions runner 的出口 IP 是数据中心网段，苹果接口可能限流更严。workflow 里已把 `OM_INTERVAL_MS` 设成 1500ms。如果日志里 `blocked` 计数偏高，调大到 2500，或者干脆退回方案 A。

---

## 私有仓库也能用 Pages 吗

可以，但需要 GitHub Pro / Team / Enterprise。免费账号的私有仓库无法开 Pages。

如果数据不想公开又想免费，两个选择：
- 仓库公开、但只提交 `docs/` 和 `data/snapshots/`（都是公开接口采来的数据，本身不含机密）
- 或者不用 Pages，本地 `python3 -m http.server` 看，需要分享时再导出 HTML 发出去

---

## 常见问题

**页面打开是空白/404**
Pages 的目录设置要选 `/docs` 而不是根目录。另外首次发布有 1~2 分钟延迟。

**图表不显示**
页面依赖 ECharts CDN（jsdelivr）。如果你的网络访问不了 jsdelivr，把 `collectors/build_site.js` 里的 CDN 地址换成 `https://cdn.bootcdn.net/ajax/libs/echarts/5.4.3/echarts.min.js` 再重新构建。

**data/raw 太大**
`.gitignore` 已排除。它是原始响应缓存（单日约 80MB），可随时重新获取。**但 `data/snapshots/` 必须提交** —— 那是逐步积累的时间序列，删了就没了。

**想让别人看不到某些市场的数据**
数据在 `docs/data.json` 和 HTML 内联块里都有一份。要过滤就在 `build_site.js` 的 `mindSlim` / `metricSlim` 那两个 map 里加条件，重新构建。

---

## 附录：daily.yml 完整内容

需 token 带 `workflow` scope 才能推送。保存到 `.github/workflows/daily.yml`：

```yaml
name: 每日采集并发布看板

# GitHub Actions 的 runner 在境外，网络出口通常比本地更顺畅。
# 如果 Actions 被限流，把 schedule 注释掉、改成本地跑 + git push 即可。
on:
  schedule:
    - cron: '0 1 * * *'   # UTC 01:00 = 北京时间 09:00
  workflow_dispatch:       # 支持手动触发

permissions:
  contents: write
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  collect-and-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: 采集心智占位数据
        run: node collectors/mindshare.js --limit 10
        env:
          OM_INTERVAL_MS: 1500

      - name: 采集竞品指标
        run: node collectors/app_metrics.js
        env:
          OM_INTERVAL_MS: 1500

      - name: 生成报告
        run: node collectors/report.js

      - name: 构建静态站点
        run: node collectors/build_site.js

      - name: 提交数据快照
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/snapshots reports docs
          git diff --staged --quiet || git commit -m "chore: 每日数据采集 $(date -u +%Y-%m-%d)"
          git push

      - uses: actions/configure-pages@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs
      - uses: actions/deploy-pages@v4
```
