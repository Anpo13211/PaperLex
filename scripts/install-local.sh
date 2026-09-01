#!/bin/zsh
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
source_dir="$(cd -- "$script_dir/.." && pwd -P)"
support_dir="$HOME/Library/Application Support/PaperLex"
installed_app_dir="$support_dir/app"
bin_dir="$support_dir/bin"
data_dir="$support_dir/data"
log_dir="$support_dir/logs"
backup_dir="$support_dir/backups"
capture_config="$support_dir/capture.json"
service_source="$source_dir/macos/PaperLex に保存.workflow"
service_target="$HOME/Library/Services/PaperLex に保存.workflow"
launch_plist="$HOME/Library/LaunchAgents/io.paperlex.app.plist"
observer_source="$source_dir/build/PaperLex Observer.app"
observer_target="$HOME/Applications/PaperLex Observer.app"
observer_binary="$observer_target/Contents/MacOS/PaperLexLookupObserver"
observer_launch_plist="$HOME/Library/LaunchAgents/io.paperlex.lookup-observer.plist"
observer_status="$support_dir/observer-permission.status"
node_bin="$(command -v node)"
port="8787"
listen_host="127.0.0.1"

case "${1:-}" in
  ""|--loopback) ;;
  --lan) listen_host="0.0.0.0" ;;
  *)
    echo "使い方: ./scripts/install-local.sh [--loopback|--lan]" >&2
    exit 2
    ;;
esac
if [[ "$#" -gt 1 ]]; then
  echo "使い方: ./scripts/install-local.sh [--loopback|--lan]" >&2
  exit 2
fi

if [[ -z "$node_bin" ]]; then
  echo "Node.js 22.13 以降が必要です。" >&2
  exit 1
fi
if ! "$node_bin" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)'; then
  echo "PaperLex には Node.js 22.13 以降が必要です（現在: $("$node_bin" --version)）。" >&2
  exit 1
fi

existing_value() {
  local key="$1"
  if [[ -f "$launch_plist" ]]; then
    /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$key" "$launch_plist" 2>/dev/null || true
  fi
}

password="${PAPERLEX_PASSWORD:-$(existing_value PAPERLEX_PASSWORD)}"
capture_token="${PAPERLEX_CAPTURE_TOKEN:-$(existing_value PAPERLEX_CAPTURE_TOKEN)}"
session_secret="${PAPERLEX_SESSION_SECRET:-$(existing_value PAPERLEX_SESSION_SECRET)}"
library_url="${PAPERLEX_LIBRARY_URL:-}"
[[ -n "$password" ]] || password="$(/usr/bin/openssl rand -hex 9)"
[[ -n "$capture_token" ]] || capture_token="$(/usr/bin/openssl rand -hex 24)"
[[ -n "$session_secret" ]] || session_secret="$(/usr/bin/openssl rand -hex 32)"

if [[ ! "$password" =~ '^[A-Za-z0-9._~-]{12,128}$' ]]; then
  echo "PAPERLEX_PASSWORD は12文字以上の英数字と . _ ~ - だけで指定してください。" >&2
  exit 1
fi
if [[ "${#capture_token}" -lt 24 ]]; then
  echo "PAPERLEX_CAPTURE_TOKEN は24文字以上で指定してください。" >&2
  exit 1
fi
if [[ "${#session_secret}" -lt 32 ]]; then
  echo "PAPERLEX_SESSION_SECRET は32文字以上で指定してください。" >&2
  exit 1
fi
if [[ -n "$library_url" ]]; then
  if ! library_url="$("$node_bin" "$source_dir/scripts/resolve-library-url.mjs" --library "$library_url")"; then
    echo "PAPERLEX_LIBRARY_URL は認証情報を含まない外部 HTTPS hostname を指定してください。" >&2
    exit 1
  fi
fi

preserve_capture_config=0
capture_library_url=""
if [[ -f "$capture_config" ]]; then
  if ! capture_library_url="$(PAPERLEX_EXPECTED_CAPTURE_TOKEN="$capture_token" \
    "$node_bin" "$source_dir/scripts/resolve-library-url.mjs" --capture "$capture_config")"; then
    echo "capture.json が不正です。取り込み先・token・URL を確認してください。" >&2
    exit 1
  fi
  preserve_capture_config=1
fi
if [[ "$capture_library_url" == "LOCAL" || -z "$capture_library_url" ]]; then
  capture_library_url=""
  if [[ -n "$library_url" ]]; then
    echo "PAPERLEX_LIBRARY_URL はクラウド取り込み先を設定した場合だけ指定できます。" >&2
    exit 1
  fi
elif [[ -z "$library_url" ]]; then
  library_url="$capture_library_url"
elif [[ "$library_url" != "$capture_library_url" ]]; then
  echo "PAPERLEX_LIBRARY_URL は capture.json のクラウド取り込み先と一致させてください。" >&2
  exit 1
fi

mkdir -p "$installed_app_dir/lib" "$installed_app_dir/public" "$bin_dir" "$data_dir" "$log_dir" "$backup_dir" "$HOME/Applications" "$HOME/Library/Services" "$HOME/Library/LaunchAgents"
/bin/chmod 700 "$support_dir" "$bin_dir" "$data_dir" "$log_dir" "$backup_dir"
"$source_dir/scripts/build-macos-helper.sh" >/dev/null
/usr/bin/ditto "$source_dir/public" "$installed_app_dir/public"
/usr/bin/ditto "$source_dir/lib" "$installed_app_dir/lib"
/bin/cp "$source_dir/server.mjs" "$installed_app_dir/server.mjs"
/bin/cp "$source_dir/build/paperlex-capture" "$bin_dir/paperlex-capture"
/bin/chmod 700 "$bin_dir/paperlex-capture"

backup_suffix="$(/bin/date +%Y%m%d-%H%M%S)"
if [[ -e "$service_target" ]]; then
  /bin/mv "$service_target" "$backup_dir/PaperLex に保存-$backup_suffix.workflow"
fi
/usr/bin/ditto "$service_source" "$service_target"
if [[ -e "$observer_target" ]]; then
  /bin/mv "$observer_target" "$backup_dir/PaperLex Observer-$backup_suffix.app.backup"
fi
/usr/bin/ditto "$observer_source" "$observer_target"
if [[ -e "$observer_launch_plist" ]]; then
  /bin/mv "$observer_launch_plist" "$backup_dir/io.paperlex.lookup-observer-$backup_suffix.plist"
fi

install_temp_dir="$(/usr/bin/mktemp -d "$support_dir/install.XXXXXX")"
temp_config_plist="$install_temp_dir/capture.plist"
temp_config="$install_temp_dir/capture.json"
if [[ "$preserve_capture_config" -eq 1 ]]; then
  /bin/chmod 600 "$capture_config"
else
  if [[ -e "$capture_config" ]]; then
    /bin/mv "$capture_config" "$backup_dir/capture-$backup_suffix.json"
  fi
  /usr/bin/plutil -create xml1 "$temp_config_plist"
  /usr/bin/plutil -insert baseURL -string "http://127.0.0.1:$port" "$temp_config_plist"
  /usr/bin/plutil -insert token -string "$capture_token" "$temp_config_plist"
  /usr/bin/plutil -convert json -o "$temp_config" "$temp_config_plist"
  /bin/chmod 600 "$temp_config"
  /bin/mv "$temp_config" "$capture_config"
fi

temp_plist="$install_temp_dir/io.paperlex.app.plist"
/usr/bin/plutil -create xml1 "$temp_plist"
/usr/bin/plutil -insert Label -string io.paperlex.app "$temp_plist"
/usr/bin/plutil -insert ProgramArguments -array "$temp_plist"
/usr/bin/plutil -insert ProgramArguments.0 -string "$node_bin" "$temp_plist"
/usr/bin/plutil -insert ProgramArguments.1 -string "$installed_app_dir/server.mjs" "$temp_plist"
/usr/bin/plutil -insert EnvironmentVariables -dictionary "$temp_plist"
/usr/bin/plutil -insert EnvironmentVariables.PAPERLEX_HOST -string "$listen_host" "$temp_plist"
/usr/bin/plutil -insert EnvironmentVariables.PAPERLEX_PORT -string "$port" "$temp_plist"
/usr/bin/plutil -insert EnvironmentVariables.PAPERLEX_PASSWORD -string "$password" "$temp_plist"
/usr/bin/plutil -insert EnvironmentVariables.PAPERLEX_CAPTURE_TOKEN -string "$capture_token" "$temp_plist"
/usr/bin/plutil -insert EnvironmentVariables.PAPERLEX_SESSION_SECRET -string "$session_secret" "$temp_plist"
/usr/bin/plutil -insert EnvironmentVariables.PAPERLEX_SECURE_COOKIE -string false "$temp_plist"
/usr/bin/plutil -insert EnvironmentVariables.PAPERLEX_DATA_DIR -string "$data_dir" "$temp_plist"
if [[ -n "$library_url" ]]; then
  /usr/bin/plutil -insert EnvironmentVariables.PAPERLEX_LIBRARY_URL -string "$library_url" "$temp_plist"
fi
/usr/bin/plutil -insert WorkingDirectory -string "$installed_app_dir" "$temp_plist"
/usr/bin/plutil -insert RunAtLoad -bool true "$temp_plist"
/usr/bin/plutil -insert KeepAlive -bool true "$temp_plist"
/usr/bin/plutil -insert Umask -integer 63 "$temp_plist"
/usr/bin/plutil -insert StandardOutPath -string "$log_dir/server.log" "$temp_plist"
/usr/bin/plutil -insert StandardErrorPath -string "$log_dir/server-error.log" "$temp_plist"
/bin/chmod 600 "$temp_plist"
/bin/mv "$temp_plist" "$launch_plist"

temp_observer_plist="$install_temp_dir/io.paperlex.lookup-observer.plist"
/usr/bin/plutil -create xml1 "$temp_observer_plist"
/usr/bin/plutil -insert Label -string io.paperlex.lookup-observer "$temp_observer_plist"
/usr/bin/plutil -insert ProgramArguments -array "$temp_observer_plist"
/usr/bin/plutil -insert ProgramArguments.0 -string "$observer_binary" "$temp_observer_plist"
/usr/bin/plutil -insert EnvironmentVariables -dictionary "$temp_observer_plist"
/usr/bin/plutil -insert EnvironmentVariables.PAPERLEX_OBSERVER_STATUS_PATH -string "$observer_status" "$temp_observer_plist"
/usr/bin/plutil -insert RunAtLoad -bool true "$temp_observer_plist"
/usr/bin/plutil -insert KeepAlive -bool true "$temp_observer_plist"
/usr/bin/plutil -insert LimitLoadToSessionType -string Aqua "$temp_observer_plist"
/usr/bin/plutil -insert ProcessType -string Interactive "$temp_observer_plist"
/usr/bin/plutil -insert Umask -integer 63 "$temp_observer_plist"
/usr/bin/plutil -insert StandardOutPath -string "$log_dir/observer.log" "$temp_observer_plist"
/usr/bin/plutil -insert StandardErrorPath -string "$log_dir/observer-error.log" "$temp_observer_plist"
/bin/chmod 600 "$temp_observer_plist"
/bin/mv "$temp_observer_plist" "$observer_launch_plist"
if [[ -e "$temp_config_plist" ]]; then /bin/rm "$temp_config_plist"; fi
/bin/rmdir "$install_temp_dir"

bootstrap_agent() {
  local label="$1"
  local plist="$2"
  local description="$3"
  local bootstrapped=0

  /bin/launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  for attempt in {1..20}; do
    if /bin/launchctl bootstrap "gui/$UID" "$plist" 2>/dev/null; then
      bootstrapped=1
      break
    fi
    /bin/sleep 0.2
  done
  if [[ "$bootstrapped" -ne 1 ]]; then
    echo "$description の自動起動を登録できません。$plist を確認してください。" >&2
    return 1
  fi
  /bin/launchctl enable "gui/$UID/$label"
}

bootstrap_agent io.paperlex.app "$launch_plist" "PaperLex"
/bin/rm -f "$observer_status"
bootstrap_agent io.paperlex.lookup-observer "$observer_launch_plist" "PaperLex Observer"
/System/Library/CoreServices/pbs -flush 2>/dev/null || true
/System/Library/CoreServices/pbs -update 2>/dev/null || true

ready=0
for attempt in {1..30}; do
  if /usr/bin/curl --fail --silent "http://127.0.0.1:$port/api/health" >/dev/null; then
    ready=1
    break
  fi
  /bin/sleep 0.2
done
if [[ "$ready" -ne 1 ]]; then
  echo "PaperLex の起動を確認できません。$log_dir/server-error.log を確認してください。" >&2
  exit 1
fi

lan_ip="$(/usr/sbin/ipconfig getifaddr en0 2>/dev/null || /usr/sbin/ipconfig getifaddr en1 2>/dev/null || true)"
echo "PaperLex のインストールが完了しました。"
echo "Mac:    http://127.0.0.1:$port"
if [[ -n "$library_url" ]]; then
  echo "単語帳: $library_url（Mac URL からも同じクラウド単語帳を開きます）"
  echo "旧ローカル単語帳: http://127.0.0.1:$port/?local=1"
fi
if [[ "$listen_host" == "0.0.0.0" && -n "$lan_ip" ]]; then
  echo "スマホ: http://$lan_ip:$port（同じ信頼できるWi-Fi上）"
  echo "注意: LANモードはHTTPです。外部ネットワークへは公開しないでください。"
fi
echo "パスワード: $password"
observer_permission=""
for attempt in {1..20}; do
  if [[ -s "$observer_status" ]]; then
    observer_permission="$(<"$observer_status")"
    break
  fi
  /bin/sleep 0.1
done
if [[ "$observer_permission" == "TRUSTED" ]]; then
  echo "PaperLex Observer: アクセシビリティ・入力監視ともに許可済み（TRUSTED）"
else
  echo "PaperLex Observer: macOSの許可がまだ必要です（${observer_permission:-NOT_TRUSTED}）。"
  echo "システム設定 > プライバシーとセキュリティ で、PaperLex Observer を次の2か所とも有効にしてください。"
  echo "  1. アクセシビリティ"
  echo "  2. 入力監視"
fi
echo "Previewで文字を選択し、右クリック > 「単語」を調べる と自動保存されます。"
echo "従来の 右クリック > サービス > PaperLex に保存 も予備手段として使えます。"
