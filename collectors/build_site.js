'use strict';
/**
 * 静态站点构建：读本地快照 -> 产出 docs/index.html（GitHub Pages 直接托管）
 *
 * 设计要点：
 *  1. 数据内联进 HTML，不用 fetch —— 所以 file:// 双击能打开，GitHub Pages 也不会有 CORS 问题。
 *  2. 只依赖 ECharts CDN，其余零依赖。
 *  3. 每次采集后重跑本脚本即可刷新站点，数据不是死数。
 *
 *   node collectors/build_site.js
 */
const fs = require('fs');
const path = require('path');
const C = require('../lib/core');
const A = require('../lib/analyze');

const DOCS = path.join(C.ROOT, 'docs');

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function main() {
  C.ensureDir(DOCS);
  const R = A.buildAll();
  const mind = A.latest('mindshare');
  const metrics = A.latest('app_metrics');

  // ---- 占位方类型分类 ----
  // 依据「同一个 top1 占位方横跨多少个市场」判断它是本土玩家还是国际玩家：
  // 只在 1 国出现 = 本土专属；2-5 国 = 区域玩家；≥6 国 = 国际工具；命中社交正则 = 社交产品。
  // 这个分类回答的是「进入该市场该需求，正面要对上谁」——比原来的长表更有战略含义。
  const appsCfg = require('../config/apps.json');
  const SOCIAL_RE = new RegExp(appsCfg.social_regex, 'i');
  const spread = {};
  for (const r of mind.rows) {
    const t = (r.top5 || [])[0];
    if (!t) continue;
    (spread[t] = spread[t] || new Set()).add(r.cc);
  }
  const classify = (t) => {
    if (!t) return 'none';
    if (SOCIAL_RE.test(t)) return 'social';
    const n = spread[t] ? spread[t].size : 1;
    return n >= 6 ? 'global' : n >= 2 ? 'regional' : 'local';
  };

  // ---- 品牌归一：把同一产品的跨国本地化名称合并成一个可读短名 ----
  // App Store 里同一产品在不同市场名称完全不同（Pinterest / Pinterest: Lifestyle Ideas /
  // Pinterest: Idées & Inspiration），直接按全名统计会把一个产品拆成多个。做法：
  // 先取名称在第一个分隔符前的部分做短名，再用 seller（开发者）把该开发者名下的多个短名
  // 收敛到它最高频的那个 —— seller 是同一法人的强信号，比字符串相似度稳。
  const brandRaw = (name) => {
    let b = String(name || '').split(/\s*[:：\-–—|｜(（\[]/)[0].trim();
    if (!b) b = String(name || '').trim();
    return b.length > 18 ? b.slice(0, 18) : b;
  };
  const sellerBrand = {};
  for (const r of (R.mind_scored || mind.rows)) {
    const t = (r.top5 || [])[0]; if (!t) continue;
    const sl = r.top1_seller || '?', b = brandRaw(t);
    (sellerBrand[sl] = sellerBrand[sl] || {})[b] = (sellerBrand[sl][b] || 0) + 1;
  }
  const canonMap = {};
  for (const [sl, bs] of Object.entries(sellerBrand)) {
    const top = Object.entries(bs).sort((a, b) => b[1] - a[1])[0][0];
    for (const b of Object.keys(bs)) canonMap[sl + '||' + b] = top;
  }
  const brandOf = (name, seller) => {
    if (!name) return '';
    const b = brandRaw(name);
    return canonMap[(seller || '?') + '||' + b] || b;
  };

  // ---- 压缩内联数据：只留站点需要的字段，控制体积 ----
  const mindSlim = (R.mind_scored || mind.rows).map((r) => ({
    occ: r.occ || 'noise',
    rel: r.rel,
    sh: r.share,
    t1r: r.t1_ratings,
    cls: classify((r.top5 || [])[0]),
    rg: r.region, cc: r.cc, mk: r.market, dim: r.dimension, dcn: r.dimension_cn, gp: r.group,
    tm: r.term, q: r.signal_quality, sr: r.social_top_rank, sn: r.social_top_name,
    t1: (r.top5 || [])[0] || '', t2: (r.top5 || [])[1] || '', t3: (r.top5 || [])[2] || '',
    sl: r.top1_seller || '',
    bd: brandOf((r.top5 || [])[0], r.top1_seller),
  }));

  // ---- 产品视角聚合：每个占位方占了哪些心智、哪些市场 ----
  // 只统计判定为 occupied / contested 的格子 —— unclaimed 的首位产品体量不足，
  // 把它算成「占据」会严重高估。
  const holderAgg = {};
  for (const r of mindSlim) {
    if (r.occ !== 'occupied' && r.occ !== 'contested') continue;
    if (!r.bd) continue;
    const h = (holderAgg[r.bd] = holderAgg[r.bd] || {
      brand: r.bd, cells: 0, occupied: 0, contested: 0,
      dims: {}, markets: {}, regions: {}, cls: r.cls, names: {},
    });
    h.cells++; h[r.occ]++;
    h.dims[r.dcn] = (h.dims[r.dcn] || 0) + 1;
    h.markets[r.mk] = (h.markets[r.mk] || 0) + 1;
    h.regions[r.rg] = (h.regions[r.rg] || 0) + 1;
    h.names[r.t1] = (h.names[r.t1] || 0) + 1;
  }
  const holders = Object.values(holderAgg).map((h) => ({
    bd: h.brand, n: h.cells, oc: h.occupied, ct: h.contested,
    cls: h.cls,
    dn: Object.keys(h.dims).length, mn: Object.keys(h.markets).length,
    dims: Object.entries(h.dims).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ d: k, n: v })),
    mks: Object.entries(h.markets).sort((a, b) => b[1] - a[1]).map(([k]) => k),
    rgs: Object.entries(h.regions).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ r: k, n: v })),
  })).sort((a, b) => b.n - a.n || b.mn - a.mn);

  // ---- 品牌配色：只给占位 ≥3 格的品牌独立色，其余归为「单点占位」 ----
  // 理由：86 个占位方全给独立色会让色彩失去信息量（相邻色无法分辨）。
  // 占 ≥3 格的 16 个品牌覆盖 93/175 格，是版图的主要构成；1-2 格的用统一弱色，
  // 视觉上自然退到背景，让「谁横扫了多个市场」成为第一眼信息。
  // 优先用品牌真实识别色（Pinterest 红 / Snapchat 黄 / Tinder 粉），其余用高区分补充色。
  const BRAND_COLORS = {
    'Pinterest':         '#E60023',
    'Snapchat':          '#F7B500',
    'Bumble':            '#00838F',
    'Tinder Dating App': '#FE3C72',
    'Instagram':         '#C13584',
    'DramaBox':          '#7B4DFF',
    'ReelShort':         '#9B6BFF',
    'Temu':              '#FF6B00',
    'AliExpress Shoppin':'#FF4747',
    'Google News':       '#4285F4',
    'Apple News':        '#2D6FE0',
    'Nextdoor':          '#00B551',
    'Tripadvisor':       '#00A680',
    'OpenTable':         '#1FA98C',
    'Tasty':             '#7CB342',
    'Simply Draw':       '#8C6FE0',
    'Kwai':              '#FF7A00',
    'Likee':             '#FF3E6C',
    'CapCut':            '#4D9EFF',
    'Houzz':             '#5CB85C',
    'FamilyAlbum':       '#3DBFA8',
    'Yubo':              '#FF5C8A',
    'Badoo':             '#C74DFF',
    'happn':             '#FF4D6D',
    'Omi':               '#E05CB8',
    'スマートニュース':    '#3B72D9',
    'クラシル':           '#00B37E',
  };
  const PALETTE = ['#E60023','#F7B500','#7B4DFF','#00B551','#FF6B00','#4285F4','#FE3C72','#00C2A8',
                   '#C13584','#9B6BFF','#FF7A00','#1FA98C','#2D6FE0','#8C6FE0','#FF3E6C','#5CB85C'];
  const MINOR_COLOR = '#9aa6c4'; // 1-2 格的单点占位
  // 门槛设在 5 格：≥5 格的 8 个品牌覆盖 64 格，是版图主干；
  // 3-4 格的中间层归入长尾，避免 16 种颜色互相干扰导致整张图杂乱。
  const COLOR_MIN_CELLS = 5;
  const brandColor = {};
  let pi = 0;
  for (const h of holders) {
    if (h.n < COLOR_MIN_CELLS) continue;
    brandColor[h.bd] = BRAND_COLORS[h.bd] || PALETTE[pi++ % PALETTE.length];
  }
  const brandLegend = holders.filter((h) => h.n >= COLOR_MIN_CELLS)
    .map((h) => ({ bd: h.bd, c: brandColor[h.bd], n: h.n, mn: h.mn }));
  const metricSlim = metrics.rows.filter((r) => r.listed).map((r) => ({
    app: r.app, cn: r.app_cn, rg: r.region, cc: r.cc, mk: r.market,
    rc: r.rating_count, ra: r.rating_avg, v: r.version, vd: (r.version_release_date || '').slice(0, 10),
    ln: r.local_name, g: r.primary_genre,
  }));

  const DATA = {
    generated_at: R.generated_at,
    mindshare_date: R.mindshare_date,
    metrics_date: R.metrics_date,
    health: R.health,
    apps: R.app_mindshare,
    dims: R.dimension_occupancy,
    regions: R.region_comparison,
    markets: R.supply_structure,
    momentum: R.rating_momentum,
    positioning: (R.self_positioning || []).map(function(p){ return {
      app:p.app, cn:p.app_cn, mk:p.markets, gv:p.genre_variants, nv:p.name_variants,
      genres:p.genres.slice(0,5), names:p.names.slice(0,5), samples:p.desc_samples }; }),
    mind: mindSlim,
    metrics: metricSlim,
    holders: holders,
    dimGroups: (function () {
      // 展示用的粗粒度分组：config 里的 group 字段有 10 个值、其中 6 个只含 1 个维度，
      // 分组等于没分。这里合成 4 个粗类，让分割线真正划出有战略含义的区块：
      // 社交关系 / 内容消费 / 生活决策（小红书主场，刻意放在一起看空白）/ 消费决策。
      const MACRO = [
        { g: '社交关系', dims: ['chat_friends', 'dating', 'local_community'] },
        { g: '内容消费', dims: ['short_video', 'share_photos', 'news_public'] },
        { g: '生活决策', dims: ['discover_inspiration', 'recipes', 'home_decor', 'travel_plan',
                              'restaurant', 'beauty_skincare', 'fitness', 'learn_howto'] },
        { g: '消费决策', dims: ['shopping_deals', 'product_review'] },
      ];
      const known = new Set(MACRO.flatMap((m) => m.dims));
      const all = R.dimension_occupancy.map((d) => d.dimension);
      const groups = MACRO
        .map((m) => ({ g: m.g, dims: m.dims.filter((d) => all.includes(d)) }))
        .filter((m) => m.dims.length);
      const rest = all.filter((d) => !known.has(d));
      if (rest.length) groups.push({ g: '其他', dims: rest });
      return groups;
    })(),
    brandColor: brandColor,
    brandLegend: brandLegend,
    minorColor: MINOR_COLOR,
  };

  const kpiSocialTotal = R.app_mindshare.reduce((s, a) => s + a.total_placements, 0);
  const topApp = R.app_mindshare[0] || { app: '—', total_placements: 0, market_count: 0 };
  const threads = R.app_mindshare.find((a) => a.app === 'threads');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>海外竞品心智监控看板</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%234D7EFF'/%3E%3Cpath d='M8 21V13M14 21V9M20 21V16M26 21V11' stroke='white' stroke-width='2.6' stroke-linecap='round'/%3E%3C/svg%3E">
<script src="https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"></script>
<style>
:root{
  --bg:#f4f6fb; --card:#fff; --ink:#1a2340; --ink2:#4a5a8a; --ink3:#8b97b8;
  --line:#e6ebf5; --primary:#4D7EFF; --purple:#7B61FF; --teal:#00d4aa;
  --sep-col:#ccd6ea; --sep-row:#aab8d4;
  --amber:#F0A500; --red:#e05c5c; --shadow:0 1px 3px rgba(26,35,64,.06),0 8px 24px rgba(26,35,64,.05);
}
@media (prefers-color-scheme:dark){
  :root{ --bg:#0f1420; --card:#181f30; --ink:#e8ecf5; --ink2:#a3b0cc; --ink3:#6b78a0;
    --line:#26304a; --sep-col:#39456580; --sep-row:#4a5878;
    --shadow:0 1px 3px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.25); }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px 64px}
header{background:linear-gradient(135deg,#4D7EFF,#7B61FF);color:#fff;padding:38px 0 30px;margin-bottom:22px}
header .wrap{padding-bottom:0}
h1{margin:0 0 6px;font-size:26px;font-weight:650;letter-spacing:-.3px}
.sub{opacity:.9;font-size:13.5px;margin-bottom:18px}
.tag{display:inline-block;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.28);
  border-radius:99px;padding:3px 12px;font-size:12px;margin-bottom:14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kpi{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.2);border-radius:10px;padding:12px 14px}
.kpi .v{font-size:22px;font-weight:650;letter-spacing:-.5px}
.kpi .l{font-size:12px;opacity:.88;margin-top:2px}
.kpi .d{font-size:11px;opacity:.7;margin-top:3px}
h2{font-size:18px;margin:30px 0 4px;font-weight:620;display:flex;align-items:center;gap:8px}
h2::before{content:'';width:3px;height:16px;background:var(--primary);border-radius:2px}
.h2sub{color:var(--ink3);font-size:12.5px;margin:0 0 14px 11px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;box-shadow:var(--shadow);margin-bottom:16px}
.chart{width:100%;height:320px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;min-width:0}
.grid2 > *{min-width:0}
.card{min-width:0}
.chart{min-width:0}
.note{border-left:3px solid var(--amber);background:rgba(240,165,0,.07);padding:12px 14px;border-radius:0 8px 8px 0;font-size:13.5px;color:var(--ink2);margin-bottom:16px}
.note b{color:var(--ink)}
.note.info{border-color:var(--primary);background:rgba(77,126,255,.07)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:9px 10px;color:var(--ink3);font-weight:600;font-size:11.5px;
  text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--line);color:var(--ink2)}
tbody tr:hover{background:rgba(77,126,255,.04)}
td b{color:var(--ink);font-weight:600}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11.5px;font-weight:600}
.p-ok{background:rgba(0,212,170,.14);color:#00a383}
.p-med{background:rgba(240,165,0,.16);color:#c98600}
.p-low{background:rgba(224,92,92,.14);color:#c94b4b}
.p-blue{background:rgba(77,126,255,.14);color:var(--primary)}
.mx{border-collapse:separate;border-spacing:2px;font-size:11px}
.mx th{padding:4px 5px;font-size:10px;text-transform:none;letter-spacing:0;border:0;
  writing-mode:vertical-rl;text-orientation:mixed;height:92px;vertical-align:bottom;color:var(--ink3);font-weight:600}
.mx th.corner{writing-mode:horizontal-tb;height:92px;vertical-align:bottom;white-space:nowrap;
  padding-bottom:6px;position:sticky;left:0;background:var(--card);z-index:2}
.mx td{padding:0;border:0}
.mx .mk{padding:3px 9px 3px 4px;white-space:nowrap;font-size:11.5px;color:var(--ink2);border:0;
  position:sticky;left:0;background:var(--card);z-index:1}
.mx .rgrow .rg{padding:9px 4px 3px;font-size:10.5px;font-weight:700;color:var(--ink3);
  letter-spacing:.6px;text-align:left;position:sticky;left:0;background:var(--card)}
.cl{width:26px;height:22px;border-radius:3px;display:flex;align-items:center;justify-content:center;
  font-size:10px;font-weight:600;color:#fff;cursor:default;transition:transform .1s}
.cl:hover{transform:scale(1.22);position:relative;z-index:3;box-shadow:0 2px 8px rgba(0,0,0,.18)}
/* 未占据的格子刻意做成极浅的斜纹底：既不抢眼，又和「有数据但弱」区分开 */
.cl.e{background:repeating-linear-gradient(45deg,var(--line),var(--line) 3px,transparent 3px,transparent 6px);
  color:var(--ink3);opacity:.55}
.cl.nm{width:74px;padding:0 4px;justify-content:flex-start;height:24px;border-radius:4px;
  box-shadow:inset 0 -2px 0 rgba(0,0,0,.14)}
.cl.nm > span{display:block;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:10px;font-weight:700;letter-spacing:-.1px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.25)}
.cl.nm:hover{transform:none;width:auto;min-width:74px;box-shadow:0 3px 10px rgba(0,0,0,.22);z-index:4}
.cl.nm:hover > span{overflow:visible;text-overflow:clip}
.mx.named{border-spacing:2px}
.mx.named .cl.e{height:24px;border-radius:4px}
.mx.named th{height:84px;padding-bottom:5px}
.mx.named th.corner{height:84px}
.mx th.corner .csub{writing-mode:horizontal-tb;font-size:9.5px;font-weight:400;color:var(--ink3);margin-top:2px}
/* 大类分组行：横排标签 + 底部细线界定范围 */
.mx .grow td{padding:0 0 4px;border:0;vertical-align:bottom}
.mx .grow .gcorner{position:sticky;left:0;background:var(--card);z-index:2}
.mx .grow .gh{text-align:center}
.mx .grow .gh span{display:inline-block;font-size:11px;font-weight:700;color:var(--ink2);
  letter-spacing:.3px;padding:0 4px 3px;border-bottom:2px solid var(--line);width:calc(100% - 6px);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 竖分割线（心智大类）：偏冷的实线，和区域线区分层级 */
.mx th.gsep, .mx td.gsep{border-left:2px solid var(--sep-col)!important;padding-left:6px}
.mx .grow .gh + .gh{padding-left:4px}
/* 横分割线（区域）：更重，带区域名，作为一级分组 */
.mx .rgrow td.rg{border-top:2.5px solid var(--sep-row);padding-top:11px}
.mx .rgrow.first td.rg{border-top:0;padding-top:3px}
/* 搜索词行：横排在列头下方，让每列口径可直读 */
.mx .trow td{padding:0 2px 5px;border:0;vertical-align:top}
.mx .trow .tcorner{position:sticky;left:0;background:var(--card);z-index:2;white-space:nowrap;
  font-size:9.5px;color:var(--ink3);padding:0 9px 5px 4px;text-align:right}
.mx .trow .tm > span{display:block;max-width:74px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:9px;color:var(--primary);opacity:.9;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.mx3 .cl{width:30px}
.mx3 th{height:70px}
.mx3 th.corner{height:70px}
.mx3 .hd{max-width:150px;overflow:hidden;text-overflow:ellipsis;font-weight:600;font-size:11px}
.mx3 .tot{writing-mode:horizontal-tb;height:auto;padding:3px 6px;font-size:11px;color:var(--ink3);
  text-align:center;font-weight:600;vertical-align:middle}
.mx2 .cl{width:24px}
.mx2 th{height:82px}
.mx2 th.corner{height:82px}
.ctrl{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
.ctrlhint{font-size:11.5px;color:var(--ink3)}
select,input{background:var(--card);color:var(--ink);border:1px solid var(--line);
  border-radius:8px;padding:7px 10px;font-size:13px;font-family:inherit}
input{flex:1;min-width:160px}
.foot{color:var(--ink3);font-size:12px;text-align:center;margin-top:34px;padding-top:18px;border-bottom:0;border-top:1px solid var(--line)}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--ink3);margin-top:10px}
.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:5px;vertical-align:-2px}
.legend{font-size:12px}
.note.src{background:rgba(77,126,255,.07);border-left:3px solid var(--primary)}
.note.warn{background:rgba(224,135,0,.08);border-left:3px solid #e08700}
.note code{background:rgba(127,127,127,.14);padding:1px 5px;border-radius:4px;font-size:12px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
ul.tight{margin:6px 0 0;padding-left:20px;font-size:13.5px;color:var(--ink2)}
ul.tight li{margin-bottom:5px}
ul.tight b{color:var(--ink)}
@media(max-width:560px){
  .wrap{padding:0 14px 48px}
  h1{font-size:21px}
  .kpis{grid-template-columns:1fr 1fr;gap:8px}
  .kpi{padding:10px 11px}
  .kpi .v{font-size:18px}
  .chart{height:280px!important}
  .card{padding:13px}
  .ctrl{flex-direction:column}
  .ctrl select,.ctrl input{width:100%}
}
</style>
</head>
<body>
<header><div class="wrap">
  <div class="tag">数据日期 ${esc(R.mindshare_date || '—')} · 每日采集 · 自动重建</div>
  <h1>海外竞品心智监控看板</h1>
  <div class="sub">10 大区 ${DATA.markets.length} 国 × ${DATA.dims.length} 心智维度 · Apple App Store 公开接口实测采集</div>
  <div class="kpis">
    <div class="kpi"><div class="v">${R.health.mindshare_rows}</div><div class="l">心智观测格子</div><div class="d">市场 × 维度</div></div>
    <div class="kpi"><div class="v">${kpiSocialTotal}</div><div class="l">社交产品占位次数</div><div class="d">进入需求词前 10</div></div>
    <div class="kpi"><div class="v">${esc(topApp.app)}</div><div class="l">占位最广竞品</div><div class="d">${topApp.total_placements} 次 · ${topApp.market_count} 国</div></div>
    <div class="kpi"><div class="v">${threads ? threads.total_placements : 0}</div><div class="l">Threads 占位次数</div><div class="d">生活决策入口</div></div>
    <div class="kpi"><div class="v">${R.health.mindshare_usable_pct}%</div><div class="l">信号可用率</div><div class="d">已剔除游戏噪声</div></div>
    <div class="kpi"><div class="v">${R.health.history_days}</div><div class="l">已积累快照天数</div><div class="d">${R.health.trend_ready ? '趋势已就绪' : '趋势需 ≥2 天'}</div></div>
  </div>
</div></header>

<div class="wrap">

<div class="note"><b>先读口径。</b>本看板测量的是「某需求词在该国 App Store 内的搜索结果排序」，受商店文案关键词匹配度主导。综合社交产品的商店描述通常不写 "recipes"，因此在生活决策词下天然搜不出来。<b>「社交产品缺席某需求词」不等于「用户心智里它不承担该需求」</b>——真实情况可能是用户做饭时确实先打开 TikTok，但商店搜 recipes 搜不到它。正确用途是跨国比较供给结构与纵向监测占位变化；不能用于推断 DAU、留存或使用时长。</div>

<h2>竞品心智版图</h2>
<p class="h2sub">占位次数 = 在多少个（市场 × 维度）格子的前 10 名中出现</p>
<div class="card"><div id="c_apps" class="chart"></div></div>

<h2>心智维度占位格局</h2>
<p class="h2sub">社交产品占位率越低，说明该需求越是垂类工具的地盘</p>
<div class="card"><div id="c_dims" class="chart" style="height:400px"></div></div>

<h2>区域壁垒对比</h2>
<p class="h2sub">入口集中度 = 同一供给方在多个需求入口占据首位的比例；数值高说明少数玩家形成跨场景垄断，进入需正面击败</p>
<div class="grid2">
  <div class="card"><div id="c_region" class="chart"></div></div>
  <div class="card"><div id="c_regionbar" class="chart"></div></div>
</div>

<h2>需求词搜索结果 · 各市场首位产品</h2>
<p class="h2sub">在每个国家的 App Store 用当地语言搜一个需求词，格内＝搜出来排第一的产品（搜索词见下方灰字行）</p>
<div class="note warn"><b>不是市场份额。</b>排名由商店文案关键词匹配度决定，已成品类代名词的产品会缺席 —— TikTok 搜「short videos」在 41 国全部不是第一（它文案不写这个词），但搜 <code>tiktok</code> 稳居第一。空白格＝没有强势产品抢这个词，<b>不等于市场空位</b>。</div>
<div class="card">
  <div class="ctrl">
    <select id="m1_mode" style="display:none"><option value="brand">brand</option></select>
    <select id="m1_region"><option value="">全部区域</option></select>
    <span class="ctrlhint">同色＝同一产品，只给占位 ≥5 格的产品配色，其余归为单点占位</span>
  </div>
  <div class="scroll"><div id="mx1"></div></div>
  <div class="legend" id="lg1"></div>
</div>

<h2>竞品市场重心矩阵</h2>
<p class="h2sub">每格为该竞品评分数在该市场的占比（按竞品自身全球总量归一化）—— 深色即其用户盘所在</p>
<div class="note info" style="margin:0 0 14px">刻意<b>按每个竞品自身归一化</b>，不做跨竞品绝对值对比：评分转化率在不同产品间差异巨大，横向比绝对值会得出错误结论。同一行内可比，跨行只看形态不看深浅。</div>
<div class="card">
  <div class="scroll"><div id="mx2"></div></div>
  <div class="legend" id="lg2"></div>
</div>

<h2>谁占了什么 · 产品视角</h2>
<p class="h2sub">把上面矩阵按产品重新聚合：每个占位方拿下了哪些心智、哪些市场</p>
<div class="card">
  <div class="ctrl">
    <select id="h_scope">
      <option value="all">全部占位方</option>
      <option value="multi">跨 ≥3 市场的占位方</option>
      <option value="social">仅社交/内容产品</option>
    </select>
    <input id="h_q" placeholder="搜产品名，如 Pinterest / Snapchat">
  </div>
  <div class="scroll"><div id="mx_h"></div></div>
  <div class="legend" id="lg_h"></div>
</div>

<h2>竞品自我定位差异</h2>
<p class="h2sub">同一个竞品在不同国家把自己描述成什么 —— 这是它自己做过本地化测试后的结论，比第三方推测可信</p>
<div class="note info">仅统计 bundleId 校验通过的记录。同名 App 会严重污染这类分析：实测 Lemon8 曾在 16 国被匹配成同名聊天应用、墨西哥被匹配成 TikTok，已改用 bundleId 锚定正主。</div>
<div class="card">
  <div class="ctrl"><select id="p_app"></select></div>
  <div id="pos_genre" style="margin-bottom:14px"></div>
  <div id="pos_desc"></div>
</div>

<h2>明细数据</h2>
<p class="h2sub">矩阵看格局，明细用于查具体某格是谁</p>
<details class="card" style="padding:14px 18px">
  <summary style="cursor:pointer;font-size:14px;font-weight:600;color:var(--ink)">展开需求入口明细（630 行，可筛选搜索）</summary>
  <div style="margin-top:14px">
  <div class="ctrl">
    <select id="f_region"><option value="">全部区域</option></select>
    <select id="f_dim"><option value="">全部维度</option></select>
    <input id="f_kw" placeholder="搜索市场、占位产品…">
  </div>
  <div class="scroll"><table id="t_mind">
    <thead><tr><th>市场</th><th>区域</th><th>维度</th><th>首位占位</th><th>社交最高排名</th><th>信号</th></tr></thead>
    <tbody></tbody>
  </table></div>
  <div id="t_count" style="color:var(--ink3);font-size:12px;margin-top:10px"></div>
  </div>
</details>
<details class="card" style="padding:14px 18px">
  <summary style="cursor:pointer;font-size:14px;font-weight:600;color:var(--ink)">展开竞品指标明细（418 行，评分数/版本/发版日）</summary>
  <div style="margin-top:14px">
  <div class="ctrl">
    <select id="f_app"><option value="">全部竞品</option></select>
    <input id="f_mkw" placeholder="搜索市场…">
  </div>
  <div class="scroll"><table id="t_met">
    <thead><tr><th>竞品</th><th>市场</th><th>本地化名称</th><th>评分数</th><th>均分</th><th>版本</th><th>最近发版</th></tr></thead>
    <tbody></tbody>
  </table></div>
  <div id="m_count" style="color:var(--ink3);font-size:12px;margin-top:10px"></div>
  </div>
</details>

<h2>方法局限</h2>
<div class="card">
  <ul class="tight">
    <li><b>小样本极易产生假结论。</b>首轮用 6 市场 × 6 维度曾得出「社交产品在生活决策领域系统性缺席」，扩到 ${DATA.markets.length} 国 × ${DATA.dims.length} 维度后被推翻。判读前务必确认样本覆盖度。</li>
    <li><b>部分语言需求词匹配质量差。</b>泰语「ร้านอาหาร」(餐厅) 会搜出 My Hot Pot Story 等游戏。低质格子已标记 <span class="pill p-low">low</span>，判读时应剔除。</li>
    <li><b>同一 App 跨国 ID 不同。</b>TikTok 美区 835599320、日本/印尼 1235601864。用错 ID 会返回「无上架」——数据错了但不报错，是最危险的失败模式。采集器已强制按国家解析并校验正主。</li>
    <li><b>DAU 与播放量无公开一手源。</b>Threads 与 Instagram 均不公开分国家日活，第三方数字皆为模型推算。本看板刻意不含这两项，避免用排名替代量级做判断。</li>
    <li><b>本数据只是雷达。</b>发现异动后仍需 Reddit 讨论、用户调研等定性证据确认心智归属。</li>
  </ul>
</div>

<div class="foot">
  构建时间 ${esc(R.generated_at)}　·　数据源 Apple App Store 公开接口<br>
  每次运行 <code>node collectors/build_site.js</code> 重建本页
</div>
</div>

<script>
var D = ${JSON.stringify(DATA)};
var isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme:dark)').matches;
var INK = isDark ? '#a3b0cc' : '#4a5a8a', LINE = isDark ? '#26304a' : '#e6ebf5';
var BASE = { textStyle:{ fontFamily:'-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif' } };
function axis(extra){ return Object.assign({ axisLine:{lineStyle:{color:LINE}}, axisLabel:{color:INK,fontSize:11},
  splitLine:{lineStyle:{color:LINE,type:'dashed'}} }, extra||{}); }
function mk(id, opt){ try{ var el=document.getElementById(id); if(!el) return;
  var c=echarts.init(el); c.setOption(Object.assign({}, BASE, opt));
  window.addEventListener('resize', function(){ c.resize(); }); }catch(e){ console.error('[chart]'+id, e); } }

// 1. 竞品占位
(function(){
  var d = D.apps.filter(function(a){ return a.app && a.total_placements>0; }).slice(0,12).reverse();
  mk('c_apps', {
    grid:{left:96,right:56,top:14,bottom:24},
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},
      formatter:function(p){var a=d[p[0].dataIndex];return '<b>'+a.app+'</b><br>占位 '+a.total_placements+' 次<br>覆盖 '+a.market_count+' 国 · '+a.dimension_count+' 维度';}},
    xAxis: axis({type:'value'}),
    yAxis: axis({type:'category', data:d.map(function(a){return a.app}), splitLine:{show:false}}),
    series:[{type:'bar', data:d.map(function(a){return {value:a.total_placements,
        itemStyle:{color:a.total_placements>=25?'#4D7EFF':a.total_placements>=10?'#7B61FF':'#a78bfa',
        borderRadius:[0,4,4,0]}}}),
      barWidth:'62%', label:{show:true,position:'right',color:INK,fontSize:11,
        formatter:function(p){return d[p.dataIndex].market_count+'国'}}}]
  });
})();

// 2. 维度占位
(function(){
  var d = D.dims.slice().reverse();
  mk('c_dims', {
    grid:{left:110,right:64,top:14,bottom:24},
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},
      formatter:function(p){var x=d[p[0].dataIndex];
        return '<b>'+x.dimension_cn+'</b><br>社交占位率 '+x.social_occupancy_pct+'%<br>'+
        (x.top_social.length?'主要玩家 '+x.top_social.slice(0,2).join('、'):'无社交产品占位');}},
    xAxis: axis({type:'value', max:100, axisLabel:{color:INK,fontSize:11,formatter:'{value}%'}}),
    yAxis: axis({type:'category', data:d.map(function(x){return x.dimension_cn}), splitLine:{show:false}}),
    series:[{type:'bar', data:d.map(function(x){return {value:x.social_occupancy_pct,
        itemStyle:{color:x.social_occupancy_pct>=50?'#00d4aa':x.social_occupancy_pct>=25?'#4D7EFF':x.social_occupancy_pct>=10?'#7B61FF':'#e05c5c',
        borderRadius:[0,4,4,0]}}}),
      barWidth:'60%', label:{show:true,position:'right',color:INK,fontSize:11,formatter:'{c}%'}}]
  });
})();

// 3. 区域散点：集中度 vs 社交占位率
(function(){
  mk('c_region', {
    title:{text:'壁垒结构定位',left:'center',top:2,textStyle:{fontSize:13,color:INK,fontWeight:600}},
    grid:{left:52,right:26,top:44,bottom:44},
    tooltip:{formatter:function(p){var r=D.regions[p.dataIndex];
      return '<b>'+r.region+'</b><br>入口集中度 '+r.concentration_pct+'%<br>社交占位率 '+r.social_occupancy_pct+'%<br>观测 '+r.observations+' 格';}},
    xAxis: axis({type:'value', name:'入口集中度 %', nameLocation:'middle', nameGap:26, nameTextStyle:{color:INK,fontSize:11}}),
    yAxis: axis({type:'value', name:'社交占位率 %', nameTextStyle:{color:INK,fontSize:11}}),
    series:[{type:'scatter', symbolSize:14,
      data:D.regions.map(function(r){return {value:[r.concentration_pct,r.social_occupancy_pct],
        itemStyle:{color:r.concentration_pct>=50?'#e05c5c':r.concentration_pct>=35?'#F0A500':'#00d4aa'}}}),
      label:{show:true,position:'top',color:INK,fontSize:10,
        formatter:function(p){return D.regions[p.dataIndex].region}}}]
  });
})();

// 4. 区域集中度条形
(function(){
  var d = D.regions.slice().reverse();
  mk('c_regionbar', {
    title:{text:'入口集中度排序',left:'center',top:2,textStyle:{fontSize:13,color:INK,fontWeight:600}},
    grid:{left:66,right:52,top:44,bottom:24},
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'}},
    xAxis: axis({type:'value', axisLabel:{color:INK,fontSize:11,formatter:'{value}%'}}),
    yAxis: axis({type:'category', data:d.map(function(r){return r.region}), splitLine:{show:false}}),
    series:[{type:'bar', data:d.map(function(r){return {value:r.concentration_pct,
        itemStyle:{color:r.concentration_pct>=50?'#e05c5c':r.concentration_pct>=35?'#F0A500':'#00d4aa',
        borderRadius:[0,4,4,0]}}}),
      barWidth:'58%', label:{show:true,position:'right',color:INK,fontSize:11,formatter:'{c}%'}}]
  });
})();

// 共享：心智维度序列与中文名（矩阵一 / 产品视角矩阵共用）
var dimCn = {}; D.dims.forEach(function(d){ dimCn[d.dimension]=d.dimension_cn; });
// 列顺序按业务大类重排，使同类心智相邻，分割线才有语义
var dims=[], dimGroup={}, groupFirst={}, groupSpan=[];
(D.dimGroups||[{g:'全部',dims:D.dims.map(function(d){return d.dimension})}]).forEach(function(g){
  groupSpan.push({g:g.g, n:g.dims.length});
  g.dims.forEach(function(d,i){ dims.push(d); dimGroup[d]=g.g; if(i===0) groupFirst[d]=true; });
});

// 5. 矩阵一：需求入口归属
(function(){
  var box={}, regionOf={};
  D.mind.forEach(function(r){ if(!box[r.mk]){ box[r.mk]={}; regionOf[r.mk]=r.rg; } box[r.mk][r.dim]=r; });
  // 按区域分组排序：区域内按社交占位率降序，让同区域市场相邻，便于横向比较
  var rgSeq=[]; D.markets.forEach(function(m){ if(rgSeq.indexOf(m.region)<0) rgSeq.push(m.region); });
  var rank={}; D.markets.forEach(function(m,i){ rank[m.market]=i; });
  var order = Object.keys(box).sort(function(a,b){
    var d = rgSeq.indexOf(regionOf[a]) - rgSeq.indexOf(regionOf[b]);
    if(d) return d;
    return (rank[a]==null?999:rank[a]) - (rank[b]==null?999:rank[b]);
  });

  var sel=document.getElementById('m1_mode'), selR=document.getElementById('m1_region'), lg=document.getElementById('lg1');
  var regions=[]; D.markets.forEach(function(m){ if(regions.indexOf(m.region)<0) regions.push(m.region); });
  regions.forEach(function(r){ selR.innerHTML += '<option>'+r+'</option>'; });

  var OCC = {
    occupied: {c:'#0b7a5d', t:'占住', d:'首位体量大且领先第二名 ≥45%'},
    contested:{c:'#e08700', t:'争夺中', d:'有大玩家但格局未定'},
    unclaimed:{c:'', t:'未见强占位', d:'首位体量低于本市场中位（≠空位）'},
    noise:    {c:'', t:'信号不可用', d:'该词搜索结果无效'}
  };
  var TYPE = {
    local:   {c:'#0d9488', t:'本土专属', d:'仅 1 国出现，本地玩家'},
    regional:{c:'#4D7EFF', t:'区域玩家', d:'2-5 国出现'},
    global:  {c:'#F0A500', t:'国际工具', d:'≥6 国出现'},
    social:  {c:'#7B61FF', t:'社交产品', d:'社交/内容社区占首位'},
    none:    {c:'', t:'无数据', d:'该词无有效结果'}
  };
  function rankColor(r){ return !r?'':r<=2?'#0d9488':r<=4?'#4D7EFF':r<=6?'#7B61FF':'#a78bfa'; }

  function render(){
    var mode=sel.value, rg=selR.value;
    var list = order.filter(function(m){ return box[m] && (!rg || regionOf[m]===rg); });
    var named=(mode==='occ'||mode==='brand');
    var h='<table class="mx'+(named?' named':'')+'"><thead>';
    // 大类分组行：让 16 列有语义结构
    h+='<tr class="grow"><td class="gcorner"></td>';
    groupSpan.forEach(function(g){ h+='<td class="gh" colspan="'+g.n+'"><span>'+g.g+'</span></td>'; });
    h+='</tr>';
    h+='<tr><th class="corner">市场<div class="csub">格内＝首位产品</div></th>';
    var terms={};
    dims.forEach(function(d){
      // 该维度在当前筛选市场里最常用的搜索词，用于列头 title 与下方口径行
      var tc={}; list.forEach(function(m){ var rr=box[m]&&box[m][d]; if(rr&&rr.tm) tc[rr.tm]=(tc[rr.tm]||0)+1; });
      var tw=Object.entries(tc).sort(function(a,b){return b[1]-a[1]})[0];
      terms[d]=tw?tw[0]:'';
      h+='<th class="'+(groupFirst[d]?'gsep':'')+'" title="'+dimCn[d]+(tw?' · 搜索词：'+tw[0]:'')+'">'+dimCn[d]+'</th>';
    });
    h+='</tr>';
    if(named){
      h+='<tr class="trow"><td class="tcorner">搜索词</td>';
      dims.forEach(function(d){ h+='<td class="tm'+(groupFirst[d]?' gsep':'')+'" title="'+(terms[d]||'')+'"><span>'+String(terms[d]||'—').replace(/</g,'&lt;')+'</span></td>'; });
      h+='</tr>';
    }
    h+='</thead><tbody>';
    var curRg='';
    list.forEach(function(m){
      if(!rg && regionOf[m]!==curRg){ var firstRg=(curRg===''); curRg=regionOf[m];
        h+='<tr class="rgrow'+(firstRg?' first':'')+'"><td class="rg" colspan="'+(dims.length+1)+'">'+curRg+'</td></tr>'; }
      h+='<tr><td class="mk">'+m+'</td>';
      dims.forEach(function(d){
        var r=box[m][d], col='', txt='', tip=m+' · '+dimCn[d];
        if(!r){ tip+=' · 无数据'; }
        else if(mode==='brand'){
          var o2=r.occ||'noise';
          if(o2==='occupied'||o2==='contested'){
            col = D.brandColor[r.bd] || D.minorColor;
            txt = r.bd||'';
          }
          tip = m+' · '+dimCn[d]+'\\n搜索词：'+(r.tm||'—')
              + '\\n首位：'+(r.t1||'—')
              + (r.t1r!=null?'（'+(r.t1r>=1000?(r.t1r/1000).toFixed(0)+'k':r.t1r)+' 评分）':'')
              + '\\n判定：'+OCC[o2].t
              + (r.bd&&D.brandColor[r.bd]?'\\n该产品共占 '+(function(){var x=D.holders.filter(function(z){return z.bd===r.bd})[0];return x?x.n+' 格 / '+x.mn+' 国':'—'})():'');
        }
        else if(mode==='occ'){
          var o=r.occ||'noise'; col=OCC[o].c;
          txt = (o==='occupied'||o==='contested') ? (r.bd||'') : '';
          tip = m+' · '+dimCn[d]+'\\n搜索词：'+(r.tm||'—')+'\\n判定：'+OCC[o].t
              + (r.t1r!=null?'（首位 '+(r.t1r>=1000?(r.t1r/1000).toFixed(0)+'k':r.t1r)+' 评分'+(r.sh!=null?'，领先 '+r.sh+'%':'')+'）':'')
              + '\\n搜索结果 #1 '+(r.t1||'—') + (r.t2?'\\n　　　　 #2 '+r.t2:'') + (r.t3?'\\n　　　　 #3 '+r.t3:'')
              + (r.q!=='ok'?'\\n⚠ 信号质量：'+r.q:'');
        }
        else if(mode==='type'){
          var t=r.cls||'none'; col=TYPE[t].c; txt=t==='none'?'':TYPE[t].t.charAt(0);
          tip+=' · '+TYPE[t].t+(r.t1?' · '+r.t1:'');
        } else {
          col=rankColor(r.sr); txt=r.sr||''; 
          tip+=' · '+(r.sr?'社交最高 #'+r.sr+(r.sn?' '+r.sn:''):'前10无社交产品');
        }
        var isName = ((mode==='occ'||mode==='brand') && txt.length>2);
        h+='<td class="'+(groupFirst[d]?'gsep':'')+'"><div class="cl'+(col?'':' e')+(isName?' nm':'')+'" style="'+(col?'background:'+col:'')+'" title="'+tip.replace(/"/g,'')+'">'
          + (isName?'<span>'+txt.replace(/</g,'&lt;')+'</span>':txt) + '</div></td>';
      });
      h+='</tr>';
    });
    document.getElementById('mx1').innerHTML=h+'</tbody></table>';
    if(mode==='brand'){
      // 图例即势力榜：按占位格数排序，直接读出各家覆盖多少市场
      var used={}; list.forEach(function(m){ dims.forEach(function(d){ var r=box[m][d];
        if(r&&(r.occ==='occupied'||r.occ==='contested')&&r.bd) used[r.bd]=(used[r.bd]||0)+1; }); });
      var shown=D.brandLegend.filter(function(b){ return used[b.bd]; });
      var minor=Object.keys(used).filter(function(k){ return !D.brandColor[k]; });
      var minorCells=minor.reduce(function(s,k){ return s+used[k]; },0);
      lg.innerHTML = shown.map(function(b){
        return '<span title="'+b.bd+'：全球 '+b.n+' 格 / '+b.mn+' 国"><i style="background:'+b.c+'"></i>'
          + b.bd+' <b>'+used[b.bd]+'</b></span>'; }).join('')
        + (minorCells?'<span title="占位 1-2 格的长尾产品，未单独配色"><i style="background:'+D.minorColor+'"></i>单点占位 <b>'+minorCells+'</b>　<span style="opacity:.6">'+minor.length+' 个长尾产品</span></span>':'')
        + '<span style="opacity:.6">数字＝占位格数　斜纹＝无强势产品</span>';
    }
    else if(mode==='occ'){
      var cnt={occupied:0,contested:0,other:0};
      list.forEach(function(m){ dims.forEach(function(d){ var r=box[m][d];
        if(r&&(r.occ==='occupied'||r.occ==='contested')) cnt[r.occ]++; else cnt.other++; }); });
      lg.innerHTML = ['occupied','contested'].map(function(k){
        return '<span><i style="background:'+OCC[k].c+'"></i><b>'+OCC[k].t+'</b> '+cnt[k]+' 格　<span style="opacity:.6">'+OCC[k].d+'</span></span>'; }).join('')
        + '<span><i style="background:repeating-linear-gradient(45deg,var(--line),var(--line) 3px,transparent 3px,transparent 6px)"></i>'
        + '<b>未见强占位</b> '+cnt.other+' 格　<span style="opacity:.6">≠ 空位，见上方边界说明</span></span>'
        + '<span style="opacity:.6">悬停任意格可看搜索词与前三名结果</span>';
    }
    else if(mode==='type'){
      lg.innerHTML = ['local','regional','global','social'].map(function(k){
        return '<span><i style="background:'+TYPE[k].c+'"></i>'+TYPE[k].t+'　<span style="opacity:.65">'+TYPE[k].d+'</span></span>'; }).join('')
        + '<span><i style="background:var(--line)"></i>无有效结果</span>';
    } else {
      lg.innerHTML = '<span><i style="background:#0d9488"></i>第 1-2 名</span><span><i style="background:#4D7EFF"></i>第 3-4 名</span>'
        + '<span><i style="background:#7B61FF"></i>第 5-6 名</span><span><i style="background:#a78bfa"></i>第 7-10 名</span>'
        + '<span><i style="background:var(--line)"></i>前 10 无社交产品</span>';
    }
  }
  sel.onchange=render; selR.onchange=render; render();
})();

// 5b. 矩阵二：竞品市场重心
(function(){
  var byApp={}, ccs=[], ccName={}, ccRegion={};
  D.metrics.forEach(function(r){
    byApp[r.cn]=byApp[r.cn]||{}; byApp[r.cn][r.cc]=r;
    if(ccs.indexOf(r.cc)<0){ ccs.push(r.cc); ccName[r.cc]=r.mk; ccRegion[r.cc]=r.rg; }
  });
  // 市场按区域分组排序，便于看地理形态
  var rgOrder=[]; D.markets.forEach(function(m){ if(rgOrder.indexOf(m.region)<0) rgOrder.push(m.region); });
  ccs.sort(function(a,b){
    var d=rgOrder.indexOf(ccRegion[a])-rgOrder.indexOf(ccRegion[b]); if(d) return d;
    return ccName[a].localeCompare(ccName[b],'zh');
  });
  var apps=Object.keys(byApp).sort(function(a,b){
    var sa=0,sb=0; for(var k in byApp[a]) sa+=byApp[a][k].rc; for(var k2 in byApp[b]) sb+=byApp[b][k2].rc;
    return sb-sa;
  });
  function shade(p){ // p = 占该竞品全球总量比例
    if(p>=0.25) return '#1e40af'; if(p>=0.12) return '#2563eb'; if(p>=0.06) return '#4D7EFF';
    if(p>=0.03) return '#7B9CFF'; if(p>=0.01) return '#a8bdff'; if(p>0) return '#d6e0ff'; return '';
  }
  var h='<table class="mx mx2"><thead><tr><th class="corner">竞品</th>';
  ccs.forEach(function(c){ h+='<th title="'+ccName[c]+'">'+ccName[c]+'</th>'; });
  h+='</tr></thead><tbody>';
  apps.forEach(function(a){
    var tot=0; for(var k in byApp[a]) tot+=byApp[a][k].rc;
    h+='<tr><td class="mk">'+a+'</td>';
    ccs.forEach(function(c){
      var r=byApp[a][c];
      if(!r){ h+='<td><div class="cl e" title="'+a+' · '+ccName[c]+' · 未上架">·</div></td>'; return; }
      var p=tot?r.rc/tot:0;
      h+='<td><div class="cl" style="background:'+shade(p)+';color:'+(p>=0.06?'#fff':'var(--ink2)')+'" title="'+
        a+' · '+ccName[c]+' · 评分数 '+r.rc.toLocaleString()+'（占其全球 '+(p*100).toFixed(1)+'%）">'+
        (p>=0.03?(p*100).toFixed(0):'')+'</div></td>';
    });
    h+='</tr>';
  });
  document.getElementById('mx2').innerHTML=h+'</tbody></table>';
  document.getElementById('lg2').innerHTML =
    '<span>数字为占该竞品全球评分数的百分比</span>'
    + '<span><i style="background:#1e40af"></i>≥25%</span><span><i style="background:#2563eb"></i>12-25%</span>'
    + '<span><i style="background:#4D7EFF"></i>6-12%</span><span><i style="background:#7B9CFF"></i>3-6%</span>'
    + '<span><i style="background:#a8bdff"></i>1-3%</span><span><i style="background:var(--line)"></i>未上架</span>';
})();

// 5b. 产品视角矩阵：产品 × 心智维度
(function(){
  var scope=document.getElementById('h_scope'), q=document.getElementById('h_q');
  var SOCIAL=/instagram|tiktok|threads|snapchat|pinterest|reddit|x |twitter|bluesky|lemon8|bereal|facebook|line|kakao|wechat|weibo|discord|telegram|whatsapp|likee|kwai|youtube|douyin|rednote|xiaohongshu|小红书/i;
  function render(){
    var kw=(q.value||'').trim().toLowerCase(), sp=scope.value;
    var list=D.holders.filter(function(h){
      if(kw && h.bd.toLowerCase().indexOf(kw)<0) return false;
      if(sp==='multi' && h.mn<3) return false;
      if(sp==='social' && !SOCIAL.test(h.bd)) return false;
      return true;
    });
    if(!list.length){ document.getElementById('mx_h').innerHTML='<div style="padding:20px;color:var(--ink3);font-size:13px">无匹配占位方</div>'; return; }
    var cap = kw?list.length:Math.min(list.length,30);
    list=list.slice(0,cap);
    var h='<table class="mx mx3"><thead>';
    h+='<tr class="grow"><td class="gcorner"></td>';
    groupSpan.forEach(function(g){ h+='<td class="gh" colspan="'+g.n+'"><span>'+g.g+'</span></td>'; });
    h+='<td colspan="2"></td></tr>';
    h+='<tr><th class="corner">占位方</th>';
    dims.forEach(function(d){ h+='<th class="'+(groupFirst[d]?'gsep':'')+'">'+dimCn[d]+'</th>'; });
    h+='<th class="tot gsep">格数</th><th class="tot">市场</th></tr></thead><tbody>';
    list.forEach(function(o){
      var dmap={}; o.dims.forEach(function(x){ dmap[x.d]=x.n; });
      h+='<tr><td class="mk hd" title="'+o.bd.replace(/"/g,'')+'">'+o.bd.replace(/</g,'&lt;')+'</td>';
      dims.forEach(function(d){
        var n=dmap[dimCn[d]]||0;
        var col = n===0?'':n>=8?'#0f5f50':n>=4?'#1e7f6b':n>=2?'#3d9e88':'#8fc9bd';
        var tip=o.bd+' · '+dimCn[d]+' · '+(n?n+' 个市场':'无占位');
        h+='<td class="'+(groupFirst[d]?'gsep':'')+'"><div class="cl'+(col?'':' e')+'" style="'+(col?'background:'+col:'')+'" title="'+tip.replace(/"/g,'')+'">'+(n||'')+'</div></td>';
      });
      h+='<td class="tot gsep">'+o.n+'</td><td class="tot">'+o.mn+'</td></tr>';
    });
    document.getElementById('mx_h').innerHTML=h+'</tbody></table>';
    document.getElementById('lg_h').innerHTML=
      '<span><i style="background:#8fc9bd"></i>1 个市场</span><span><i style="background:#3d9e88"></i>2-3 个</span>'
      +'<span><i style="background:#1e7f6b"></i>4-7 个</span><span><i style="background:#0f5f50"></i>≥8 个</span>'
      +'<span style="margin-left:6px;opacity:.7">共 '+D.holders.length+' 个占位方'+(cap<D.holders.length&&!kw?'，默认显示占位最多的 '+cap+' 个':'')+'</span>';
  }
  scope.onchange=render; q.oninput=render; render();
})();

// 5c. 竞品自我定位
(function(){
  var sel=document.getElementById('p_app');
  if(!D.positioning || !D.positioning.length){ 
    document.getElementById('pos_genre').innerHTML='<div style="color:var(--ink3);font-size:13px">暂无数据</div>'; return; }
  D.positioning.forEach(function(p,i){ sel.innerHTML += '<option value="'+i+'">'+p.cn+'（'+p.mk+' 国 · '+p.gv+' 种品类定位 · '+p.nv+' 种本地化名称）</option>'; });
  function render(){
    var p=D.positioning[sel.value|0];
    var g='<table style="width:100%"><thead><tr><th>商店品类</th><th>市场数</th><th>代表市场</th></tr></thead><tbody>';
    p.genres.forEach(function(x){
      g+='<tr><td><b>'+x.genre+'</b></td><td>'+x.count+'</td><td style="color:var(--ink3)">'+x.markets.join('、')+'</td></tr>';
    });
    g+='</tbody></table>';
    if(p.names.length>1){
      g+='<div style="margin-top:12px;font-size:12.5px;color:var(--ink2)"><b>本地化名称差异：</b><ul class="tight" style="margin-top:5px">';
      p.names.forEach(function(n){ g+='<li>'+(n.name||'—')+'　<span style="color:var(--ink3)">'+n.count+' 国：'+n.markets.join('、')+'</span></li>'; });
      g+='</ul></div>';
    }
    document.getElementById('pos_genre').innerHTML=g;
    var d='';
    if(p.samples && p.samples.length){
      d='<div style="font-size:12.5px;color:var(--ink3);margin-bottom:8px">各市场商店描述开头（体现它想让当地用户把它当什么）</div>';
      p.samples.forEach(function(x){
        d+='<div style="border-left:3px solid var(--primary);padding:8px 12px;margin-bottom:8px;background:rgba(77,126,255,.05);border-radius:0 6px 6px 0">'
         + '<div style="font-size:12px;color:var(--ink2)"><b>'+x.market+'</b>　'+(x.local_name||'')+'　<span class="pill p-blue">'+(x.genre||'')+'</span></div>'
         + '<div style="font-size:12.5px;color:var(--ink2);margin-top:4px;line-height:1.55">'+(x.desc||'').replace(/</g,'&lt;')+'…</div></div>';
      });
    }
    document.getElementById('pos_desc').innerHTML=d;
  }
  sel.onchange=render; render();
})();

// 6. 市场明细表
(function(){
  var fr=document.getElementById('f_region'), fd=document.getElementById('f_dim'),
      fk=document.getElementById('f_kw'), tb=document.querySelector('#t_mind tbody'), ct=document.getElementById('t_count');
  var regions=[], dimset=[];
  D.mind.forEach(function(r){ if(regions.indexOf(r.rg)<0)regions.push(r.rg); if(dimset.indexOf(r.dcn)<0)dimset.push(r.dcn); });
  regions.forEach(function(r){ fr.innerHTML += '<option>'+r+'</option>'; });
  dimset.forEach(function(d){ fd.innerHTML += '<option>'+d+'</option>'; });
  function render(){
    var rg=fr.value, dm=fd.value, kw=fk.value.trim().toLowerCase();
    var rows = D.mind.filter(function(r){
      if(rg && r.rg!==rg) return false;
      if(dm && r.dcn!==dm) return false;
      if(kw){ var hay=(r.mk+' '+r.t1+' '+(r.sn||'')+' '+r.sl+' '+r.tm).toLowerCase(); if(hay.indexOf(kw)<0) return false; }
      return true;
    });
    tb.innerHTML = rows.slice(0,400).map(function(r){
      var q = r.q==='ok'?'<span class="pill p-ok">ok</span>':r.q==='medium'?'<span class="pill p-med">medium</span>':'<span class="pill p-low">'+r.q+'</span>';
      var s = r.sr ? '<span class="pill p-blue">#'+r.sr+'</span> '+(r.sn||'').slice(0,26) : '<span style="color:var(--ink3)">无</span>';
      return '<tr><td><b>'+r.mk+'</b></td><td>'+r.rg+'</td><td>'+r.dcn+
        '</td><td>'+(r.t1||'').slice(0,32)+'</td><td>'+s+'</td><td>'+q+'</td></tr>';
    }).join('');
    ct.textContent = '共 '+rows.length+' 行' + (rows.length>400 ? '，显示前 400 行' : '');
  }
  [fr,fd].forEach(function(e){ e.onchange=render; }); fk.oninput=render; render();
})();

// 7. 指标表
(function(){
  var fa=document.getElementById('f_app'), fk=document.getElementById('f_mkw'),
      tb=document.querySelector('#t_met tbody'), ct=document.getElementById('m_count');
  var apps=[]; D.metrics.forEach(function(r){ if(apps.indexOf(r.cn)<0)apps.push(r.cn); });
  apps.forEach(function(a){ fa.innerHTML += '<option>'+a+'</option>'; });
  function render(){
    var ap=fa.value, kw=fk.value.trim().toLowerCase();
    var rows = D.metrics.filter(function(r){
      if(ap && r.cn!==ap) return false;
      if(kw && (r.mk+' '+r.ln).toLowerCase().indexOf(kw)<0) return false;
      return true;
    }).sort(function(a,b){ return b.rc-a.rc; });
    tb.innerHTML = rows.slice(0,400).map(function(r){
      return '<tr><td><b>'+r.cn+'</b></td><td>'+r.mk+'</td><td style="color:var(--ink3)">'+(r.ln||'').slice(0,30)+
        '</td><td><b>'+r.rc.toLocaleString()+'</b></td><td>'+(r.ra==null?'—':r.ra.toFixed(2))+
        '</td><td>'+(r.v||'—')+'</td><td>'+(r.vd||'—')+'</td></tr>';
    }).join('');
    ct.textContent = '共 '+rows.length+' 行' + (rows.length>400 ? '，显示前 400 行' : '');
  }
  fa.onchange=render; fk.oninput=render; render();
})();
</script>
</body>
</html>`;

  const outPath = path.join(DOCS, 'index.html');
  fs.writeFileSync(outPath, html);
  // .nojekyll 防止 GitHub Pages 的 Jekyll 处理掉某些文件
  fs.writeFileSync(path.join(DOCS, '.nojekyll'), '');
  // 附带一份数据快照供外部消费
  fs.writeFileSync(path.join(DOCS, 'data.json'), JSON.stringify(DATA));

  const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
  C.log(`站点: ${outPath} (${kb} KB)`);
  C.log(`数据: ${path.join(DOCS, 'data.json')}`);
}

main();
