'use strict';
/**
 * 报告生成：读本地快照 -> 产出 Markdown 报告 + 扁平 CSV。
 * 不发网络请求，可离线反复重跑。
 *   node collectors/report.js
 */
const fs = require('fs');
const path = require('path');
const C = require('../lib/core');
const A = require('../lib/analyze');

function mdTable(headers, rows) {
  const h = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((c) => (c == null ? '—' : String(c).replace(/\|/g, '\\|'))).join(' | ')} |`);
  return [h, sep, ...body].join('\n');
}

function main() {
  const R = A.buildAll();
  const out = [];

  out.push(`# 海外竞品心智监控报告`);
  out.push(``);
  out.push(`生成时间：${R.generated_at}　|　心智扫描数据日期：${R.mindshare_date || '无'}　|　指标数据日期：${R.metrics_date || '无'}`);
  out.push(``);
  out.push(`## 0. 数据口径与局限（先读这一节）`);
  out.push(``);
  out.push(`本报告的核心数据来自 Apple App Store 公开搜索接口，测量的是**「某需求词在该国商店内的搜索结果排序」**。`);
  out.push(``);
  out.push(`**必须知道的局限**：搜索排名受商店文案关键词匹配度影响极大。综合型社交产品（如 TikTok、Instagram）的商店描述里通常不会写 "recipes"，因此它们在生活决策类需求词下天然搜不出来。`);
  out.push(`所以「社交产品缺席某需求词」**不能**直接推断为「用户心智里社交产品不承担该需求」——真实情况可能是用户做饭时确实先打开 TikTok，但商店搜 recipes 搜不到它。`);
  out.push(``);
  out.push(`**本数据的正确用途**：①跨国比较供给结构（本土玩家 vs 国际玩家谁把住入口）；②纵向监测占位变化（谁开始进攻某个需求）。`);
  out.push(`**本数据不能回答**：用户实际心智归属、DAU/播放量、留存。这些需要 Sensor Tower、用户调研等其他证据。`);
  out.push(``);
  out.push(`### 数据健康度`);
  out.push(``);
  const h = R.health;
  out.push(mdTable(['项', '值'], [
    ['心智扫描行数', h.mindshare_rows],
    ['信号可用率', `${h.mindshare_usable_pct}%（ok ${h.mindshare_quality.ok} / medium ${h.mindshare_quality.medium} / low ${h.mindshare_quality.low} / empty ${h.mindshare_quality.empty}）`],
    ['竞品指标行数', `${h.metric_rows}（其中已上架 ${h.metric_listed}）`],
    ['已积累快照天数', h.history_days],
    ['趋势分析是否就绪', h.trend_ready ? '是' : `否 —— 仅 ${h.history_days} 天数据，需 ≥2 天`],
  ]));
  out.push(``);
  if (!h.trend_ready) {
    out.push(`> ⚠️ 首次运行只有单日横截面。评分数日增、排名变化等趋势指标需要连续采集 2 天以上才会出现。`);
    out.push(``);
  }

  out.push(`## 1. 区域供给结构对比`);
  out.push(``);
  out.push(`concentration 高 = 少数玩家把住多个需求入口 = 本土壁垒偏高；social_occupancy 高 = 社交产品在该区域更多地占据需求入口。`);
  out.push(``);
  out.push(mdTable(['区域', '观测数', '社交占位率', '入口集中度', '低质信号率', '主要占位方(次数)'],
    R.region_comparison.map((r) => [r.region, r.observations, r.social_occupancy_pct + '%', r.concentration_pct + '%', r.low_quality_pct + '%', r.top_sellers.slice(0, 3).join('、')])));
  out.push(``);

  out.push(`## 2. 心智维度占位格局`);
  out.push(``);
  out.push(`按社交产品占位率排序。占位率低的维度是垂类工具的地盘。`);
  out.push(``);
  out.push(mdTable(['心智维度', '归并组', '覆盖市场', '社交占位率', '主要社交玩家', '最常见占位方'],
    R.dimension_occupancy.map((d) => [d.dimension_cn, d.group, d.markets, d.social_occupancy_pct + '%', d.top_social.join('、') || '—', d.most_common_holder.slice(0, 2).join('、')])));
  out.push(``);

  out.push(`## 3. 竞品心智版图`);
  out.push(``);
  out.push(`各竞品在「需求词入口」上的占位广度。placements = 在多少个(市场×维度)格子的前N名里出现。`);
  out.push(``);
  out.push(mdTable(['竞品', '占位次数', '覆盖市场数', '覆盖维度数', '最靠前的占位'],
    R.app_mindshare.slice(0, 15).map((a) => [a.app, a.total_placements, a.market_count, a.dimension_count, a.top_placements.slice(0, 4).join('、')])));
  out.push(``);

  out.push(`## 4. 各市场明细`);
  out.push(``);
  out.push(mdTable(['市场', '区域', '覆盖维度', '社交占位率', '信号可靠度', '独立占位方数'],
    R.supply_structure.map((s) => [s.market, s.region, s.dims, s.social_occupancy_pct + '%', s.signal_reliability + '%', s.distinct_top1_sellers])));
  out.push(``);

  if (R.rating_momentum.length) {
    out.push(`## 5. 评分数动能（量级方向代理）`);
    out.push(``);
    out.push(`⚠️ 口径：评分数是累计值，日增才有意义。**只能同 App 纵向比，不能跨 App 比绝对值**（评分转化率差异巨大）。`);
    out.push(``);
    out.push(mdTable(['App', '国家', '区间', '天数', '评分数增量', '日均增量', '均分变化', '期间发版'],
      R.rating_momentum.slice(0, 40).map((m) => [m.app, m.cc, `${m.from}→${m.to}`, m.days, m.delta, m.daily_avg, m.rating_avg_change, m.version_changed ? '是' : '否'])));
    out.push(``);
  } else {
    out.push(`## 5. 评分数动能`);
    out.push(``);
    out.push(`暂无数据 —— 需连续运行 \`app_metrics.js\` 至少 2 天。`);
    out.push(``);
  }

  out.push(`## 6. 下一步建议`);
  out.push(``);
  out.push(`1. **把采集挂上定时任务**（见 README），每天固定时间跑一次，2~3 周后趋势线才有判读价值。`);
  out.push(`2. **合并近义维度**：\`config/mindshare_terms.json\` 里 \`group\` 字段已预留归并组，观察一周后把结果高度相似的维度并掉。`);
  out.push(`3. **补低质信号市场的词**：本报告「低质信号率」高的市场说明该语言的需求词匹配质量差（游戏噪声多），需换词。`);
  out.push(`4. **定性证据交叉验证**：本数据只是雷达。发现异动后需用 Reddit 讨论、用户调研确认心智归属。`);
  out.push(``);

  const reportPath = path.join(C.DIRS.reports, `report_${C.today()}.md`);
  fs.writeFileSync(reportPath, out.join('\n'));

  // 扁平 CSV，便于导入 Excel / BI / 交给 Codex 二次分析
  const mind = A.latest('mindshare');
  const csvRows = [['date', 'region', 'cc', 'market', 'dimension', 'dimension_cn', 'group', 'term', 'signal_quality', 'social_top_rank', 'social_top_name', 'top1', 'top2', 'top3', 'top1_seller']];
  for (const r of mind.rows) {
    csvRows.push([r._date, r.region, r.cc, r.market, r.dimension, r.dimension_cn, r.group, r.term, r.signal_quality,
      r.social_top_rank || '', r.social_top_name || '', (r.top5 || [])[0] || '', (r.top5 || [])[1] || '', (r.top5 || [])[2] || '', r.top1_seller || '']);
  }
  const csvPath = path.join(C.DIRS.reports, `mindshare_${C.today()}.csv`);
  fs.writeFileSync(csvPath, '\uFEFF' + csvRows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'));

  const jsonPath = path.join(C.DIRS.reports, `analysis_${C.today()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(R, null, 1));

  C.log(`报告: ${reportPath}`);
  C.log(`CSV:  ${csvPath}`);
  C.log(`JSON: ${jsonPath}`);
}

main();
