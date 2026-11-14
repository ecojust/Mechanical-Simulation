#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
test "$(uname -m)" = arm64
release_version=$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')
# Tauri uses WKWebView supplied by macOS; no Chromium/Node runtime is bundled.
npx tauri build --target aarch64-apple-darwin --bundles app,dmg --ci -- --locked
bundle_dir='src-tauri/target/aarch64-apple-darwin/release/bundle'
app="$bundle_dir/macos/Mechanical Studio.app"
test -d "$app"
mkdir -p release
shopt -s nullglob
dmgs=("$bundle_dir"/dmg/*.dmg)
test "${#dmgs[@]}" -eq 1
cp "${dmgs[0]}" "release/Mechanical-Studio-${release_version}-macos-arm64.dmg"
ditto -c -k --sequesterRsrc --keepParent "$app" "release/Mechanical-Studio-${release_version}-macos-arm64.zip"
printf 'Built native Tauri app and macOS arm64 packages for %s.\n' "$release_version"
