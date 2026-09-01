#!/bin/zsh
set -euo pipefail

launch_plist="$HOME/Library/LaunchAgents/io.paperlex.app.plist"
observer_launch_plist="$HOME/Library/LaunchAgents/io.paperlex.lookup-observer.plist"
observer_target="$HOME/Applications/PaperLex Observer.app"
service_target="$HOME/Library/Services/PaperLex に保存.workflow"
support_dir="$HOME/Library/Application Support/PaperLex"
archive_dir="$HOME/Library/Application Support/PaperLex-uninstalled-$(/bin/date +%Y%m%d-%H%M%S)"

stop_agent() {
  local label="$1"
  local service="gui/$UID/$label"
  local inspection=""

  if inspection="$(/bin/launchctl print "$service" 2>&1)"; then
    if ! /bin/launchctl bootout "$service"; then
      echo "$label を停止できなかったため、アンインストールを中断しました。" >&2
      return 1
    fi
    for attempt in {1..20}; do
      if ! /bin/launchctl print "$service" >/dev/null 2>&1; then
        return 0
      fi
      /bin/sleep 0.1
    done
    echo "$label の停止を確認できなかったため、アンインストールを中断しました。" >&2
    return 1
  fi

  if [[ "$inspection" == *"Could not find service"* || "$inspection" == *"service not found"* ]]; then
    return 0
  fi
  echo "$label の登録状態を確認できなかったため、アンインストールを中断しました: $inspection" >&2
  return 1
}

stop_agent io.paperlex.app
stop_agent io.paperlex.lookup-observer
if [[ -e "$launch_plist" ]]; then /bin/mv "$launch_plist" "$archive_dir.launch-agent.plist"; fi
if [[ -e "$observer_launch_plist" ]]; then /bin/mv "$observer_launch_plist" "$archive_dir.observer-launch-agent.plist"; fi
if [[ -e "$observer_target" ]]; then /bin/mv "$observer_target" "$archive_dir.observer.app"; fi
if [[ -e "$service_target" ]]; then /bin/mv "$service_target" "$archive_dir.workflow"; fi
if [[ -e "$support_dir" ]]; then /bin/mv "$support_dir" "$archive_dir"; fi
/System/Library/CoreServices/pbs -flush 2>/dev/null || true
/System/Library/CoreServices/pbs -update 2>/dev/null || true

echo "PaperLex と PaperLex Observer を停止し、設定・単語データ・アプリを $archive_dir 系のパスへ退避しました。"
