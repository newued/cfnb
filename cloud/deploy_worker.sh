#!/usr/bin/env bash
# 部署 Cloudflare Worker 定时触发器
#
# 用法：
#   CF_TOKEN=xxx GH_TOKEN=yyy bash cloud/deploy_worker.sh
#
# 可选环境变量：
#   CF_ACCOUNT_ID  不填则自动查询
#   WORKER_NAME    默认 cfnb-cron
#   CRON_EXPR      默认 "7,37 * * * *"
set -euo pipefail

CF_TOKEN="${CF_TOKEN:?需要 CF_TOKEN（带 Workers 脚本编辑权限）}"
GH_TOKEN="${GH_TOKEN:?需要 GH_TOKEN（GitHub PAT，repo 权限）}"
WORKER_NAME="${WORKER_NAME:-cfnb-cron}"
CRON_EXPR="${CRON_EXPR:-7,37 * * * *}"
SCRIPT_FILE="$(dirname "$0")/worker_cron.js"
API="https://api.cloudflare.com/client/v4"

echo "== 1. 获取账户 ID =="
if [ -z "${CF_ACCOUNT_ID:-}" ]; then
  CF_ACCOUNT_ID=$(curl -s --max-time 20 -H "Authorization: Bearer $CF_TOKEN" "$API/accounts" \
    | python -c "import sys,json;d=json.load(sys.stdin);print(d['result'][0]['id'] if d.get('result') else '')")
fi
[ -z "$CF_ACCOUNT_ID" ] && { echo "FAIL: 无法获取账户 ID（token 无效或缺少账户读取权限）"; exit 1; }
echo "   account = $CF_ACCOUNT_ID"

echo "== 2. 部署 Worker 脚本 =="
META=$(python -c "
import json
print(json.dumps({
  'main_module': 'worker_cron.js',
  'compatibility_date': '2024-11-01',
  'bindings': [{'type':'plain_text','name':'TARGET_REPO','text':'newued/cfnb-sub'}]
}))
")

curl -s --max-time 60 -X PUT "$API/accounts/$CF_ACCOUNT_ID/workers/scripts/$WORKER_NAME" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -F "metadata=$META;type=application/json" \
  -F "worker_cron.js=@$SCRIPT_FILE;type=application/javascript+module" \
  -o ./wk_deploy.json -w "   http=%{http_code}\n"

python -c "
import json
d=json.load(open('./wk_deploy.json'))
print('   success =', d.get('success'))
if not d.get('success'):
    print('   errors =', json.dumps(d.get('errors'), ensure_ascii=False)[:400])
    raise SystemExit(1)
"

echo "== 3. 写入 GH_TOKEN 密钥 =="
curl -s --max-time 30 -X PUT "$API/accounts/$CF_ACCOUNT_ID/workers/scripts/$WORKER_NAME/secrets" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d "$(python -c "
import json,os
print(json.dumps({'name':'GH_TOKEN','text':os.environ['GH_TOKEN'],'type':'secret_text'}))
")" -o ./wk_secret.json -w "   http=%{http_code}\n"
python -c "
import json
d=json.load(open('./wk_secret.json'))
print('   success =', d.get('success'))
if not d.get('success'): print('   errors =', json.dumps(d.get('errors'), ensure_ascii=False)[:300])
"

echo "== 4. 设置 Cron 定时器 =="
curl -s --max-time 30 -X PUT "$API/accounts/$CF_ACCOUNT_ID/workers/scripts/$WORKER_NAME/schedules" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d "$(python -c "
import json,os
print(json.dumps({'crons':[os.environ.get('CRON_EXPR','7,37 * * * *')]}))
")" -o ./wk_cron.json -w "   http=%{http_code}\n"
python -c "
import json
d=json.load(open('./wk_cron.json'))
print('   success =', d.get('success'), '| crons =', json.dumps(d.get('result'), ensure_ascii=False)[:200])
"

echo "== 5. 尝试启用 workers.dev 子域 =="
SUBDOMAIN=$(curl -s --max-time 20 -H "Authorization: Bearer $CF_TOKEN" \
  "$API/accounts/$CF_ACCOUNT_ID/workers/subdomain" \
  | python -c "import sys,json;d=json.load(sys.stdin);print((d.get('result') or {}).get('subdomain') or '')" 2>/dev/null || echo "")
if [ -z "$SUBDOMAIN" ]; then
  echo "   未配置，尝试创建默认子域..."
  curl -s --max-time 20 -X PUT "$API/accounts/$CF_ACCOUNT_ID/workers/subdomain" \
    -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"subdomain\":\"$(echo $CF_ACCOUNT_ID | cut -c1-12)\"}" >/dev/null 2>&1 || true
  SUBDOMAIN=$(curl -s --max-time 20 -H "Authorization: Bearer $CF_TOKEN" \
    "$API/accounts/$CF_ACCOUNT_ID/workers/subdomain" \
    | python -c "import sys,json;d=json.load(sys.stdin);print((d.get('result') or {}).get('subdomain') or '')" 2>/dev/null || echo "")
fi
if [ -n "$SUBDOMAIN" ]; then
  echo "   上线地址: https://$WORKER_NAME.$SUBDOMAIN.workers.dev/"
else
  echo "   未启用 workers.dev（不影响 Cron 定时触发）"
fi

echo "== 完成 =="
echo "Cron 表达式: $CRON_EXPR"
