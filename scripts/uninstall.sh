#!/bin/bash
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; PURPLE='\033[0;35m'; NC='\033[0m'

echo -e "${PURPLE}"
cat <<'EOF'
   ░░░ ENGRAM UNINSTALLER ░░░
   wiping the slate clean…
EOF
echo -e "${NC}"

OPENCLAW_DIR="$(npm root -g 2>/dev/null)/openclaw"
[ ! -d "$OPENCLAW_DIR" ] && OPENCLAW_DIR="/usr/lib/node_modules/openclaw"
PLUGIN_DIR="$OPENCLAW_DIR/extensions/engram"
CONFIG="$HOME/.openclaw/openclaw.json"

read -p "Also delete memory data (SQLite + LanceDB)? [y/N] " WIPE_DATA

if [ -d "$PLUGIN_DIR" ]; then
  sudo rm -rf "$PLUGIN_DIR"
  echo -e "${GREEN}✓${NC} Removed $PLUGIN_DIR"
fi

if [ -f "$CONFIG" ]; then
  cp "$CONFIG" "$CONFIG.bak.$(date +%Y%m%d%H%M%S)"
  node -e "
  const fs = require('fs');
  const c = JSON.parse(fs.readFileSync('$CONFIG','utf-8'));
  if (c.plugins?.slots?.memory === 'engram') delete c.plugins.slots.memory;
  if (c.plugins?.entries?.engram) delete c.plugins.entries.engram;
  fs.writeFileSync('$CONFIG', JSON.stringify(c, null, 2));
  "
  echo -e "${GREEN}✓${NC} Cleaned config"
fi

if [[ "$WIPE_DATA" =~ ^[Yy]$ ]]; then
  rm -rf "$HOME/.openclaw/memory/lancedb" "$HOME/.openclaw/memory/facts.db"*
  echo -e "${YELLOW}⚠${NC} Memory data wiped"
fi

echo -e "${GREEN}Done.${NC} Restart gateway: openclaw gateway restart"
