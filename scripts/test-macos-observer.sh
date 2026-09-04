#!/bin/zsh
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
source_dir="$(cd -- "$script_dir/.." && pwd -P)"
observer="$source_dir/build/PaperLex Observer.app/Contents/MacOS/PaperLexLookupObserver"
observer_source="$source_dir/macos/PaperLexLookupObserver.m"
capture_source="$source_dir/macos/PaperLexCapture.m"
capture="$source_dir/build/paperlex-capture"

"$source_dir/scripts/build-macos-helper.sh" >/dev/null

assert_match() {
  local expected="$1"
  local title="$2"
  local selected="${3:-}"
  local actual
  actual="$("$observer" --match-title "$title" "$selected")"
  if [[ "$actual" != "$expected" ]]; then
    echo "期待: $expected / 実際: $actual / メニュー: $title" >&2
    exit 1
  fi
}

assert_rejected() {
  local title="$1"
  local output=""
  local exit_code=0
  output="$("$observer" --match-title "$title" 2>&1)" || exit_code=$?
  if [[ "$exit_code" -eq 0 || "$output" != "NO_MATCH" ]]; then
    echo "誤検知: $title (status=$exit_code, output=$output)" >&2
    exit 1
  fi
}

assert_selection() {
  local expected="$1"
  local current="$2"
  local cached="$3"
  local age="$4"
  local actual
  actual="$("$observer" --resolve-selection "$current" "$cached" "$age")"
  if [[ "$actual" != "$expected" ]]; then
    echo "選択語解決の期待: $expected / 実際: $actual" >&2
    exit 1
  fi
}

assert_no_selection() {
  local current="$1"
  local cached="$2"
  local age="$3"
  local output=""
  local exit_code=0
  output="$("$observer" --resolve-selection "$current" "$cached" "$age" 2>&1)" || exit_code=$?
  if [[ "$exit_code" -eq 0 || "$output" != "NO_SELECTION" ]]; then
    echo "期限切れ選択語を採用しました (status=$exit_code, output=$output)" >&2
    exit 1
  fi
}

assert_session() {
  local expected="$1"
  local mode="$2"
  local bundle_identifier="$3"
  local frontmost_pid="$4"
  local cached_pid="$5"
  local cached_age="$6"
  local actual
  actual="$("$observer" --resolve-session "$mode" "$bundle_identifier" "$frontmost_pid" "$cached_pid" "$cached_age")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Lookup sessionの期待: $expected / 実際: $actual" >&2
    exit 1
  fi
}

assert_no_session() {
  local mode="$1"
  local bundle_identifier="$2"
  local frontmost_pid="$3"
  local cached_pid="$4"
  local cached_age="$5"
  local output=""
  local exit_code=0
  output="$("$observer" --resolve-session "$mode" "$bundle_identifier" "$frontmost_pid" "$cached_pid" "$cached_age" 2>&1)" || exit_code=$?
  if [[ "$exit_code" -eq 0 || "$output" != "NO_SESSION" ]]; then
    echo "無効なLookup sessionを採用しました (status=$exit_code, output=$output)" >&2
    exit 1
  fi
}

assert_source_contains() {
  local contract="$1"
  local expected="$2"
  if ! /usr/bin/grep -Fq -- "$expected" "$observer_source"; then
    echo "CGEventTap契約違反: $contract ($expected が見つかりません)" >&2
    exit 1
  fi
}

assert_source_excludes() {
  local contract="$1"
  local rejected="$2"
  if /usr/bin/grep -Fq -- "$rejected" "$observer_source"; then
    echo "CGEventTap契約違反: $contract ($rejected が残っています)" >&2
    exit 1
  fi
}

assert_canonical_term() {
  local expected="$1"
  local raw="$2"
  local actual
  actual="$("$capture" --canonical-only "$raw")"
  if [[ "$actual" != "$expected" ]]; then
    echo "見出し語整形の期待: $expected / 実際: $actual / 入力: $raw" >&2
    exit 1
  fi
}

# 選択に混ざった句読点や行末ハイフンで辞書結果が変わらないことを、辞書の中身に依存せず確かめる。
assert_same_definition() {
  local raw="$1"
  local canonical="$2"
  local raw_output=""
  local canonical_output=""
  raw_output="$("$capture" --definition-only "$raw" 2>/dev/null)" || true
  canonical_output="$("$capture" --definition-only "$canonical" 2>/dev/null)" || true
  if [[ "$raw_output" != "$canonical_output" ]]; then
    echo "句読点付きの選択で辞書結果が変わりました: $raw" >&2
    exit 1
  fi
}

assert_capture_source_contains() {
  local contract="$1"
  local expected="$2"
  if ! /usr/bin/grep -Fq -- "$expected" "$capture_source"; then
    echo "capture helper契約違反: $contract ($expected が見つかりません)" >&2
    exit 1
  fi
}

assert_canonical_term "suffice" "suffice."
assert_canonical_term "suffice" "“suffice”"
assert_canonical_term "suffice" "(suffice),"
assert_canonical_term "suffice" "suffice[12]"
assert_canonical_term "suffice" "suffice*"
assert_canonical_term "e.g." "e.g."
assert_canonical_term "a-priori" "a-priori"
assert_canonical_term "C++" "C++"
assert_same_definition "suffice." "suffice"
assert_same_definition "suf-fice" "suffice"
assert_same_definition "“contrastive”" "contrastive"

assert_match "ephemeral" '“ephemeral”を調べる'
assert_match "amortized analysis" 'Look Up “amortized analysis”'
assert_match "regularization" 'Look Up' 'regularization'
assert_match "causal inference" '「causal inference」を辞書で調べる'
assert_rejected 'コピー'
assert_rejected 'Googleで調べる'
assert_rejected 'サービス > PaperLex に保存'
assert_rejected 'Look Up Documentation “Bayes”'
assert_rejected 'Lookup table “Bayes”'
assert_selection "new term" "new term" "old term" "1"
assert_selection "cached term" "" "cached term" "1"
assert_no_selection "" "expired term" "10"
assert_session "123" "begin" "com.apple.Preview" "123" "0" "0"
assert_session "123" "continue" "com.apple.TextInputMenuAgent" "999" "123" "1"
assert_no_session "continue" "com.apple.TextInputMenuAgent" "999" "123" "10"
assert_no_session "begin" "com.apple.TextEdit" "999" "0" "0"

assert_source_contains "listen-only event tapを使う" "kCGEventTapOptionListenOnly"
assert_source_contains "右クリックを監視する" "CGEventMaskBit(kCGEventRightMouseDown)"
assert_source_contains "マウス移動を監視する" "CGEventMaskBit(kCGEventMouseMoved)"
assert_source_contains "左ボタン押下を監視する" "CGEventMaskBit(kCGEventLeftMouseDown)"
assert_source_contains "左ボタン解放を監視する" "CGEventMaskBit(kCGEventLeftMouseUp)"
assert_source_contains "イベントを抑止せず返す" "return event;"
assert_source_contains "無効化されたtapを再有効化する" "CGEventTapEnable("
assert_source_contains "timeoutによるtap無効化を処理する" "kCGEventTapDisabledByTimeout"
assert_source_contains "user inputによるtap無効化を処理する" "kCGEventTapDisabledByUserInput"
assert_source_contains "常駐observerの寿命を明示する" "objc_precise_lifetime"
assert_source_contains "tap作成失敗後に再試行する" "trusted && listening && !strongSelf->_eventTap"
assert_source_contains "Preview applicationを起点にAX hit-testする" "AXUIElementCreateApplication(processIdentifier)"
assert_source_contains "menu itemの親階層を十分に探索する" "depth < 16"
assert_source_contains "非menu要素をsystem failureと誤記しない" "*hitTestError = kAXErrorNoValue"
assert_source_contains "右クリック後はPreview PID sessionを使う" "self.lookupProcessIdentifier"
assert_source_contains "メニュー操作中は猶予を延長する" "refreshLookupSession"
assert_source_contains "猶予切れでもメニュークリックは拾う" "eventType != kCGEventLeftMouseUp || self.lookupProcessIdentifier <= 0"
assert_source_excludes "system-wide AX hit-testを使わない" "AXUIElementCreateSystemWide()"
assert_source_excludes "旧NSEvent global monitorを使わない" "addGlobalMonitorForEventsMatchingMask"
assert_capture_source_contains "private Sites認証トークンを任意設定できる" 'configuration[@"sitesBearerToken"]'
assert_capture_source_contains "Sites認証ヘッダーを送る" '@"OAI-Sites-Authorization"'
assert_capture_source_contains "選択語の前後の句読点を落とす" "TrimEdgePunctuation"
assert_capture_source_contains "省略形のピリオドは残す" "DropSentencePeriod"

/usr/bin/plutil -lint "$source_dir/build/PaperLex Observer.app/Contents/Info.plist" >/dev/null
/usr/bin/codesign --verify --deep --strict "$source_dir/build/PaperLex Observer.app"

echo "PaperLex Observer: メニュー判定 9件、選択語解決 3件、Lookup session 4件、見出し語整形 11件、observer契約 19件、capture helper契約 4件、plist、署名の検証に成功しました。"
