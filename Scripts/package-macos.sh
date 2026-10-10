#!/usr/bin/env bash
# Build a self-contained downloadable app on the matching macOS architecture.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
NODE_VERSION="24.14.0"
ARCH="$(node -p 'process.arch')"
case "$ARCH" in arm64|x64) ;; *) echo 'Unsupported architecture' >&2; exit 1 ;; esac
[ "$(uname -s)" = Darwin ] || { echo 'Build on macOS.' >&2; exit 1; }
VERSION="$(node -p 'require("./package.json").version')"
WORK="$ROOT/dist-shell/package-$ARCH"
APP="$WORK/Sprite.app"
RESOURCES="$APP/Contents/Resources"
PAYLOAD="$RESOURCES/runtime"
mkdir -p "$WORK" "$ROOT/release"

Scripts/build-app.sh release
ditto "$ROOT/dist-shell/Sprite.app" "$APP"
rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD/bin"
ARCHIVE="node-v$NODE_VERSION-darwin-$ARCH.tar.gz"
curl --fail --location --connect-timeout 15 --max-time 180 --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/$ARCHIVE" -o "$WORK/$ARCHIVE"
curl --fail --location --connect-timeout 15 --max-time 180 --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
(cd "$WORK" && awk -v file="$ARCHIVE" '$2 == file { print; found=1 } END { if (!found) exit 1 }' SHASUMS256.txt > node.sha256 && shasum -a 256 -c node.sha256)
tar -xzf "$WORK/$ARCHIVE" -C "$WORK"
cp "$WORK/node-v$NODE_VERSION-darwin-$ARCH/bin/node" "$PAYLOAD/bin/node"
cp "$WORK/node-v$NODE_VERSION-darwin-$ARCH/LICENSE" "$PAYLOAD/NODE-LICENSE"
cp LICENSE "$PAYLOAD/SPRITE-LICENSE"
cp Scripts/runtime/package.json Scripts/runtime/package-lock.json "$PAYLOAD/"
npm ci --prefix "$PAYLOAD" --omit=dev --ignore-scripts --no-audit --no-fund
cat > "$PAYLOAD/bin/pi" <<'PI'
#!/bin/bash
set -euo pipefail
runtime_bin="$(cd "$(dirname "$0")" && pwd)"
exec "$runtime_bin/node" "$runtime_bin/../node_modules/@mariozechner/pi-coding-agent/dist/cli.js" "$@"
PI
chmod +x "$PAYLOAD/bin/pi"
# Copy product code only: no tests, user files, journal, config or development notes.
SPRITE_PACKAGE_PAYLOAD="$PAYLOAD" node --input-type=module <<'COPY'
import fs from 'node:fs';
import path from 'node:path';
for (const dir of ['core', 'contracts', 'pi-extension']) {
  fs.cpSync(dir, path.join(process.env.SPRITE_PACKAGE_PAYLOAD, dir), { recursive: true,
    filter: source => !source.split(path.sep).includes('__test__') && !source.endsWith('.test.ts') });
}
COPY
cp Scripts/bootstrap-runtime.mjs "$RESOURCES/"
cp Scripts/uninstall-app.command "$RESOURCES/Uninstall Sprite.command"
# Sign all bundled native executables/modules before sealing the app's resources.
SPRITE_PACKAGE_PAYLOAD="$PAYLOAD" python3 - <<'SIGN'
from pathlib import Path
import os, subprocess
magics = {b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'}
for item in Path(os.environ['SPRITE_PACKAGE_PAYLOAD']).rglob('*'):
    if item.is_file() and not item.is_symlink():
        with item.open('rb') as stream: magic = stream.read(4)
        if magic in magics: subprocess.run(['codesign', '--force', '--sign', '-', str(item)], check=True, capture_output=True)
SIGN
SPRITE_PACKAGE_RESOURCES="$RESOURCES" SPRITE_PACKAGE_VERSION="$VERSION" node --input-type=module <<'MANIFEST'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const resources = process.env.SPRITE_PACKAGE_RESOURCES;
const payload = path.join(resources, 'runtime');
const hash = createHash('sha256');
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(dir, entry.name);
    hash.update(path.relative(payload, name));
    if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(name));
    else if (entry.isDirectory()) walk(name);
    else hash.update(fs.readFileSync(name));
  }
}
walk(payload);
const version = process.env.SPRITE_PACKAGE_VERSION;
fs.writeFileSync(path.join(resources, 'runtime-manifest.json'), JSON.stringify({version, arch: process.arch,
  node: '24.14.0', pi: '0.70.2', deploymentId: `${version}-${process.arch}-${hash.digest('hex').slice(0, 16)}`}, null, 2) + '\n');
MANIFEST
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
"$PAYLOAD/bin/node" --version
"$PAYLOAD/bin/pi" --version
"$PAYLOAD/bin/node" Scripts/verify-package.mjs "$APP"

STAGE="$WORK/dmg"
rm -rf "$STAGE"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Sprite.app"
ln -s /Applications "$STAGE/Applications"
cp INSTALL.md "$STAGE/Installation.md"
cp INSTALL.zh.md "$STAGE/安装说明.md"
cp Scripts/uninstall-app.command "$STAGE/Uninstall Sprite.command"
DMG="$ROOT/release/Sprite-$VERSION-$ARCH.dmg"
ZIP="$ROOT/release/Sprite-$VERSION-$ARCH.zip"
hdiutil create -volname "Sprite $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
(cd "$ROOT/release" && shasum -a 256 "$(basename "$DMG")" "$(basename "$ZIP")" > "SHA256SUMS-$ARCH.txt")
echo "Built $DMG and $ZIP"
