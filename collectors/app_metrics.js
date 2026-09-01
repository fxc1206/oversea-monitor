'use strict';
/**
 * 竞品指标采集：按国家解析真实 trackId，再抓评分数/均分/版本/发版日。
 *
 * 为什么必须先解析 ID（踩过的坑）：
 *   同一 App 在不同国家 trackId 不同。实测 TikTok 美区 835599320，日本/印尼 1235601864。
 *   若全局硬编码一张 ID 表，日本会静默返回「无上架」，数据错了但不报错——这是最危险的失败模式。
 *
 * 指标口径声明：
 *   userRatingCount（评分总数）是累计值，不是当期值。它的「日增」才是量级代理。
 *   评分数 ≈ 累计下载 × 评分转化率，而转化率跨 App 差异巨大。
 *   ✅ 正确用法：同一 App 同一国家的纵向趋势对比。
 *   ❌ 错误用法：跨 App 比绝对值（Threads 15万 vs Instagram 335万 ≠ 用户规模比）。
 *
 * 用法：
 *   node collectors/app_metrics.js                    # 全量
 *   node collectors/app_metrics.js --cc us,jp,id
 *   node collectors/app_metrics.js --app threads,lemon8
 *   node collectors/app_metrics.js --refresh-ids      # 强制重新解析 ID 映射表
 */
const fs = require('fs');
const path = require('path');
const C = require('../lib/core');

const markets = require('../config/markets.json');
const appsCfg = require('../config/apps.json');

const ID_MAP_PATH = path.join(C.ROOT, 'data', 'app_id_map.json');

function argv(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const hasFlag = (n) => process.argv.includes('--' + n);

function targets() {
  const all = Object.entries(markets).flatMap(([region, list]) => list.map((m) => ({ region, ...m })));
  const ccArg = argv('cc');
  const regionArg = argv('region');
  let out = all;
  if (regionArg) out = out.filter((m) => m.region === regionArg);
  if (ccArg) {
    const set = new Set(ccArg.split(',').map((s) => s.trim().toLowerCase()));
    out = out.filter((m) => set.has(m.cc));
  }
  const appArg = argv('app');
  let apps = appsCfg.tracked_apps;
  if (appArg) {
    const set = new Set(appArg.split(',').map((s) => s.trim()));
    apps = apps.filter((a) => set.has(a.key));
  }
  return { countries: out, apps };
}

/** 解析 (app, country) -> trackId。结果缓存到 data/app_id_map.json */
async function resolveIds(countries, apps, force) {
  let map = {};
  if (!force && fs.existsSync(ID_MAP_PATH)) {
    map = JSON.parse(fs.readFileSync(ID_MAP_PATH, 'utf8'));
  }
  let resolved = 0, missing = 0;
  for (const a of apps) {
    map[a.key] = map[a.key] || {};
    for (const m of countries) {
      if (map[a.key][m.cc] !== undefined) continue;
      // 先用已知 ID 直接验证，命中就省一次搜索
      const known = a.known_ids && a.known_ids[m.cc];
      if (known) {
        map[a.key][m.cc] = { id: known, name: a.cn, source: 'known' };
        resolved++;
        continue;
      }
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(a.search_term)}&country=${m.cc}&entity=software&limit=5`;
      try {
        const j = await C.fetchJSON(url, { label: `resolve:${a.key}:${m.cc}` });
        const cands = j.results || [];
        // 优先按 seller_hint 匹配正主，避免抓到山寨
        let pick = a.seller_hint
          ? cands.find((r) => (r.sellerName || '').toLowerCase().includes(a.seller_hint.toLowerCase()))
          : null;
        if (!pick) pick = cands[0];
        if (pick) {
          map[a.key][m.cc] = {
            id: pick.trackId,
            name: pick.trackName,
            seller: pick.sellerName,
            source: 'search',
            verified: a.seller_hint ? (pick.sellerName || '').toLowerCase().includes(a.seller_hint.toLowerCase()) : null,
          };
          resolved++;
        } else {
          map[a.key][m.cc] = null; // 该国确实未上架
          missing++;
        }
      } catch (e) {
        C.log(`  ✗ 解析 ${a.key}/${m.cc}: ${e.message}`);
      }
    }
  }
  fs.writeFileSync(ID_MAP_PATH, JSON.stringify(map, null, 1));
  C.log(`ID 映射: 解析 ${resolved}, 未上架 ${missing} -> ${ID_MAP_PATH}`);
  return map;
}

async function main() {
  const { countries, apps } = targets();
  C.log(`指标采集: ${apps.length} App × ${countries.length} 国`);
  const map = await resolveIds(countries, apps, hasFlag('refresh-ids'));

  const rows = [];
  const failures = [];
  let done = 0;
  const total = apps.length * countries.length;

  for (const a of apps) {
    for (const m of countries) {
      done++;
      const entry = map[a.key] && map[a.key][m.cc];
      if (!entry) {
        rows.push({ app: a.key, app_cn: a.cn, region: m.region, cc: m.cc, market: m.name, listed: false });
        continue;
      }
      const url = `https://itunes.apple.com/lookup?id=${entry.id}&country=${m.cc}`;
      try {
        const j = await C.fetchJSON(url, { label: `metrics:${a.key}:${m.cc}` });
        const r = (j.results || [])[0];
        if (!r) {
          rows.push({ app: a.key, app_cn: a.cn, region: m.region, cc: m.cc, market: m.name, listed: false, note: 'lookup empty' });
          continue;
        }
        rows.push({
          app: a.key,
          app_cn: a.cn,
          region: m.region,
          cc: m.cc,
          market: m.name,
          listed: true,
          track_id: r.trackId,
          local_name: r.trackName,
          seller: r.sellerName,
          genres: r.genres,
          primary_genre: r.primaryGenreName,
          rating_count: r.userRatingCount || 0,
          rating_avg: r.averageUserRating != null ? Number(r.averageUserRating.toFixed(3)) : null,
          rating_count_cur_ver: r.userRatingCountForCurrentVersion || 0,
          version: r.version,
          version_release_date: r.currentVersionReleaseDate,
          original_release_date: r.releaseDate,
          // 自我定位证据：本地化商店描述首段，用于「宣称心智」分析
          desc_head: (r.description || '').replace(/\s+/g, ' ').slice(0, 300),
          release_notes_head: (r.releaseNotes || '').replace(/\s+/g, ' ').slice(0, 300),
        });
      } catch (e) {
        failures.push({ app: a.key, cc: m.cc, error: e.message });
        C.log(`  ✗ ${a.key}/${m.cc}: ${e.message}`);
      }
      if (done % 30 === 0) C.log(`  进度 ${done}/${total} | req=${C.stats.requests} cache=${C.stats.fromCache} err=${C.stats.errors}`);
    }
  }

  const f = C.appendSnapshot('app_metrics', rows);
  if (failures.length) {
    fs.writeFileSync(path.join(C.DIRS.snapshots, 'app_metrics', `${C.today()}.failures.json`), JSON.stringify(failures, null, 1));
  }
  C.log(`完成: ${rows.length} 行 (${rows.filter((r) => r.listed).length} 上架) -> ${f}`);
  C.log(`统计: ${JSON.stringify(C.stats)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
