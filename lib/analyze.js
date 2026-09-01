'use strict';
/**
 * 洞察分析引擎：把快照转成可判读的结论。
 * 全部分析都基于本地快照文件，不发网络请求 —— 所以可以离线反复重算、改口径重跑。
 */
const C = require('./core');
const appsCfg = require('../config/apps.json');
const SOCIAL = new RegExp(appsCfg.social_regex, 'i');

/** 取每个 dataset 的最新一天快照 */
function latest(dataset) {
  const rows = C.loadSnapshots(dataset);
  if (!rows.length) return { date: null, rows: [] };
  const d = rows.map((r) => r._date).sort().pop();
  return { date: d, rows: rows.filter((r) => r._date === d) };
}

/** 1. 供给结构：某市场某需求，是本土玩家还是国际玩家占位 */
function supplyStructure(mindRows) {
  const byMarket = {};
  for (const r of mindRows) {
    if (r.signal_quality === 'empty') continue;
    byMarket[r.cc] = byMarket[r.cc] || { region: r.region, market: r.market, cc: r.cc, dims: 0, social_hits: 0, low_quality: 0, top1_sellers: [] };
    const b = byMarket[r.cc];
    b.dims++;
    if (r.social_top_rank) b.social_hits++;
    if (r.signal_quality === 'low') b.low_quality++;
    if (r.top1_seller) b.top1_sellers.push(r.top1_seller);
  }
  return Object.values(byMarket).map((b) => ({
    ...b,
    social_occupancy_pct: b.dims ? Number(((b.social_hits / b.dims) * 100).toFixed(1)) : null,
    signal_reliability: b.dims ? Number((((b.dims - b.low_quality) / b.dims) * 100).toFixed(1)) : null,
    distinct_top1_sellers: new Set(b.top1_sellers).size,
  })).sort((a, b) => b.social_occupancy_pct - a.social_occupancy_pct);
}

/** 2. 维度占位：哪些心智维度全球范围内被社交产品占住，哪些是垂类工具的地盘 */
function dimensionOccupancy(mindRows) {
  const byDim = {};
  for (const r of mindRows) {
    if (r.signal_quality === 'empty') continue;
    byDim[r.dimension] = byDim[r.dimension] || { dimension: r.dimension, dimension_cn: r.dimension_cn, group: r.group, markets: 0, social_hits: 0, holders: {}, social_names: {} };
    const b = byDim[r.dimension];
    b.markets++;
    if (r.social_top_rank) {
      b.social_hits++;
      b.social_names[r.social_top_name] = (b.social_names[r.social_top_name] || 0) + 1;
    }
    if (r.top5 && r.top5[0]) b.holders[r.top5[0]] = (b.holders[r.top5[0]] || 0) + 1;
  }
  return Object.values(byDim).map((b) => ({
    dimension: b.dimension,
    dimension_cn: b.dimension_cn,
    group: b.group,
    markets: b.markets,
    social_hits: b.social_hits,
    social_occupancy_pct: Number(((b.social_hits / b.markets) * 100).toFixed(1)),
    top_social: Object.entries(b.social_names).sort((a, b2) => b2[1] - a[1]).slice(0, 3).map(([n, c]) => `${n}(${c})`),
    most_common_holder: Object.entries(b.holders).sort((a, b2) => b2[1] - a[1]).slice(0, 3).map(([n, c]) => `${n}(${c})`),
  })).sort((a, b) => b.social_occupancy_pct - a.social_occupancy_pct);
}

/** 3. 竞品心智版图：每个竞品在哪些国家、哪些维度上占住了入口 */
function appMindshareMap(mindRows) {
  const byApp = {};
  for (const r of mindRows) {
    for (const res of r.results || []) {
      if (!SOCIAL.test(res.name)) continue;
      // 归一化到竞品 key
      const key = (appsCfg.tracked_apps.find((a) => new RegExp(a.search_term.split(' ')[0], 'i').test(res.name)) || {}).key
        || res.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0]
        || 'unknown';
      byApp[key] = byApp[key] || { app: key, entries: [], markets: new Set(), dims: new Set() };
      byApp[key].entries.push({ cc: r.cc, market: r.market, region: r.region, dimension: r.dimension, dimension_cn: r.dimension_cn, rank: res.rank, name: res.name });
      byApp[key].markets.add(r.cc);
      byApp[key].dims.add(r.dimension);
    }
  }
  return Object.values(byApp).map((b) => ({
    app: b.app,
    total_placements: b.entries.length,
    market_count: b.markets.size,
    dimension_count: b.dims.size,
    top_placements: b.entries.sort((x, y) => x.rank - y.rank).slice(0, 8).map((e) => `${e.market}/${e.dimension_cn}#${e.rank}`),
    dimensions: [...b.dims],
  })).sort((a, b) => b.total_placements - a.total_placements);
}

/** 4. 区域对比：本土化壁垒高低（top1 供给方的集中度与国际化程度） */
function regionComparison(mindRows) {
  const byRegion = {};
  for (const r of mindRows) {
    if (r.signal_quality === 'empty') continue;
    byRegion[r.region] = byRegion[r.region] || { region: r.region, rows: 0, social_hits: 0, low_q: 0, sellers: {} };
    const b = byRegion[r.region];
    b.rows++;
    if (r.social_top_rank) b.social_hits++;
    if (r.signal_quality === 'low') b.low_q++;
    if (r.top1_seller) b.sellers[r.top1_seller] = (b.sellers[r.top1_seller] || 0) + 1;
  }
  return Object.values(byRegion).map((b) => {
    const sellerEntries = Object.entries(b.sellers).sort((x, y) => y[1] - x[1]);
    const repeatShare = sellerEntries.filter(([, c]) => c > 1).reduce((s, [, c]) => s + c, 0);
    return {
      region: b.region,
      observations: b.rows,
      social_occupancy_pct: Number(((b.social_hits / b.rows) * 100).toFixed(1)),
      low_quality_pct: Number(((b.low_q / b.rows) * 100).toFixed(1)),
      distinct_top1_sellers: sellerEntries.length,
      // 集中度高 = 少数玩家把住多个需求入口 = 壁垒偏高
      concentration_pct: Number(((repeatShare / b.rows) * 100).toFixed(1)),
      top_sellers: sellerEntries.slice(0, 5).map(([n, c]) => `${n}(${c})`),
    };
  }).sort((a, b) => b.concentration_pct - a.concentration_pct);
}

/** 5. 评分数日增趋势（需 >=2 天快照才有输出） */
function ratingMomentum(metricRows) {
  const byKey = {};
  for (const r of metricRows) {
    if (!r.listed) continue;
    const k = `${r.app}|${r.cc}`;
    byKey[k] = byKey[k] || [];
    byKey[k].push({ date: r._date, count: r.rating_count, avg: r.rating_avg, version: r.version });
  }
  const out = [];
  for (const [k, series] of Object.entries(byKey)) {
    series.sort((a, b) => a.date.localeCompare(b.date));
    if (series.length < 2) continue;
    const [app, cc] = k.split('|');
    const first = series[0], last = series[series.length - 1];
    const days = (new Date(last.date) - new Date(first.date)) / 86400000 || 1;
    out.push({
      app, cc,
      from: first.date, to: last.date, days,
      delta: last.count - first.count,
      daily_avg: Number(((last.count - first.count) / days).toFixed(1)),
      rating_avg_change: last.avg != null && first.avg != null ? Number((last.avg - first.avg).toFixed(3)) : null,
      version_changed: first.version !== last.version,
      points: series.length,
    });
  }
  return out.sort((a, b) => b.daily_avg - a.daily_avg);
}

/** 6. 数据健康度 */
function dataHealth(mindRows, metricRows) {
  const q = { ok: 0, medium: 0, low: 0, empty: 0 };
  for (const r of mindRows) q[r.signal_quality] = (q[r.signal_quality] || 0) + 1;
  const dates = [...new Set(C.loadSnapshots('mindshare').map((r) => r._date))].sort();
  return {
    mindshare_rows: mindRows.length,
    mindshare_quality: q,
    mindshare_usable_pct: mindRows.length ? Number((((q.ok + q.medium) / mindRows.length) * 100).toFixed(1)) : 0,
    metric_rows: metricRows.length,
    metric_listed: metricRows.filter((r) => r.listed).length,
    snapshot_dates: dates,
    history_days: dates.length,
    trend_ready: dates.length >= 2,
  };
}

function buildAll() {
  const mind = latest('mindshare');
  const metrics = latest('app_metrics');
  const allMetrics = C.loadSnapshots('app_metrics');
  return {
    generated_at: C.nowISO(),
    mindshare_date: mind.date,
    metrics_date: metrics.date,
    health: dataHealth(mind.rows, metrics.rows),
    supply_structure: supplyStructure(mind.rows),
    dimension_occupancy: dimensionOccupancy(mind.rows),
    app_mindshare: appMindshareMap(mind.rows),
    region_comparison: regionComparison(mind.rows),
    rating_momentum: ratingMomentum(allMetrics),
  };
}

module.exports = { buildAll, latest, supplyStructure, dimensionOccupancy, appMindshareMap, regionComparison, ratingMomentum, dataHealth };
