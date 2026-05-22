# Engram

```
   ███████╗███╗   ██╗ ██████╗ ██████╗  █████╗ ███╗   ███╗
   ██╔════╝████╗  ██║██╔════╝ ██╔══██╗██╔══██╗████╗ ████║
   █████╗  ██╔██╗ ██║██║  ███╗██████╔╝███████║██╔████╔██║
   ██╔══╝  ██║╚██╗██║██║   ██║██╔══██╗██╔══██║██║╚██╔╝██║
   ███████╗██║ ╚████║╚██████╔╝██║  ██║██║  ██║██║ ╚═╝ ██║
   ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝

           hybrid long-term memory for OpenClaw agents
```

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-plugin-purple)](https://openclaw.ai)

> **engram** *(n.)* — the physical/biochemical trace a memory leaves behind. The thing that makes "remembering" actually possible.

Engram is a memory plugin for [OpenClaw](https://openclaw.ai) agents. It gives them a brain that doesn't forget between sessions — backed by **SQLite + FTS5** for exact, structured recall and **LanceDB** for fuzzy semantic search over embeddings.

## ✨ Features

- 🧠 **Hybrid recall** — structured key/value facts + semantic vector search, queried together
- 🔍 **FTS5 full-text search** over fact text
- 📚 **Categories** — `preference`, `fact`, `decision`, `entity`, `other`
- ⏳ **Decay classes** — `permanent`, `stable`, `active`, `session`, `checkpoint` (with confidence decay)
- 🪝 **Auto-capture / auto-recall** hooks (configurable)
- 💾 **Local-first** — your memory stays on your machine
- 🔒 **Embeddings via OpenAI** (`text-embedding-3-small` or `-large`)

## 🚀 Install

One-liner (clones from this repo, copies the plugin into OpenClaw, wires the config):

```bash
curl -fsSL https://raw.githubusercontent.com/NanoFlow-io/engram/main/scripts/install.sh | bash
```

Or clone and run manually:

```bash
git clone https://github.com/NanoFlow-io/engram.git
cd engram
bash scripts/install.sh
```

After install:

```bash
export OPENAI_API_KEY="sk-proj-..."   # if not already set
openclaw gateway restart
```

Verify it loaded — look for `engram: initialized` in the gateway log.

## 🧪 Try It

From inside an OpenClaw agent session:

```
> Remember that I prefer dark mode and my coffee black.
```

Next session:

```
> What do you remember about me?
```

The agent recalls via the `memory_recall` / `memory_store` tools, both backed by Engram.

## ⚙️ Configuration

Engram is configured under `plugins.entries.engram` in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": { "memory": "engram" },
    "entries": {
      "engram": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "embedding": {
            "apiKey": "${OPENAI_API_KEY}",
            "model": "text-embedding-3-small"
          },
          "autoCapture": true,
          "autoRecall": false,
          "sqlitePath": "~/.openclaw/memory/facts.db",
          "lanceDbPath": "~/.openclaw/memory/lancedb"
        }
      }
    }
  }
}
```

| Field | Default | Notes |
|---|---|---|
| `embedding.apiKey` | — | required (use `${OPENAI_API_KEY}`) |
| `embedding.model` | `text-embedding-3-small` | or `text-embedding-3-large` |
| `autoCapture` | `true` | extract memories from conversations |
| `autoRecall` | `false` | inject relevant memories into context. Off by default — can be noisy. |
| `sqlitePath` | `~/.openclaw/memory/facts.db` | structured store |
| `lanceDbPath` | `~/.openclaw/memory/lancedb` | vector store |

## 🛠 CLI

Engram registers a `hybrid-mem` CLI command with subcommands:

```bash
openclaw hybrid-mem stats          # show fact/vector counts
openclaw hybrid-mem prune          # remove expired memories
openclaw hybrid-mem checkpoint     # manual checkpoint
openclaw hybrid-mem backfill-decay # backfill decay classes on legacy data
openclaw hybrid-mem extract-daily  # extract from daily notes
openclaw hybrid-mem search <q>     # hybrid search
openclaw hybrid-mem lookup <key>   # exact lookup
```

Verify after install:

```bash
openclaw plugins doctor
openclaw plugins inspect engram --runtime
```

## 🧱 Architecture

```
                    ┌─────────────────────┐
                    │   OpenClaw Agent    │
                    └──────────┬──────────┘
                               │
                ┌──────────────┴──────────────┐
                │       Engram Plugin         │
                └──────┬───────────────┬──────┘
                       │               │
            ┌──────────▼─────┐  ┌─────▼─────────┐
            │  SQLite + FTS5 │  │   LanceDB     │
            │  structured    │  │   vectors     │
            │  facts, keys,  │  │   semantic    │
            │  categories    │  │   recall      │
            └────────────────┘  └───────────────┘
                       ▲               ▲
                       └──────┬────────┘
                              │
                       ┌──────▼──────┐
                       │  OpenAI     │
                       │ embeddings  │
                       └─────────────┘
```

Every memory gets written to **both** stores. Recall queries hit both and merge results by relevance.

## 🗑 Uninstall

```bash
bash scripts/uninstall.sh
```

Asks before wiping memory data.

## 🤝 Contributing

PRs welcome. Open an issue if you want to discuss architecture changes first.

## 📜 License

MIT © NanoFlow

---

```
   ░░░ remember everything. forget nothing. ░░░
```
