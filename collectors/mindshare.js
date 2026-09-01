'use strict';
/**
 * 心智占位扫描：对每个 (国家 × 心智维度) 查 App Store 搜索前 N 名，
 * 记录谁占住了这个需求入口、社交/内容产品最高排名、以及信号质量标记。
 *
 * 口径声明（重要，别读反）：
 *   本指标测的是「App Store 商店内，某需求词的搜索结果排序」。
 *   它受商店文案关键词匹配度影响极大，综合社交产品的商店描述里通常不写 recipes，
 *   因此「社交产品缺席」不能直接等同于「用户心智里社交产品不承担该需求」。
 *   它的正确用途是：跨国比较供给结构（本土 vs 国际）、监测占位变化。
 *
 * 用法：
 *   node collectors/mindshare.js                 # 全量（39国 × 16维度，约 620 次请求）
 *   node collectors/mindshare.js --cc us,jp      # 指定国家
 *   node collectors/mindshare.js --dim recipes   # 指定维度
 *   node collectors/mindshare.js --region 东南亚
 *   node collectors/mindshare.js --limit 10      # 每词取前10名
 */
const fs = require('fs');
const path = require('path');
const C = require('../lib/core');

const markets = require('../config/markets.json');
const termsCfg = require('../config/mindshare_terms.json');
const appsCfg = require('../config/apps.json');

const SOCIAL = new RegExp(appsCfg.social_regex, 'i');
const GAME = new RegExp(appsCfg.game_regex, 'i');

function argv(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function targetCountries() {
  const all = Object.entries(markets).flatMap(([region, list]) => list.map((m) => ({ region, ...m })));
  const region = argv('region');
  const ccArg = argv('cc');
  let out = all;
  if (region) out = out.filter((m) => m.region === region);
  if (ccArg) {
    const set = new Set(ccArg.split(',').map((s) => s.trim().toLowerCase()));
    out = out.filter((m) => set.has(m.cc));
  }
  return out;
}

function targetDimensions() {
  const dimArg = argv('dim');
  let dims = termsCfg.dimensions;
  if (dimArg) {
    const set = new Set(dimArg.split(',').map((s) => s.trim()));
    dims = dims.filter((d) => set.has(d.dimension));
  }
  return dims;
}

async function main() {
  const limit = Number(argv('limit', 10));
  const countries = targetCountries();
  const dims = targetDimensions();
  // 词层：narrow=需求场景词（谁在抢这个具体场景），broad=品类宽词（品类货架头部是谁）
  // 实测两层结果几乎不重叠：美国搜 ideas 首位 Pinterest，搜 inspiration ideas 前5无 Pinterest。
  const layerArg = argv('layer', 'both');
  const layers = layerArg === 'both' ? ['narrow', 'broad'] : [layerArg];
  const total = countries.length * dims.length * layers.length;
  C.log(`心智扫描启动: ${countries.length} 国 × ${dims.length} 维度 × ${layers.length} 词层 = ${total} 次查询, limit=${limit}`);

  const rows = [];
  const failures = [];
  let done = 0;

  for (const m of countries) {
    const lang = termsCfg.lang_by_cc[m.cc] || 'en';
    for (const d of dims) {
     for (const layer of layers) {
      const bank = layer === 'broad' ? (d.broad_terms || d.terms) : d.terms;
      const term = bank[lang] || bank.en;
      done++;
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${m.cc}&entity=software&limit=${limit}`;
      try {
        const j = await C.fetchJSON(url, { label: `mind:${m.cc}:${d.dimension}:${layer}` });
        const results = (j.results || []).map((r, i) => ({
          rank: i + 1,
          name: r.trackName,
          id: r.trackId,
          seller: r.sellerName || '',
          ratings: r.userRatingCount || 0,
          genre: r.primaryGenreName || '',
        }));
        const socialHit = results.find((r) => SOCIAL.test(r.name));
        const gameCount = results.filter((r) => GAME.test(r.name)).length;
        rows.push({
          region: m.region,
          cc: m.cc,
          market: m.name,
          lang,
          dimension: d.dimension,
          group: d.group,
          dimension_cn: d.cn,
          layer,
          term,
          resultCount: results.length,
          top5: results.slice(0, 5).map((r) => r.name),
          top1_seller: results[0] ? results[0].seller : null,
          top1_genre: results[0] ? results[0].genre : null,
          social_top_rank: socialHit ? socialHit.rank : null,
          social_top_name: socialHit ? socialHit.name : null,
          game_noise_count: gameCount,
          signal_quality: results.length === 0 ? 'empty' : gameCount >= 3 ? 'low' : gameCount >= 1 ? 'medium' : 'ok',
          results,
        });
        if (done % 20 === 0 || done === total) {
          C.log(`  进度 ${done}/${total} | req=${C.stats.requests} cache=${C.stats.fromCache} blocked=${C.stats.blocked} err=${C.stats.errors}`);
        }
      } catch (e) {
        failures.push({ cc: m.cc, dimension: d.dimension, layer, term, error: e.message });
        C.log(`  ✗ ${m.cc}/${d.dimension}/${layer} 失败: ${e.message}`);
      }
     }
    }
  }

  const f = C.appendSnapshot('mindshare', rows);
  const failPath = path.join(C.DIRS.snapshots, 'mindshare', `${C.today()}.failures.json`);
  if (failures.length) fs.writeFileSync(failPath, JSON.stringify(failures, null, 1));

  C.log(`完成: ${rows.length} 行 -> ${f}`);
  C.log(`失败: ${failures.length}${failures.length ? ' -> ' + failPath : ''}`);
  C.log(`统计: ${JSON.stringify(C.stats)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
