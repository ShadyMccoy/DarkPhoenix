#!/usr/bin/env bash
# setup-test-env.sh - make the screeps mockup runnable in a sandbox/fresh clone.
#
# WHY THIS EXISTS (measured, 2026-07-26 session): `npm install` builds two
# native modules and one webpack bundle via install scripts. In sandboxes the
# isolated-vm native build often FAILS under parallel make (missing .deps dir
# race), which rolls back the whole install. The workaround - `npm install
# --ignore-scripts` - then skips THREE build artifacts, and the third one is
# the invisible trap:
#
#   1. node_modules/isolated-vm/out/isolated_vm.node      (native, node-gyp)
#   2. node_modules/@screeps/driver/native/build/Release/native.node
#   3. node_modules/@screeps/driver/build/runtime.bundle.js   (webpack)
#
# Without #3 every mockup bot dies at script load ("Cannot find module
# '../../build/runtime.bundle.js'") and screeps-server-mockup's console parser
# DROPS the error field of the console event - so the failure is INVISIBLE:
# the server ticks, cells run, and every bot just "does nothing". If grid or
# integration runs show bots producing ZERO console output and every economy
# assertion timing out, it is this, not the bot.
#
# Idempotent: checks each artifact and builds only what's missing.
# Run from the repo root:  bash scripts/setup-test-env.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
GYP="$ROOT/node_modules/.bin/node-gyp"

if [ ! -d node_modules ] || [ ! -x "$GYP" ]; then
  echo "[setup-test-env] node_modules missing/incomplete - installing (scripts skipped; we build below)"
  npm install --ignore-scripts --no-audit --no-fund
fi

# 1. isolated-vm native module (the user-script VM).
#
# LOCATION IS NOT FIXED: depending on the lockfile/npm version, isolated-vm
# hoists to node_modules/isolated-vm OR nests under
# node_modules/@screeps/driver/node_modules/isolated-vm (measured 2026-08-09:
# the nested layout is what a fresh `npm install --ignore-scripts` produces
# here, and the old hard-coded top-level cd made this step a silent no-op-
# then-crash). Resolve the REAL path from the consumer's context - the driver
# is what actually require()s it - and check loadability from there too; a
# bare `require('isolated-vm')` from the repo root cannot see a nested copy
# and would rebuild forever. `npm rebuild isolated-vm` handles both layouts
# and uses npm's own node-gyp, so prefer it; the manual gyp fallback keeps
# the single-threaded build for the parallel-make race documented above.
IVM_DIR=$(node -e "
  const path = require('path');
  for (const base of ['@screeps/driver/node_modules/isolated-vm', 'isolated-vm']) {
    try { console.log(path.dirname(require.resolve(path.join(base, 'package.json'), { paths: [path.join(process.cwd(), 'node_modules')] }))); process.exit(0); } catch {}
  }
  process.exit(1);
" 2>/dev/null || true)
if [ -z "$IVM_DIR" ]; then
  echo "[setup-test-env] isolated-vm package not found under node_modules - npm install layout unexpected" >&2
  exit 1
fi
if ! node -e "require('$IVM_DIR')" >/dev/null 2>&1; then
  echo "[setup-test-env] building isolated-vm at $IVM_DIR (single-threaded - parallel make races)"
  npm rebuild isolated-vm --foreground-scripts >/dev/null 2>&1 \
    || (cd "$IVM_DIR" && rm -rf build out && "$GYP" configure >/dev/null && "$GYP" build -j 1)
  node -e "require('$IVM_DIR')"
  echo "[setup-test-env] isolated-vm OK"
else
  echo "[setup-test-env] isolated-vm OK (cached)"
fi

# 2. @screeps/driver native addon (pathfinder).
if [ ! -f node_modules/@screeps/driver/native/build/Release/native.node ]; then
  echo "[setup-test-env] building @screeps/driver native addon"
  (cd node_modules/@screeps/driver/native && rm -rf build && "$GYP" configure >/dev/null && "$GYP" build -j 1)
  echo "[setup-test-env] driver native OK"
else
  echo "[setup-test-env] driver native OK (cached)"
fi

# 3. @screeps/driver runtime bundle (the in-VM game runtime). THE INVISIBLE ONE.
if [ ! -f node_modules/@screeps/driver/build/runtime.bundle.js ]; then
  echo "[setup-test-env] building @screeps/driver runtime bundle (webpack)"
  (cd node_modules/@screeps/driver && npx webpack >/dev/null)
  [ -f node_modules/@screeps/driver/build/runtime.bundle.js ]
  echo "[setup-test-env] runtime bundle OK"
else
  echo "[setup-test-env] runtime bundle OK (cached)"
fi

echo "[setup-test-env] environment ready - grid/integration runs will execute bot scripts."
echo "[setup-test-env] smoke-check any time with: node scripts/probe-mockup.js"
