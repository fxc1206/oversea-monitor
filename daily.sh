#!/usr/bin/env bash
# 每日采集 + 重建看板 + 推送。存档按日期累积，趋势满 2 天自动生效。
set -uo pipefail
cd "$(dirname "$0")"
export OM_INTERVAL_MS=1500
LOG=/tmp/oversea-daily.log
echo "===== $(date '+%F %T') 开始 =====" >> $LOG

node collectors/charts.js    --limit 100 >> $LOG 2>&1 || echo "charts 失败" >> $LOG
node collectors/mindshare.js --limit 10  >> $LOG 2>&1 || echo "mindshare 失败" >> $LOG
node collectors/app_metrics.js           >> $LOG 2>&1 || echo "app_metrics 失败" >> $LOG
node collectors/report.js                >> $LOG 2>&1
node collectors/build_site.js            >> $LOG 2>&1

if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -qm "data: $(date +%F) 自动采集" >> $LOG 2>&1
  for i in 1 2 3; do
    if git push origin HEAD:main >> $LOG 2>&1; then echo "推送成功" >> $LOG; break; fi
    echo "推送重试 $i" >> $LOG; sleep 30
  done
fi
echo "===== $(date '+%F %T') 结束 =====" >> $LOG
