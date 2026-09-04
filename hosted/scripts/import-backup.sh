#!/bin/zsh
# 画面右上の「バックアップ」で保存した JSON を、hosted 版の /api/import へ送る。
# 使い方: PAPERLEX_IMPORT_TOKEN=... ./scripts/import-backup.sh <バックアップ.json> <サイトURL>
set -euo pipefail

backup="${1:-}"
base_url="${2:-}"
token="${PAPERLEX_IMPORT_TOKEN:-}"

if [[ -z "$backup" || -z "$base_url" ]]; then
  echo "使い方: PAPERLEX_IMPORT_TOKEN=... $0 <バックアップ.json> <サイトURL>" >&2
  exit 2
fi
if [[ ! -f "$backup" ]]; then
  echo "バックアップ $backup が見つかりません。" >&2
  exit 2
fi
if [[ -z "$token" ]]; then
  echo "PAPERLEX_IMPORT_TOKEN を環境変数で渡してください。" >&2
  exit 2
fi

/usr/bin/python3 -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$backup" \
  || { echo "$backup は JSON として読めません。" >&2; exit 2; }

while [[ "$base_url" == */ ]]; do base_url="${base_url%/}"; done

http_status="$(/usr/bin/curl -sS -o /tmp/paperlex-import-response.json -w '%{http_code}' \
  -X POST "$base_url/api/import" \
  -H 'Content-Type: application/json' \
  -H "X-PaperLex-Import-Token: $token" \
  -H "Origin: $base_url" \
  --data-binary "@$backup")"

if [[ "$http_status" != "200" ]]; then
  echo "取り込みに失敗しました (HTTP $http_status)" >&2
  /bin/cat /tmp/paperlex-import-response.json >&2
  echo >&2
  exit 1
fi

/bin/cat /tmp/paperlex-import-response.json
echo
echo "取り込みが終わったら、PAPERLEX_IMPORT_TOKEN は削除するか別の値に変更してください。"
echo "  npx wrangler secret delete PAPERLEX_IMPORT_TOKEN"
