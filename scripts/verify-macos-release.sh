#!/usr/bin/env bash
# Run on the macOS arm64 builder after both distributables are complete.
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
test "$(uname -m)" = arm64
release_version=$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')
app='src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Mechanical Studio.app'
dmg="release/Mechanical-Studio-${release_version}-macos-arm64.dmg"
zip="release/Mechanical-Studio-${release_version}-macos-arm64.zip"
test -d "$app"
test -s "$dmg"
test -s "$zip"

# Check every native binary. The application must not bundle a browser or Node runtime.
# A filename with 'arm64' is not evidence of the actual executable architecture.
native_count=0
while IFS= read -r -d '' binary; do
  if file --brief "$binary" | grep -q 'Mach-O'; then
    binary_archs=$(lipo -archs "$binary")
    if [ "$binary_archs" != arm64 ]; then
      printf 'Unexpected architecture %s: %s\n' "$binary_archs" "$binary" >&2
      exit 1
    fi
    native_count=$((native_count + 1))
  fi
done < <(find "$app" -type f -print0)
test "$native_count" -gt 0
codesign --verify --deep --strict --verbose=2 "$app"

release_check_dir=$(mktemp -d)
mounted=false
cleanup() {
  if [ "$mounted" = true ]; then hdiutil detach "$release_check_dir/volume" -quiet || true; fi
  rm -rf "$release_check_dir"
}
trap cleanup EXIT
unzip -tq "$zip"
ditto -x -k "$zip" "$release_check_dir/zip"
zip_app="$release_check_dir/zip/Mechanical Studio.app"
test -d "$zip_app"
codesign --verify --deep --strict "$zip_app"
cmp "$app/Contents/MacOS/mechanical-studio" "$zip_app/Contents/MacOS/mechanical-studio"
test ! -e "$app/Contents/Resources/app.asar"
test ! -d "$app/Contents/Frameworks/Electron Framework.framework"
hdiutil verify "$dmg"
mkdir "$release_check_dir/volume"
hdiutil attach "$dmg" -readonly -nobrowse -mountpoint "$release_check_dir/volume" -quiet
mounted=true
dmg_app="$release_check_dir/volume/Mechanical Studio.app"
test -d "$dmg_app"
codesign --verify --deep --strict "$dmg_app"
cmp "$app/Contents/MacOS/mechanical-studio" "$dmg_app/Contents/MacOS/mechanical-studio"

(
  cd release
  shasum -a 256 "$(basename "$dmg")" "$(basename "$zip")" > SHA256SUMS.txt
  shasum -a 256 --check SHA256SUMS.txt
)
printf 'Verified %s arm64 Mach-O files, app signature, DMG and ZIP.\n' "$native_count"

printf "Package sizes (bytes):\n"
stat -f "%z %N" "$dmg" "$zip"
