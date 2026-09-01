#!/bin/zsh
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
app_dir="$(cd -- "$script_dir/.." && pwd -P)"
build_dir="$app_dir/build"
observer_app="$build_dir/PaperLex Observer.app"

mkdir -p "$build_dir"
/usr/bin/clang \
  -fobjc-arc \
  -Wall \
  -Wextra \
  -Werror \
  -framework Foundation \
  -framework CoreServices \
  "$app_dir/macos/PaperLexCapture.m" \
  -o "$build_dir/paperlex-capture"

mkdir -p "$observer_app/Contents/MacOS"
/bin/cp "$app_dir/macos/PaperLexLookupObserver-Info.plist" "$observer_app/Contents/Info.plist"
/usr/bin/clang \
  -fobjc-arc \
  -fblocks \
  -Wall \
  -Wextra \
  -Werror \
  -framework AppKit \
  -framework ApplicationServices \
  -framework Foundation \
  "$app_dir/macos/PaperLexLookupObserver.m" \
  -o "$observer_app/Contents/MacOS/PaperLexLookupObserver"
/usr/bin/codesign --force --sign - --identifier io.paperlex.lookup-observer "$observer_app" >/dev/null

echo "$build_dir/paperlex-capture"
echo "$observer_app"
