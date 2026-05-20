# Architecture

Engram unifies two memory stores under one plugin interface:

## Layer 1 — SQLite + FTS5 (structured)

- **Table `facts`** — id, entity, key, value, category, importance, decay_class, created_at, updated_at, confidence
- **FTS5 virtual table** mirrors fact text for fast full-text queries
- Used for exact-match lookups (`entity = "Adam"`, `key = "birthday"`) and keyword search

## Layer 2 — LanceDB (semantic)

- **Table `memories`** — id, text, embedding (vector), metadata
- Embeddings via OpenAI (`text-embedding-3-small` by default, 1536 dims)
- Used for fuzzy, "vibe-based" recall: "what did Adam say about pricing?"

## Write path

```
memory_store({ entity, key, value, text, category, ... })
    │
    ├─→ SQLite: INSERT INTO facts (...)
    │   └─→ FTS5: INSERT INTO facts_fts (...)
    │
    └─→ LanceDB: append embedding row
```

## Read path

```
memory_recall({ query, entity?, limit })
    │
    ├─→ SQLite: SELECT WHERE entity=? AND (FTS MATCH ? OR LIKE ?)
    │
    └─→ LanceDB: nearestNeighbors(embed(query))
        │
        └─→ Merge + dedupe + rank by score
```

## Decay

Each memory has a `decay_class`:

| Class | Behavior |
|---|---|
| `permanent` | never decays (identity, anniversaries) |
| `stable` | slow decay (preferences) |
| `active` | medium decay (current projects) |
| `session` | fast decay (one-off context) |
| `checkpoint` | manual pre-flight save (auto-expires ~4h) |

A `memory_prune` operation walks the table and reduces `confidence` based on age + class.
