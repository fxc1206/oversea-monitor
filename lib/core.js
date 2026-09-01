'use strict';
/**
 * 核心库：限速 HTTP、原始响应存档、快照追加。
 * 设计原则：
 *  1. 每一次外部响应都先落盘到 data/raw/<date>/，再解析。解析逻辑改了可以重跑历史 raw，不用重新请求。
 *  2. 快照按天追加为 JSONL，永不覆盖。这是逐步积累数据库的基础。
 *  3. 限速与重试内建。苹果接口在高频批量请求下会返回 HTML 拦截页（实测），必须串行 + 间隔。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DIRS = {
  raw: path.join(ROOT, 'data', 'raw'),
  snapshots: path.join(ROOT, 'data', 'snapshots'),
  reports: path.join(ROOT, 'reports'),
};

function today() {
  return new Date().toISOString().slice(0, 10);
}
function nowISO() {
  return new Date().toISOString();
}
function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 可调限速参数：被拦截时把 minIntervalMs 调大 */
const RATE = {
  minIntervalMs: Number(process.env.OM_INTERVAL_MS || 1300),
  maxRetries: Number(process.env.OM_MAX_RETRIES || 3),
  backoffBaseMs: 3000,
  timeoutMs: 20000,
};

let lastCallAt = 0;
const stats = { requests: 0, retries: 0, blocked: 0, errors: 0, fromCache: 0 };

function rawPathFor(url) {
  const h = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  return path.join(ensureDir(path.join(DIRS.raw, today())), h + '.json');
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
          'Accept': 'application/json,text/javascript,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return httpGet(res.headers.location).then(resolve, reject);
        }
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on('error', reject);
    req.setTimeout(RATE.timeoutMs, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

/**
 * 取 JSON，带限速/重试/原始存档。
 * useCache=true 时同一天内同一 URL 直接复用已存档的 raw，便于反复调试解析逻辑而不重复打接口。
 */
async function fetchJSON(url, { useCache = true, label = '' } = {}) {
  const rp = rawPathFor(url);
  if (useCache && fs.existsSync(rp)) {
    try {
      const cached = JSON.parse(fs.readFileSync(rp, 'utf8'));
      stats.fromCache++;
      return cached.parsed;
    } catch (_) { /* 缓存损坏则重新请求 */ }
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= RATE.maxRetries; attempt++) {
    const wait = RATE.minIntervalMs - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    stats.requests++;
    try {
      const { status, body } = await httpGet(url);
      const looksHTML = /^\s*</.test(body);
      if (status !== 200 || looksHTML) {
        // 关键失败模式：出口被拦时返回 HTML 拦截页而非 JSON
        if (looksHTML) stats.blocked++;
        throw new Error(`bad response status=${status} html=${looksHTML}`);
      }
      const parsed = JSON.parse(body);
      fs.writeFileSync(rp, JSON.stringify({ url, label, fetchedAt: nowISO(), status, parsed }));
      return parsed;
    } catch (e) {
      lastErr = e;
      stats.retries++;
      if (attempt < RATE.maxRetries) {
        await sleep(RATE.backoffBaseMs * Math.pow(2, attempt));
      }
    }
  }
  stats.errors++;
  const err = new Error(`fetchJSON failed after retries: ${lastErr && lastErr.message}`);
  err.url = url;
  throw err;
}

/** 追加写快照（JSONL，按 dataset + 日期分文件，永不覆盖历史） */
function appendSnapshot(dataset, rows) {
  if (!rows || !rows.length) return null;
  const dir = ensureDir(path.join(DIRS.snapshots, dataset));
  const f = path.join(dir, `${today()}.jsonl`);
  const out = rows.map((r) => JSON.stringify({ _capturedAt: nowISO(), ...r })).join('\n') + '\n';
  fs.appendFileSync(f, out);
  return f;
}

/**
 * 读取某 dataset 的全部历史快照，供趋势计算与报告使用。
 *
 * 同日重跑去重：快照是追加写（永不覆盖，这样原始记录不会丢），
 * 但同一天重复运行采集器会在同一个文件里叠加重复行。若不去重，
 * 分析层会把同一格算两次 —— 静默的数据污染。
 * 策略：同一天内按业务主键保留最后一条（最后一次采集为准）。
 */
const DEDUP_KEYS = {
  mindshare: (r) => [r.cc, r.dimension, r.layer].join('|'),
  charts: (r) => [r.cc, r.genre, r.kind].join('|'),
  app_metrics: (r) => [r.app, r.cc].join('|'),
};

function loadSnapshots(dataset, { sinceDate = null, dedup = true } = {}) {
  const dir = path.join(DIRS.snapshots, dataset);
  if (!fs.existsSync(dir)) return [];
  const keyOf = DEDUP_KEYS[dataset];
  const rows = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.jsonl')) continue;
    const d = f.replace('.jsonl', '');
    if (sinceDate && d < sinceDate) continue;
    const dayRows = [];
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { dayRows.push({ _date: d, ...JSON.parse(line) }); } catch (_) {}
    }
    if (dedup && keyOf) {
      const byKey = new Map();
      for (const r of dayRows) byKey.set(keyOf(r), r); // 后写覆盖前写
      rows.push(...byKey.values());
    } else {
      rows.push(...dayRows);
    }
  }
  return rows;
}

/** 列出某 dataset 已有的快照日期（趋势可用天数） */
function snapshotDates(dataset) {
  const dir = path.join(DIRS.snapshots, dataset);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace('.jsonl', '')).sort();
}

function log(...a) {
  process.stdout.write(`[${new Date().toTimeString().slice(0, 8)}] ${a.join(' ')}\n`);
}

module.exports = { ROOT, DIRS, RATE, stats, today, nowISO, ensureDir, sleep, fetchJSON, appendSnapshot, loadSnapshots, snapshotDates, log };
