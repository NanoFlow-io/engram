#!/bin/bash
set -euo pipefail

# ╔══════════════════════════════════════════════════════════════════════╗
# ║                                                                      ║
# ║   ███████╗███╗   ██╗ ██████╗ ██████╗  █████╗ ███╗   ███╗            ║
# ║   ██╔════╝████╗  ██║██╔════╝ ██╔══██╗██╔══██╗████╗ ████║            ║
# ║   █████╗  ██╔██╗ ██║██║  ███╗██████╔╝███████║██╔████╔██║            ║
# ║   ██╔══╝  ██║╚██╗██║██║   ██║██╔══██╗██╔══██║██║╚██╔╝██║            ║
# ║   ███████╗██║ ╚████║╚██████╔╝██║  ██║██║  ██║██║ ╚═╝ ██║            ║
# ║   ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝            ║
# ║                                                                      ║
# ║         hybrid long-term memory for OpenClaw agents                  ║
# ║         SQLite+FTS5 · LanceDB · OpenAI embeddings                    ║
# ║                                                                      ║
# ╚══════════════════════════════════════════════════════════════════════╝

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

print_banner() {
  echo -e "${PURPLE}"
  cat <<'EOF'
   ███████╗███╗   ██╗ ██████╗ ██████╗  █████╗ ███╗   ███╗
   ██╔════╝████╗  ██║██╔════╝ ██╔══██╗██╔══██╗████╗ ████║
   █████╗  ██╔██╗ ██║██║  ███╗██████╔╝███████║██╔████╔██║
   ██╔══╝  ██║╚██╗██║██║   ██║██╔══██╗██╔══██║██║╚██╔╝██║
   ███████╗██║ ╚████║╚██████╔╝██║  ██║██║  ██║██║ ╚═╝ ██║
   ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝
EOF
  echo -e "${CYAN}     ░ hybrid long-term memory for OpenClaw agents ░${NC}"
  echo -e "${CYAN}     ░ SQLite+FTS5 · LanceDB · embeddings           ░${NC}"
  echo ""
}

log_step() { echo -e "${BLUE}[$1/$2]${NC} ${BOLD}$3${NC}"; }
log_ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
log_warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
log_err()  { echo -e "  ${RED}✗${NC} $1"; }

print_banner

# ─────────────────────────────────────────────────────────────────────
# Locate OpenClaw
# ─────────────────────────────────────────────────────────────────────
OPENCLAW_DIR="$(npm root -g 2>/dev/null)/openclaw"
if [ ! -d "$OPENCLAW_DIR" ]; then
  for candidate in \
    "/usr/lib/node_modules/openclaw" \
    "/usr/local/lib/node_modules/openclaw" \
    "$HOME/.npm-global/lib/node_modules/openclaw"; do
    if [ -d "$candidate" ]; then OPENCLAW_DIR="$candidate"; break; fi
  done
fi

if [ ! -d "$OPENCLAW_DIR" ]; then
  log_err "Cannot find OpenClaw installation."
  echo "    Searched: \$(npm root -g)/openclaw, /usr/lib/, /usr/local/lib/, ~/.npm-global/lib/"
  echo ""
  echo "    Run: which openclaw && npm root -g"
  exit 1
fi

PLUGIN_DIR="$OPENCLAW_DIR/extensions/engram"
CONFIG="$HOME/.openclaw/openclaw.json"
REPO_URL="${ENGRAM_REPO_URL:-https://github.com/NanoFlow-io/engram.git}"
BRANCH="${ENGRAM_BRANCH:-main}"
TMP_DIR="$(mktemp -d -t engram-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo -e "${BOLD}Configuration:${NC}"
echo "  OpenClaw:  $OPENCLAW_DIR"
echo "  Plugin:    $PLUGIN_DIR"
echo "  Config:    $CONFIG"
echo "  Source:    $REPO_URL ($BRANCH)"
echo ""

# ─────────────────────────────────────────────────────────────────────
# Step 1 — Build tools
# ─────────────────────────────────────────────────────────────────────
log_step 1 6 "Checking build tools"
if ! command -v g++ &>/dev/null; then
  log_warn "Installing build-essential (sudo)…"
  sudo apt-get update -qq && sudo apt-get install -y -qq build-essential python3
fi
log_ok "g++ ready"
if ! command -v git &>/dev/null; then
  log_err "git not found — install it first."
  exit 1
fi
log_ok "git ready"

# ─────────────────────────────────────────────────────────────────────
# Step 2 — Fetch source
# ─────────────────────────────────────────────────────────────────────
log_step 2 6 "Cloning Engram from GitHub"
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TMP_DIR/engram" 2>&1 | tail -3
log_ok "Source fetched"

# ─────────────────────────────────────────────────────────────────────
# Step 3 — Install plugin files
# ─────────────────────────────────────────────────────────────────────
log_step 3 6 "Installing plugin files"
sudo mkdir -p "$PLUGIN_DIR"
sudo cp "$TMP_DIR/engram/package.json"          "$PLUGIN_DIR/"
sudo cp "$TMP_DIR/engram/openclaw.plugin.json"  "$PLUGIN_DIR/"
sudo cp -r "$TMP_DIR/engram/src"                "$PLUGIN_DIR/"
log_ok "Files copied"

# ─────────────────────────────────────────────────────────────────────
# Step 4 — Install npm deps
# ─────────────────────────────────────────────────────────────────────
log_step 4 6 "Installing dependencies (this may take a minute)"
cd "$PLUGIN_DIR"
sudo npm install --no-audit --no-fund 2>&1 | tail -3
log_ok "Plugin deps installed"

mkdir -p "$HOME/.openclaw"
cd "$HOME/.openclaw"
if [ ! -d "node_modules/better-sqlite3" ]; then
  npm install better-sqlite3 --no-audit --no-fund 2>&1 | tail -3
fi
log_ok "better-sqlite3 ready in ~/.openclaw"

# ─────────────────────────────────────────────────────────────────────
# Step 5 — Configure openclaw.json
# ─────────────────────────────────────────────────────────────────────
log_step 5 6 "Configuring openclaw.json"

if [ ! -f "$CONFIG" ]; then
  log_err "$CONFIG not found — has OpenClaw been initialized?"
  exit 1
fi

cp "$CONFIG" "$CONFIG.bak.$(date +%Y%m%d%H%M%S)"
log_ok "Backup created"

if [ -z "${OPENAI_API_KEY:-}" ]; then
  EXISTING_KEY=$(grep -oP 'sk-proj-[A-Za-z0-9_-]+' "$CONFIG" | head -1 || true)
  if [ -n "$EXISTING_KEY" ]; then
    export OPENAI_API_KEY="$EXISTING_KEY"
    log_ok "Reusing existing OpenAI key from config"
  else
    log_warn "OPENAI_API_KEY not set — Engram needs it for embeddings."
    log_warn "Set it before restart: export OPENAI_API_KEY=\"sk-proj-...\""
  fi
fi

node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('$CONFIG', 'utf-8'));
config.plugins = config.plugins || {};
config.plugins.slots = config.plugins.slots || {};
config.plugins.entries = config.plugins.entries || {};
config.plugins.slots.memory = 'engram';
if (!config.plugins.entries['engram']) {
  config.plugins.entries['engram'] = {
    enabled: true,
    hooks: { allowConversationAccess: true },
    config: {
      embedding: { apiKey: '\${OPENAI_API_KEY}', model: 'text-embedding-3-small' },
      autoCapture: true,
      autoRecall: false
    }
  };
} else {
  config.plugins.entries['engram'].enabled = true;
  config.plugins.entries['engram'].hooks = config.plugins.entries['engram'].hooks || {};
  config.plugins.entries['engram'].hooks.allowConversationAccess = true;
}
fs.writeFileSync('$CONFIG', JSON.stringify(config, null, 2), 'utf-8');
"
log_ok "Config updated, memory slot = engram"

# ─────────────────────────────────────────────────────────────────────
# Step 6 — Seed script + memory dir
# ─────────────────────────────────────────────────────────────────────
log_step 6 6 "Finishing up"
cp "$TMP_DIR/engram/scripts/seed-engram.mjs" "$HOME/.openclaw/seed-engram.mjs"
mkdir -p "$HOME/.openclaw/memory"
log_ok "Seed script → ~/.openclaw/seed-engram.mjs"
log_ok "Memory dir → ~/.openclaw/memory"

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                  ✨ ENGRAM INSTALLED SUCCESSFULLY ✨                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BOLD}Next steps:${NC}"
echo -e "  ${CYAN}1.${NC} Restart gateway:   ${YELLOW}openclaw gateway restart${NC}"
echo -e "  ${CYAN}2.${NC} Check the logs:    look for ${YELLOW}'engram: initialized'${NC}"
echo -e "  ${CYAN}3.${NC} (Optional) Seed:   ${YELLOW}node ~/.openclaw/seed-engram.mjs${NC}"
echo ""
echo -e "${PURPLE}  ░░░ remember everything. forget nothing. ░░░${NC}"
echo ""
