#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="${0:A:h:h}"
ELECTRON_APP="$PROJECT_ROOT/node_modules/electron/dist/Electron.app"
OUTPUT_DIR="$PROJECT_ROOT/dist/mac-arm64"
APP_BUNDLE="$OUTPUT_DIR/Binance统一交易台.app"
APP_RESOURCES="$APP_BUNDLE/Contents/Resources"
PACKAGED_APP="$APP_RESOURCES/app"
PLIST="$APP_BUNDLE/Contents/Info.plist"

if [[ ! -d "$ELECTRON_APP" ]]; then
  print -u2 "找不到 Electron.app，请先运行 npm install。"
  exit 1
fi

case "$OUTPUT_DIR" in
  "$PROJECT_ROOT"/dist/*) ;;
  *)
    print -u2 "拒绝清理非 dist 目录：$OUTPUT_DIR"
    exit 1
    ;;
esac

mkdir -p "$OUTPUT_DIR"
rm -rf "$APP_BUNDLE"
rm -f "$OUTPUT_DIR/README.md" "$OUTPUT_DIR/.env.example" "$OUTPUT_DIR/.env"
/usr/bin/ditto "$ELECTRON_APP" "$APP_BUNDLE"

rm -f "$APP_RESOURCES/default_app.asar"
mkdir -p "$PACKAGED_APP/node_modules"
/usr/bin/rsync -a --exclude='.DS_Store' "$PROJECT_ROOT/src/" "$PACKAGED_APP/src/"
/usr/bin/ditto "$PROJECT_ROOT/node_modules/dotenv" "$PACKAGED_APP/node_modules/dotenv"
/usr/bin/ditto "$PROJECT_ROOT/node_modules/ws" "$PACKAGED_APP/node_modules/ws"
/usr/bin/ditto "$PROJECT_ROOT/package.json" "$PACKAGED_APP/package.json"
/usr/bin/ditto "$PROJECT_ROOT/README.md" "$OUTPUT_DIR/README.md"
/usr/bin/ditto "$PROJECT_ROOT/.env.example" "$OUTPUT_DIR/.env.example"

if [[ -f "$PROJECT_ROOT/.env" ]]; then
  /usr/bin/install -m 600 "$PROJECT_ROOT/.env" "$OUTPUT_DIR/.env"
fi

/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.zzh466.binance.unified-trading" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Binance统一交易台" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Binance统一交易台" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 1.0.0" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion 1" "$PLIST"

/usr/bin/xattr -cr "$APP_BUNDLE"
/usr/bin/codesign --force --deep --sign - "$APP_BUNDLE"

print "$APP_BUNDLE"
