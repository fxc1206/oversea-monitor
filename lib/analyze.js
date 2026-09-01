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

/**
 * 占据强度判定：回答「这个心智在这个市场，是否已经有产品真的占住了」。
 *
 * 为什么不能只看排名：App Store 搜索永远返回结果，所以「谁排第一」这个问题永远有答案。
 * 但一个 3000 评分的小工具排第一，和クックパッド这种国民级产品排第一，战略含义完全不同。
 * 因此必须引入体量维度。
 *
 * 口径：
 *   rel   = 首位产品评分数 / 该市场所有格子首位评分数的中位数
 *           （按市场自身体量归一化，否则小市场会被绝对阈值全判为空位）
 *   share = 首位评分数 / 前五名评分数之和（领先优势）
 *
 *   occupied  rel>=1 且 share>=0.45  有大体量产品且显著领先 = 心智已被占住
 *   contested rel>=1 且 share<0.45   有大玩家但格局未定 = 正在争夺
 *   unclaimed rel<1                  首位低于本市场中位水平 = 商店渠道未见强占位
 *
 * ⚠️ unclaimed 不等于「这个心智没人占」：搜索排名由商店文案关键词匹配度主导，
 * 综合社交产品的描述里不写 "inspiration ideas"，所以 Pinterest 占着美国「找灵感」
 * 心智却会被判为 unclaimed。误报方向偏危险（让人误以为有空位），故命名为
 * 「未见强占位」而非「空位」，判读时必须配合定性证据。
 */
function occupancyStrength(mindRows) {
  // 体量基准按 (市场 × 词层) 分别取中位数。
  // 必须分层：宽词命中的是品类头部（量级大一个数量级），若与窄词共用基准，
  // 窄词层几乎全部会被判成 unclaimed，得出错误的「到处都是空位」。
  const byMk = {};
  for (const r of mindRows) {
    const t1 = ((r.results || [])[0] || {}).ratings || 0;
    const k = r.cc + '|' + (r.layer || 'narrow');
    (byMk[k] = byMk[k] || []).push(t1);
  }
  const base = {};
  for (const [k, arr] of Object.entries(byMk)) {
    arr.sort((a, b) => a - b);
    base[k] = arr[Math.floor(arr.length / 2)] || 1;
  }
  return mindRows.map((r) => {
    const rs = (r.results || []).map((x) => x.ratings || 0);
    if (!rs.length || r.signal_quality === 'low') {
      return { ...r, occ: 'noise', rel: null, share: null, t1_ratings: null };
    }
    const t1 = rs[0];
    const sum5 = rs.slice(0, 5).reduce((a, b) => a + b, 0);
    const share = sum5 ? t1 / sum5 : 0;
    const rel = t1 / (base[r.cc + '|' + (r.layer || 'narrow')] || 1);
    const occ = rel < 1 || t1 < 20000 ? 'unclaimed' : share >= 0.45 ? 'occupied' : 'contested';
    return {
      ...r, occ,
      rel: Number(rel.toFixed(2)),
      share: Number((share * 100).toFixed(0)),
      t1_ratings: t1,
    };
  });
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

/**
 * C. 竞品自我定位：同一竞品在不同国家把自己描述成什么。
 *
 * 数据来源是各国商店的本地化名称、品类和描述首段 —— 这是竞品自己花钱做过本地化测试后的结论，
 * 信息量比第三方推测大。典型发现：Lemon8 美区叫 "Lifestyle Community"（卖社区），
 * 日区叫「ライフスタイル情報アプリ」（卖情报/工具）。
 *
 * 只统计 bundleId 校验通过的记录，避免同名 App 污染结论。
 */
function selfPositioning(metricRows) {
  const byApp = {};
  for (const r of metricRows) {
    if (!r.listed) continue;
    (byApp[r.app] = byApp[r.app] || []).push(r);
  }
  const out = [];
  for (const [app, list] of Object.entries(byApp)) {
    // 按主品类分组，看它在不同市场被归到什么类目
    const genreGroups = {};
    const nameGroups = {};
    for (const r of list) {
      const g = r.primary_genre || '—';
      (genreGroups[g] = genreGroups[g] || []).push(r.market);
      const n = (r.local_name || '').trim();
      (nameGroups[n] = nameGroups[n] || []).push(r.market);
    }
    const genres = Object.entries(genreGroups).sort((a, b) => b[1].length - a[1].length);
    const names = Object.entries(nameGroups).sort((a, b) => b[1].length - a[1].length);
    out.push({
      app,
      app_cn: list[0].app_cn,
      markets: list.length,
      genre_variants: genres.length,
      name_variants: names.length,
      genres: genres.map(([g, ms]) => ({ genre: g, count: ms.length, markets: ms.slice(0, 6) })),
      names: names.slice(0, 6).map(([n, ms]) => ({ name: n, count: ms.length, markets: ms.slice(0, 5) })),
      // 描述差异样本：取几个代表性市场
      desc_samples: ['美国', '日本', '韩国', '印尼', '巴西', '德国']
        .map((mk) => list.find((r) => r.market === mk))
        .filter(Boolean)
        .map((r) => ({ market: r.market, local_name: r.local_name, genre: r.primary_genre, desc: (r.desc_head || '').slice(0, 150) })),
    });
  }
  return out.sort((a, b) => b.markets - a.markets);
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

/**
 * 榜单动能分析：回答「谁真的在被下载」。
 *
 * 与心智矩阵是互补的两个问题，绝不能混为一谈：
 *   mindshare = 用户搜某个需求词时会撞见谁（货架争夺，受 ASO 主导）
 *   charts    = 用户实际在下载谁（下载动能，受品牌力与买量主导）
 *
 * 这两层经常给出相反的答案，而落差本身是最有价值的信号：
 *   - 榜单高 + 搜索词缺席 → 品牌驱动型，用户直接搜品牌名，不经过需求词货架（Threads）
 *   - 搜索词占满 + 榜单不见 → ASO 驱动型，靠关键词截流但没有真实动能（各类小工具）
 *
 * ⚠️ 口径：榜单是「近期下载动能」排序，不是装机量、DAU 或市场份额。
 *    免费榜受买量投放影响很大，跨国不可直接比较榜位（各国大盘体量不同）。
 */
function chartMomentum(chartRows) {
  if (!chartRows.length) return null;

  // 1. 竞品榜位矩阵：竞品 × 市场 × 分类
  const compCells = [];
  for (const r of chartRows) {
    for (const c of r.competitors || []) {
      compCells.push({
        app: c.app,
        cc: r.cc,
        market: r.market,
        region: r.region,
        genre: r.genre,
        genre_cn: r.genre_cn,
        rank: c.rank,
        name: c.name,
      });
    }
  }

  // 2. 按竞品聚合：覆盖广度 + 最佳榜位
  const byApp = {};
  for (const c of compCells) {
    const a = (byApp[c.app] = byApp[c.app] || {
      app: c.app,
      cells: 0,
      markets: new Set(),
      regions: new Set(),
      genres: new Set(),
      best: 999,
      top10: 0,
      top3: 0,
      ranks: [],
    });
    a.cells++;
    a.markets.add(c.cc);
    a.regions.add(c.region);
    a.genres.add(c.genre_cn);
    a.best = Math.min(a.best, c.rank);
    if (c.rank <= 10) a.top10++;
    if (c.rank <= 3) a.top3++;
    a.ranks.push(c.rank);
  }
  const apps = Object.values(byApp)
    .map((a) => ({
      app: a.app,
      cells: a.cells,
      markets: a.markets.size,
      regions: a.regions.size,
      genres: [...a.genres],
      best_rank: a.best,
      top3_cells: a.top3,
      top10_cells: a.top10,
      median_rank: median(a.ranks),
    }))
    .sort((x, y) => y.markets - x.markets || x.median_rank - y.median_rank);

  // 3. 各市场社交榜头部结构：前10里有几个是社交产品
  const socialByMarket = chartRows
    .filter((r) => r.genre === '6005')
    .map((r) => ({
      cc: r.cc,
      market: r.market,
      region: r.region,
      top1: r.top1,
      social_in_top10: r.social_in_top10,
      comp_in_top10: (r.competitors || []).filter((c) => c.rank <= 10).length,
    }))
    .sort((a, b) => b.comp_in_top10 - a.comp_in_top10);

  // 4. 分类头部：每个分类里最常占据第一的产品（跨市场统计）
  const byGenre = {};
  for (const r of chartRows) {
    const g = (byGenre[r.genre] = byGenre[r.genre] || { genre: r.genre, genre_cn: r.genre_cn, top1: {}, n: 0 });
    g.n++;
    if (r.top1) g.top1[r.top1] = (g.top1[r.top1] || 0) + 1;
  }
  const genres = Object.values(byGenre)
    .map((g) => ({
      genre: g.genre,
      genre_cn: g.genre_cn,
      markets: g.n,
      leaders: Object.entries(g.top1)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, n]) => ({ name, n })),
    }))
    .sort((a, b) => a.genre_cn.localeCompare(b.genre_cn));

  return {
    date: chartRows[0]._date || null,
    rows: chartRows.length,
    comp_cells: compCells,
    apps,
    social_by_market: socialByMarket,
    genres,
  };
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * 心智层 × 榜单层交叉：找出两层结论矛盾的产品。
 * 这是本项目最有判读价值的输出 —— 单看任何一层都会得出片面结论。
 */
function crossLayer(mindScored, chart) {
  if (!chart) return null;
  // 各竞品在搜索词矩阵里的占位格数（宽窄两层合计）
  // 首位产品名在 top5[0]；用严格前缀规则避免把 TikTok Studio 之类衍生工具算进来
  const NAME_RULES = {
    threads: /^threads\b/i,
    instagram: /^instagram\b/i,
    tiktok: /^tiktok(\s*[-–—:]|\s+lite\b|$)/i,
    lemon8: /^lemon8\b/i,
    x: /^(x|twitter)$|^x\s*[-–—:(]|^twitter\b/i,
    snapchat: /^snapchat\b/i,
    bereal: /^bereal\b/i,
    pinterest: /^pinterest(\s*[-–—:(（]|$)/i,
    reddit: /^reddit\b/i,
    xiaohongshu: /^(rednote|小红书|小紅書)/i,
    bluesky: /^bluesky\b/i,
  };
  const mindByApp = {};
  for (const r of mindScored || []) {
    if (r.occ !== 'occupied' && r.occ !== 'contested') continue;
    const name = String((r.top5 && r.top5[0]) || '');
    if (!name) continue;
    for (const [key, re] of Object.entries(NAME_RULES)) {
      if (re.test(name)) {
        mindByApp[key] = (mindByApp[key] || 0) + 1;
        break;
      }
    }
  }
  return (chart.apps || []).map((a) => {
    const mindCells = mindByApp[a.app] || 0;
    let pattern;
    if (a.top10_cells >= 3 && mindCells === 0) pattern = 'brand_driven';       // 榜单强、货架无 → 品牌驱动
    else if (a.top10_cells >= 3 && mindCells > 0) pattern = 'both';            // 两层都强
    else if (a.top10_cells === 0 && mindCells > 0) pattern = 'aso_only';       // 只有货架
    else pattern = 'weak';
    return {
      app: a.app,
      chart_markets: a.markets,
      chart_best: a.best_rank,
      chart_top10: a.top10_cells,
      mind_cells: mindCells,
      pattern,
    };
  });
}

/**
 * 榜位趋势：把每天的快照拼成时间序列。
 *
 * 这是本项目第一个真正带时间维度的信号 —— 前面所有分析都是横截面（某一天的样子），
 * 只能回答「现在谁在哪」，不能回答「谁在涨、谁在掉」。而战略上后者往往更重要：
 * 一个稳定第 3 名和一个从第 30 名冲到第 3 名的产品，含义完全不同。
 *
 * 口径：
 *   - 榜位数值越小越好，所以「上升」= 数值下降，展示时统一转成「名次变化」（正数=前进）
 *   - 只在同一 (竞品 × 市场 × 分类) 内纵向对比，绝不跨市场比较
 *   - 需要至少 2 天快照才有输出；单日只返回可用天数供前端提示
 */
function chartTrend() {
  const dates = C.snapshotDates('charts');
  const rows = C.loadSnapshots('charts');
  if (!rows.length) return { dates: [], days: 0, series: [], movers: [] };

  // (app|cc|genre) -> { date -> rank }
  const track = new Map();
  for (const r of rows) {
    for (const c of r.competitors || []) {
      const k = [c.app, r.cc, r.genre].join('|');
      if (!track.has(k)) {
        track.set(k, { app: c.app, cc: r.cc, market: r.market, region: r.region, genre_cn: r.genre_cn, byDate: {} });
      }
      const t = track.get(k);
      // 同日多条取最好榜位（去重后一般只有一条）
      if (t.byDate[r._date] == null || c.rank < t.byDate[r._date]) t.byDate[r._date] = c.rank;
    }
  }

  // 竞品级别的每日汇总：各竞品当天进前 10 的市场数、总榜中位名次
  const perApp = {};
  for (const t of track.values()) {
    for (const [d, rank] of Object.entries(t.byDate)) {
      const k = t.app + '|' + d;
      const a = (perApp[k] = perApp[k] || { app: t.app, date: d, ranks: [], top10: 0, overall: [] });
      a.ranks.push(rank);
      if (rank <= 10) a.top10++;
      if (t.genre_cn === '总榜') a.overall.push(rank);
    }
  }
  const series = Object.values(perApp)
    .map((a) => ({
      app: a.app,
      date: a.date,
      markets: a.ranks.length,
      top10: a.top10,
      median_rank: median(a.ranks),
      overall_median: a.overall.length ? median(a.overall) : null,
    }))
    .sort((x, y) => x.app.localeCompare(y.app) || x.date.localeCompare(y.date));

  // 变动榜：最新一天 vs 上一天，找名次变化最大的格子
  const movers = [];
  if (dates.length >= 2) {
    const cur = dates[dates.length - 1];
    const prev = dates[dates.length - 2];
    for (const t of track.values()) {
      const a = t.byDate[prev];
      const b = t.byDate[cur];
      if (a == null || b == null) continue;
      const delta = a - b; // 正数 = 名次前进
      if (delta !== 0) {
        movers.push({ app: t.app, market: t.market, region: t.region, genre_cn: t.genre_cn, from: a, to: b, delta });
      }
    }
    movers.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  }

  return { dates, days: dates.length, series, movers: movers.slice(0, 40) };
}

function buildAll() {
  const mind = latest('mindshare');
  const metrics = latest('app_metrics');
  const allMetrics = C.loadSnapshots('app_metrics');
  const chartLatest = latest('charts');
  const mindScored = occupancyStrength(mind.rows);
  const chart = chartMomentum(chartLatest.rows);
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
    mind_scored: mindScored,
    self_positioning: selfPositioning(metrics.rows),
    charts_date: chartLatest.date,
    chart_momentum: chart,
    cross_layer: crossLayer(mindScored, chart),
    chart_trend: chartTrend(),
    snapshot_days: {
      mindshare: C.snapshotDates('mindshare'),
      charts: C.snapshotDates('charts'),
      app_metrics: C.snapshotDates('app_metrics'),
    },
  };
}

module.exports = { buildAll, latest, supplyStructure, dimensionOccupancy, appMindshareMap, regionComparison, ratingMomentum, dataHealth, occupancyStrength, selfPositioning, chartMomentum, crossLayer, chartTrend };
