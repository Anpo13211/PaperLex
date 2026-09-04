#!/bin/zsh
# hosted/ を Cloudflare Workers へ直接デプロイする。
# OpenAI Sites 版とはビルド成果物が同じで、認証だけが PAPERLEX_PASSWORD の有無で切り替わる。
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
hosted_dir="$(cd -- "$script_dir/.." && pwd -P)"
cd "$hosted_dir"

worker_name="${PAPERLEX_WORKER_NAME:-paperlex}"
database_name="${PAPERLEX_D1_NAME:-paperlex}"

# wrangler whoami は未ログインでも終了コード 0 を返すため、本文で判定する。
if npx --no-install wrangler whoami 2>&1 | /usr/bin/grep -q "not authenticated"; then
  echo "Cloudflare にログインしていません。先に 'npx wrangler login' を実行してください。" >&2
  exit 1
fi

database_id="${PAPERLEX_D1_ID:-}"
if [[ -z "$database_id" ]]; then
  database_id="$(npx --no-install wrangler d1 info "$database_name" --json 2>/dev/null \
    | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("uuid",""))' 2>/dev/null || true)"
fi
if [[ -z "$database_id" ]]; then
  echo "D1 データベース '$database_name' が見つかりません。" >&2
  echo "  npx wrangler d1 create $database_name" >&2
  echo "を実行してから、もう一度この script を実行してください。" >&2
  exit 1
fi

npm run build

config="$hosted_dir/dist/server/wrangler.json"
[[ -f "$config" ]] || { echo "ビルド成果物 $config がありません。" >&2; exit 1; }

# ビルドが書き出す設定は Sites 用の placeholder を含むので、実際の Worker 名と D1 に差し替える。
PAPERLEX_CONFIG="$config" \
PAPERLEX_WORKER_NAME="$worker_name" \
PAPERLEX_D1_NAME="$database_name" \
PAPERLEX_D1_ID="$database_id" \
/usr/bin/python3 <<'PY'
import json, os

path = os.environ["PAPERLEX_CONFIG"]
config = json.load(open(path, encoding="utf-8"))
config["name"] = os.environ["PAPERLEX_WORKER_NAME"]
config["topLevelName"] = os.environ["PAPERLEX_WORKER_NAME"]
config["d1_databases"] = [{
    "binding": "DB",
    "database_name": os.environ["PAPERLEX_D1_NAME"],
    "database_id": os.environ["PAPERLEX_D1_ID"],
}]
json.dump(config, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY

npx --no-install wrangler deploy -c "$config"

echo
echo "デプロイしました。まだの場合は、次の Secret を設定してください。"
echo "  npx wrangler secret put PAPERLEX_PASSWORD --name $worker_name"
echo "  npx wrangler secret put PAPERLEX_SESSION_SECRET --name $worker_name"
echo "  npx wrangler secret put PAPERLEX_CAPTURE_TOKEN --name $worker_name"
