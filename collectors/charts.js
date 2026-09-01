#!/usr/bin/env node
/**
 * charts.js — App Store 榜单排名采集器（下载动能层）
 *
 * 与 mindshare.js 的区别：
 *   mindshare = 货架心智（搜某个需求词会撞见谁）
 *   charts    = 下载动能（谁真的在被下载）
 *
 * 数据源：https://itunes.apple.com/{cc}/rss/{kind}/limit=100/genre={g}/json
 *   公开免鉴权，实测 39 国 × 8 分类全部可用，深度上限 100。
 *
 * 口径声明：
 *   - 榜单是「近期下载动能」的排序，不是装机量/DAU/市场份额。
 *   - 免费榜受买量影响大；畅销榜反映内购收入，与社交产品相关性低。
 *   - 每日变动 → 这是本项目第一个天然带时间序列的数据源。
 *
 * 用法：
 *   node collectors/charts.js                    # 全量 39国 × 8分类 免费榜
 *   node collectors/charts.js --cc us,jp         # 指定国家
 *   node collectors/charts.js --genre 6005       # 指定分类
 *   node collectors/charts.js --kind toppaid     # 付费榜
 *   node collectors/charts.js --limit 50
 */
const path = require('path');
const C = require('../lib/core');

const MARKETS = require('../config/markets.json');
const APPS = require('../config/apps.json');

// 与心智维度对得上的分类（不做全量分类，只取与本项目相关的）
const GENRES = {
  6005: { cn: '社交', dims: ['chat_friends', 'dating', 'local_community'] },
  6009: { cn: '新闻', dims: ['news_public'] },
  6008: { cn: '照片视频', dims: ['short_video', 'share_photos'] },
  6012: { cn: '生活', dims: ['discover_inspiration', 'home_decor', 'fitness'] },
  6023: { cn: '美食', dims: ['recipes', 'restaurant'] },
  6003: { cn: '旅行', dims: ['travel_plan'] },
  6024: { cn: '购物', dims: ['shopping_deals', 'product_review'] },
  6016: { cn: '娱乐', dims: [] },
  6002: { cn: '工具', dims: ['learn_howto'] },
};

const KINDS = {
  topfree: 'topfreeapplications',
  toppaid: 'toppaidapplications',
  topgrossing: 'topgrossingapplications',
};

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

// 竞品识别：优先用已解析的跨国 ID 映射（app_metrics 产出），其次 known_ids，最后名称
const fs = require('fs');
let ID_MAP = {};
try {
  ID_MAP = JSON.parse(fs.readFileSync(path.join(C.ROOT, 'data', 'app_id_map.json'), 'utf8'));
} catch (e) {
  C.log('注意: 未找到 app_id_map.json，竞品识别将只依赖名称匹配');
}
// 构建 trackId -> appKey 反查表（跨全部国家）
const ID2APP = new Map();
for (const [key, byCC] of Object.entries(ID_MAP)) {
  if (key.startsWith('_') || !byCC || typeof byCC !== 'object') continue;
  for (const e of Object.values(byCC)) {
    if (e && e.id) ID2APP.set(String(e.id), key);
  }
}
const COMP = (APPS.tracked_apps || []).map((a) => ({
  key: a.key,
  seller_hint: a.seller_hint || null,
  ids: new Set(Object.values(a.known_ids || {}).map(String)),
}));
for (const c of COMP) for (const id of c.ids) ID2APP.set(id, c.key);

/**
 * 竞品识别以 trackId 为准（唯一可靠锚点）。
 * 名称匹配只作兜底，且必须严格：宽松的前缀匹配会把 Xiaomi/XBOX 认成 X、
 * 把 TikTok Studio（创作者后台，不是主 App）认成 TikTok，从而虚高覆盖度。
 * 规则：名称需为主 App 名或其常见后缀变体，且开发者需与 seller_hint 一致。
 */
const NAME_RULES = {
  threads:     /^threads\b/i,
  instagram:   /^instagram\b/i,
  tiktok:      /^tiktok(\s*[-–—:]|\s+lite\b|$)/i,   // 排除 TikTok Studio / TikTok Pro 等衍生工具
  lemon8:      /^lemon8\b/i,
  x:           /^(x|twitter)$|^x\s*[-–—:(]|^twitter\b/i, // 严格：不匹配 Xiaomi / XBOX / Xender
  snapchat:    /^snapchat\b/i,
  bereal:      /^bereal\b/i,
  pinterest:   /^pinterest(\s*[-–—:(（]|$)/i,          // 排除 Pinterest videos downloader
  reddit:      /^reddit\b/i,
  xiaohongshu: /^(rednote|小红书|小紅書)/i,
  bluesky:     /^bluesky\b/i,
};

function matchComp(entry) {
  const id = String(entry.trackId || '');
  if (ID2APP.has(id)) return ID2APP.get(id);
  const name = String(entry.name || '');
  const seller = String(entry.seller || '');
  for (const c of COMP) {
    const re = NAME_RULES[c.key];
    if (!re || !re.test(name)) continue;
    // 有 seller_hint 时必须开发者也对得上，避免同名山寨/衍生工具
    if (c.seller_hint && seller && seller.toLowerCase().indexOf(c.seller_hint.toLowerCase()) < 0) continue;
    return c.key;
  }
  return null;
}

// 社交产品判定（沿用 apps.json 的 social_regex）
const SOCIAL_RE = new RegExp(APPS.social_regex, 'i');

(async () => {
  const kindKey = arg('kind', 'topfree');
  const kind = KINDS[kindKey];
  if (!kind) throw new Error('未知 kind: ' + kindKey + '（可选 ' + Object.keys(KINDS).join('/') + '）');
  const limit = parseInt(arg('limit', '100'), 10);

  // 国家列表
  const ccFilter = arg('cc', null);
  const regionFilter = arg('region', null);
  const markets = [];
  for (const [region, list] of Object.entries(MARKETS)) {
    if (region.startsWith('_')) continue;
    if (regionFilter && region !== regionFilter) continue;
    for (const m of list) {
      if (ccFilter && !ccFilter.split(',').includes(m.cc)) continue;
      markets.push({ ...m, region });
    }
  }

  // 分类列表
  const gFilter = arg('genre', null);
  const genres = Object.entries(GENRES).filter(([g]) => !gFilter || gFilter.split(',').includes(g));

  const total = markets.length * genres.length;
  C.log(`榜单采集启动: ${markets.length} 国 × ${genres.length} 分类 = ${total} 次查询, kind=${kindKey}, limit=${limit}`);

  const rows = [];
  const failed = [];
  let done = 0;

  for (const m of markets) {
    for (const [g, meta] of genres) {
      const url = `https://itunes.apple.com/${m.cc}/rss/${kind}/limit=${limit}/genre=${g}/json`;
      let json;
      try {
        json = await C.fetchJSON(url, { label: `chart:${m.cc}:${g}` });
      } catch (e) {
        failed.push({ cc: m.cc, genre: g, err: String(e.message || e) });
        done++;
        continue;
      }

      const entries = (json && json.feed && json.feed.entry) || [];
      // limit=1 时 Apple 返回对象而非数组
      const list = Array.isArray(entries) ? entries : [entries];

      const parsed = list
        .map((e, i) => {
          if (!e || !e['im:name']) return null;
          return {
            rank: i + 1,
            trackId: e.id && e.id.attributes ? String(e.id.attributes['im:id']) : null,
            name: e['im:name'].label || '',
            seller: e['im:artist'] ? e['im:artist'].label || '' : '',
            genre_label: e.category && e.category.attributes ? e.category.attributes.label : '',
            release: e['im:releaseDate'] ? e['im:releaseDate'].label : null,
          };
        })
        .filter(Boolean);

      // 标注竞品与社交产品
      for (const p of parsed) {
        p.competitor = matchComp(p);
        p.is_social = SOCIAL_RE.test(p.name) || SOCIAL_RE.test(p.seller);
      }

      rows.push({
        date: C.today(),
        cc: m.cc,
        market: m.name,
        region: m.region,
        kind: kindKey,
        genre: g,
        genre_cn: meta.cn,
        dims: meta.dims,
        depth: parsed.length,
        entries: parsed,
        // 便于分析的摘要字段
        top1: parsed[0] ? parsed[0].name : null,
        top1_id: parsed[0] ? parsed[0].trackId : null,
        social_in_top10: parsed.slice(0, 10).filter((p) => p.is_social).length,
        competitors: parsed
          .filter((p) => p.competitor)
          .map((p) => ({ app: p.competitor, rank: p.rank, name: p.name })),
      });

      done++;
      if (done % 20 === 0 || done === total) {
        C.log(`  进度 ${done}/${total} | req=${C.stats.requests} cache=${C.stats.fromCache} blocked=${C.stats.blocked} err=${C.stats.errors}`);
      }
    }
  }

  const out = C.appendSnapshot('charts', rows);
  C.log(`完成: ${rows.length} 行 -> ${out}`);
  C.log(`失败: ${failed.length}`);
  if (failed.length) console.log(JSON.stringify(failed.slice(0, 10), null, 1));
  C.log('统计: ' + JSON.stringify(C.stats));

  // 快速概览
  const compHits = {};
  for (const r of rows) for (const c of r.competitors) {
    compHits[c.app] = compHits[c.app] || { n: 0, best: 999, markets: new Set() };
    compHits[c.app].n++;
    compHits[c.app].best = Math.min(compHits[c.app].best, c.rank);
    compHits[c.app].markets.add(r.cc);
  }
  C.log('竞品上榜概览:');
  Object.entries(compHits)
    .sort((a, b) => b[1].markets.size - a[1].markets.size)
    .forEach(([k, v]) => C.log(`  ${k}: ${v.markets.size}国 ${v.n}次上榜 最高第${v.best}名`));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
