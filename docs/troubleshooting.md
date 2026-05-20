# Troubleshooting

## `Cannot find OpenClaw installation`

The installer checks `npm root -g`, `/usr/lib/node_modules`, `/usr/local/lib/node_modules`, and `~/.npm-global/lib/node_modules`. If yours is elsewhere, set:

```bash
OPENCLAW_DIR=/your/path bash scripts/install.sh
```

…or symlink it.

## `better-sqlite3` build fails

You're missing build tools:

```bash
sudo apt-get install -y build-essential python3
```

On macOS:

```bash
xcode-select --install
```

## `engram: initialized` doesn't show in logs

1. Confirm `~/.openclaw/openclaw.json` has `plugins.slots.memory = "engram"`
2. Confirm `plugins.entries.engram.enabled = true`
3. Confirm `OPENAI_API_KEY` is exported (or set inline in config)
4. `openclaw gateway restart` and watch `journalctl --user -u openclaw-gateway -f` (or your log file)

## Embeddings cost too much

Switch to the small model in config (default already):

```json
"embedding": { "model": "text-embedding-3-small" }
```

`text-embedding-3-small` is ~$0.02 per 1M tokens. Cheap.

## How do I wipe everything and start over?

```bash
bash scripts/uninstall.sh   # answers Yes to data wipe
bash scripts/install.sh     # reinstall
```
