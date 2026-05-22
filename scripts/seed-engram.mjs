/**
 * seed-engram.mjs — Import existing memory files into engram plugin
 *
 * Usage:  cd ~/.openclaw && node seed-engram.mjs
 *
 * Reads:
 *   - ~/.openclaw/workspace/MEMORY.md (main memory file)
 *   - ~/.openclaw/workspace/memory/YYYY-MM-DD.md (daily memory files)
 *
 * Stores to:
 *   - SQLite: ~/.openclaw/memory/facts.db
 *   - LanceDB: ~/.openclaw/memory/lancedb
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

// ============================================================================
// Configuration
// ============================================================================

const HOME = homedir();
const OPENCLAW_DIR = join(HOME, ".openclaw");
const CONFIG_PATH = join(OPENCLAW_DIR, "openclaw.json");
const MEMORY_MD = join(OPENCLAW_DIR, "workspace", "MEMORY.md");
const DAILY_DIR = join(OPENCLAW_DIR, "workspace", "memory");
const SQLITE_PATH = join(OPENCLAW_DIR, "memory", "facts.db");
const LANCE_PATH = join(OPENCLAW_DIR, "memory", "lancedb");
const MODEL = "text-embedding-3-small";
const VECTOR_DIM = 1536;

// Rate limiting for OpenAI
const EMBED_DELAY_MS = 100;
const BATCH_SIZE = 20;

// ============================================================================
// Resolve OpenAI API Key
// ============================================================================

function getApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;

  if (existsSync(CONFIG_PATH)) {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    const entries = config?.plugins?.entries || {};
    const hybrid = entries["engram"];
    if (hybrid?.config?.embedding?.apiKey) {
      const key = hybrid.config.embedding.apiKey;
      if (key.startsWith("sk-")) return key;
      const match = key.match(/\$\{(\w+)\}/);
      if (match && process.env[match[1]]) return process.env[match[1]];
    }
    // Fallback: scan entire config for any OpenAI key
    const jsonStr = JSON.stringify(config);
    const keyMatch = jsonStr.match(/sk-proj-[A-Za-z0-9_-]{20,}/);
    if (keyMatch) return keyMatch[0];
  }

  throw new Error("Cannot find OpenAI API key. Set OPENAI_API_KEY env var.");
}

// ============================================================================
// OpenAI Embeddings
// ============================================================================

async function embed(text, apiKey) {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: MODEL, input: text }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.data[0].embedding;
}

// ============================================================================
// LanceDB
// ============================================================================

let lanceDb = null;
let lanceTable = null;

async function initLance() {
  const lancedb = await import("@lancedb/lancedb");
  lanceDb = await lancedb.connect(LANCE_PATH);
  const tables = await lanceDb.tableNames();

  if (tables.includes("memories")) {
    lanceTable = await lanceDb.openTable("memories");
  } else {
    lanceTable = await lanceDb.createTable("memories", [
      {
        id: "__schema__",
        text: "",
        vector: new Array(VECTOR_DIM).fill(0),
        importance: 0,
        category: "other",
        createdAt: 0,
      },
    ]);
    await lanceTable.delete('id = "__schema__"');
  }
}

async function lanceHasDuplicate(vector) {
  try {
    const results = await lanceTable.vectorSearch(vector).limit(1).toArray();
    if (results.length === 0) return false;
    return 1 / (1 + (results[0]._distance ?? 0)) >= 0.95;
  } catch {
    return false;
  }
}

async function lanceStore(entry) {
  await lanceTable.add([entry]);
}

async function lanceCount() {
  try {
    return await lanceTable.countRows();
  } catch {
    return 0;
  }
}

// ============================================================================
// SQLite
// ============================================================================

function initSqlite() {
  mkdirSync(join(OPENCLAW_DIR, "memory"), { recursive: true });
  const db = new Database(SQLITE_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      importance REAL NOT NULL DEFAULT 0.7,
      entity TEXT,
      key TEXT,
      value TEXT,
      source TEXT NOT NULL DEFAULT 'conversation',
      created_at INTEGER NOT NULL,
      decay_class TEXT NOT NULL DEFAULT 'stable',
      expires_at INTEGER,
      last_confirmed_at INTEGER,
      confidence REAL NOT NULL DEFAULT 1.0
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      text, category, entity, key, value,
      content=facts, content_rowid=rowid,
      tokenize='porter unicode61'
    )
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, text, category, entity, key, value)
      VALUES (new.rowid, new.text, new.category, new.entity, new.key, new.value);
    END;
    CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, text, category, entity, key, value)
      VALUES ('delete', old.rowid, old.text, old.category, old.entity, old.key, old.value);
    END;
    CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, text, category, entity, key, value)
      VALUES ('delete', old.rowid, old.text, old.category, old.entity, old.key, old.value);
      INSERT INTO facts_fts(rowid, text, category, entity, key, value)
      VALUES (new.rowid, new.text, new.category, new.entity, new.key, new.value);
    END
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
    CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity);
    CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_at);
    CREATE INDEX IF NOT EXISTS idx_facts_expires ON facts(expires_at) WHERE expires_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(decay_class);
  `);

  return db;
}

// ============================================================================
// Fact Extraction
// ============================================================================

const SENSITIVE_PATTERNS = [
  /password/i, /api.?key/i, /secret/i, /token\s+is/i,
  /\bssn\b/i, /credit.?card/i,
];

function detectCategory(text) {
  const lower = text.toLowerCase();
  if (/decided|chose|went with|selected|always use|never use|over.*because|instead of.*since/i.test(lower)) return "decision";
  if (/prefer|like|love|hate|want/i.test(lower)) return "preference";
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called|uuid|number/i.test(lower)) return "entity";
  if (/born|birthday|lives|works|is\s|are\s|has\s|have\s|uses|using|running|version|model|configured|set up|installed/i.test(lower)) return "fact";
  return "other";
}

function extractStructuredFields(text, category) {
  // "X: Y" pattern (most common in this file format)
  const colonMatch = text.match(/^([A-Za-z][A-Za-z\s/()-]{1,40}):\s+(.+)$/);
  if (colonMatch) {
    return {
      entity: null,
      key: colonMatch[1].trim().toLowerCase(),
      value: colonMatch[2].trim(),
    };
  }

  // Decision patterns
  const decisionMatch = text.match(
    /(?:decided|chose|picked|went with|selected)\s+(?:to\s+)?(?:use\s+)?(.+?)(?:\s+(?:because|since|for|due to|over)\s+(.+?))?\.?$/i,
  );
  if (decisionMatch) {
    return { entity: "decision", key: decisionMatch[1].trim().slice(0, 100), value: decisionMatch[2]?.trim() || "" };
  }

  // Convention/rule
  const ruleMatch = text.match(/(?:always|never|must|should always|should never)\s+(.+?)\.?$/i);
  if (ruleMatch) {
    return { entity: "convention", key: ruleMatch[1].trim().slice(0, 100), value: text.toLowerCase().includes("never") ? "never" : "always" };
  }

  // Possessive: "X's Y is Z" / "My Y is Z"
  const possessiveMatch = text.match(/(?:(\w+(?:\s+\w+)?)'s|[Mm]y)\s+(.+?)\s+(?:is|are|was)\s+(.+?)\.?$/);
  if (possessiveMatch) {
    return { entity: possessiveMatch[1] || "user", key: possessiveMatch[2].trim(), value: possessiveMatch[3].trim() };
  }

  // Preference
  const preferMatch = text.match(/[Ii]\s+(prefer|like|love|hate|want|need|use)\s+(.+?)\.?$/);
  if (preferMatch) {
    return { entity: "user", key: preferMatch[1], value: preferMatch[2].trim() };
  }

  // Entity detection
  if (category === "entity") {
    const words = text.split(/\s+/);
    const properNouns = words.filter((w) => /^[A-Z][a-z]+/.test(w));
    if (properNouns.length > 0) return { entity: properNouns[0], key: null, value: null };
  }

  return { entity: null, key: null, value: null };
}

function classifyDecay(entity, key, value, text) {
  const keyLower = (key || "").toLowerCase();
  const textLower = text.toLowerCase();

  const permanentKeys = ["name", "email", "api_key", "api_endpoint", "architecture", "decision", "birthday", "born", "phone", "language", "location", "mission", "identity", "number"];
  if (permanentKeys.some((k) => keyLower.includes(k))) return "permanent";
  if (/\b(decided|architecture|always use|never use|mission|identity)\b/i.test(textLower)) return "permanent";
  if (entity === "decision" || entity === "convention") return "permanent";

  const sessionKeys = ["current_file", "temp", "debug", "working_on_right_now"];
  if (sessionKeys.some((k) => keyLower.includes(k))) return "session";

  const activeKeys = ["task", "todo", "wip", "branch", "sprint", "blocker"];
  if (activeKeys.some((k) => keyLower.includes(k))) return "active";
  if (/\b(working on|need to|todo|blocker|sprint)\b/i.test(textLower)) return "active";

  return "stable";
}

const TTL_DEFAULTS = {
  permanent: null,
  stable: 90 * 24 * 3600,
  active: 14 * 24 * 3600,
  session: 24 * 3600,
  checkpoint: 4 * 3600,
};

function calculateExpiry(decayClass) {
  const ttl = TTL_DEFAULTS[decayClass];
  return ttl ? Math.floor(Date.now() / 1000) + ttl : null;
}

// ============================================================================
// MEMORY.md Parser — Adapted for OBX format
// ============================================================================

function parseMemoryMd(filePath) {
  if (!existsSync(filePath)) {
    console.log(`  ⚠ ${filePath} not found, skipping`);
    return [];
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const facts = [];
  let currentSection = "";
  let currentSubSection = "";
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track code blocks
    if (/^```/.test(line.trim())) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Track section headers
    const h1Match = line.match(/^#\s+(.+)/);
    const h2Match = line.match(/^##\s+(.+)/);
    const h3Match = line.match(/^###\s+(.+)/);

    if (h1Match) { currentSection = h1Match[1].trim(); currentSubSection = ""; continue; }
    if (h2Match) { currentSubSection = h2Match[1].trim(); continue; }
    if (h3Match) { currentSubSection = h3Match[1].trim(); continue; }

    // Skip empty, horizontal rules, comments
    if (!line.trim()) continue;
    if (/^---+$/.test(line.trim())) continue;
    if (/^<!--/.test(line.trim())) continue;

    // Clean the line
    let cleaned = line
      .replace(/^[-*+•]\s+/, "")    // bullet points
      .replace(/^\d+\.\s+/, "")     // numbered lists
      .replace(/^>\s*/, "")         // blockquotes
      .replace(/\*\*(.+?)\*\*/g, "$1") // bold
      .replace(/\*(.+?)\*/g, "$1")     // italic
      .replace(/`(.+?)`/g, "$1")       // inline code
      .replace(/\[(.+?)\]\(.+?\)/g, "$1") // links
      .trim();

    // Skip too short/long/sensitive
    if (cleaned.length < 8 || cleaned.length > 500) continue;
    if (SENSITIVE_PATTERNS.some((r) => r.test(cleaned))) continue;

    // For very short items, prepend section context
    if (cleaned.length < 40 && !cleaned.includes(":") && currentSubSection) {
      const withContext = `${currentSubSection}: ${cleaned}`;
      if (withContext.length <= 500) cleaned = withContext;
    } else if (cleaned.length < 40 && !cleaned.includes(":") && currentSection) {
      const withContext = `${currentSection}: ${cleaned}`;
      if (withContext.length <= 500) cleaned = withContext;
    }

    // Skip lines that are just section-like headers without real content
    if (cleaned.match(/^[A-Z][a-z]+ [A-Z][a-z]+$/) && cleaned.length < 25) continue;

    facts.push({
      text: cleaned,
      source: `seed:${basename(filePath)}`,
      section: currentSubSection || currentSection,
    });
  }

  return facts;
}

// ============================================================================
// Daily Memory Files Parser
// ============================================================================

function parseDailyFiles() {
  const facts = [];

  if (!existsSync(DAILY_DIR)) {
    console.log(`  ⚠ ${DAILY_DIR} not found, skipping daily files`);
    return facts;
  }

  const files = readdirSync(DAILY_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();

  for (const file of files) {
    const filePath = join(DAILY_DIR, file);
    const parsed = parseMemoryMd(filePath);
    if (parsed.length > 0) {
      console.log(`  📅 ${file}: ${parsed.length} facts`);
      facts.push(...parsed.map((f) => ({ ...f, source: `seed:daily:${file}` })));
    }
  }

  return facts;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=== Memory-Hybrid Seed Script ===\n");

  const apiKey = getApiKey();
  console.log(`✓ OpenAI API key found (${apiKey.slice(0, 12)}...)\n`);

  console.log("Initializing databases...");
  const db = initSqlite();
  console.log(`  ✓ SQLite: ${SQLITE_PATH}`);

  await initLance();
  console.log(`  ✓ LanceDB: ${LANCE_PATH}\n`);

  const existingSqlite = db.prepare("SELECT COUNT(*) as cnt FROM facts").get().cnt;
  const existingLance = await lanceCount();
  console.log(`Existing data: ${existingSqlite} SQLite facts, ${existingLance} vectors\n`);

  // Parse all memory sources
  console.log("Parsing memory files...");
  const allFacts = [];

  const mainFacts = parseMemoryMd(MEMORY_MD);
  if (mainFacts.length > 0) {
    console.log(`  📄 MEMORY.md: ${mainFacts.length} facts`);
    allFacts.push(...mainFacts);
  }

  const dailyFacts = parseDailyFiles();
  allFacts.push(...dailyFacts);

  // Also check workspace root for other .md files that might have memory content
  const workspaceDir = join(OPENCLAW_DIR, "workspace");
  if (existsSync(workspaceDir)) {
    const otherMds = readdirSync(workspaceDir)
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md" && !["TOOLS.md", "AGENTS.md", "BOOTSTRAP.md"].includes(f));
    for (const md of otherMds) {
      const parsed = parseMemoryMd(join(workspaceDir, md));
      if (parsed.length > 0) {
        console.log(`  📄 ${md}: ${parsed.length} facts`);
        allFacts.push(...parsed.map((f) => ({ ...f, source: `seed:${md}` })));
      }
    }
  }

  if (allFacts.length === 0) {
    console.log("\n⚠ No facts found to import.");
    db.close();
    return;
  }

  console.log(`\nTotal candidates: ${allFacts.length}\n`);

  // Deduplicate by text before processing
  const seen = new Set();
  const uniqueFacts = allFacts.filter((f) => {
    const key = f.text.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`After dedup: ${uniqueFacts.length} unique facts\n`);

  const insertStmt = db.prepare(`
    INSERT INTO facts (id, text, category, importance, entity, key, value, source, created_at, decay_class, expires_at, last_confirmed_at, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const checkDupe = db.prepare("SELECT id FROM facts WHERE text = ? LIMIT 1");

  let stored = 0;
  let skippedDupe = 0;
  let vectorStored = 0;
  let vectorDupes = 0;
  let errors = 0;

  for (let i = 0; i < uniqueFacts.length; i++) {
    const fact = uniqueFacts[i];
    const text = fact.text;

    if ((i + 1) % 10 === 0 || i === uniqueFacts.length - 1) {
      process.stdout.write(
        `\r  Processing ${i + 1}/${uniqueFacts.length}... (${stored} stored, ${skippedDupe} dupes, ${vectorStored} vectors)`,
      );
    }

    if (checkDupe.get(text)) { skippedDupe++; continue; }

    const category = detectCategory(text);
    const extracted = extractStructuredFields(text, category);
    const decayClass = classifyDecay(extracted.entity, extracted.key, extracted.value, text);
    const expiresAt = calculateExpiry(decayClass);
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const id = randomUUID();

    try {
      insertStmt.run(id, text, category, 0.8, extracted.entity, extracted.key, extracted.value, fact.source, nowMs, decayClass, expiresAt, nowSec, 1.0);
      stored++;
    } catch (err) {
      errors++;
      console.error(`\n  ✗ SQLite error: ${err.message}`);
      continue;
    }

    // Embed and store vector
    try {
      await new Promise((r) => setTimeout(r, EMBED_DELAY_MS));
      const vector = await embed(text, apiKey);

      if (!(await lanceHasDuplicate(vector))) {
        await lanceStore({ id, text, vector, importance: 0.8, category, createdAt: nowMs });
        vectorStored++;
      } else {
        vectorDupes++;
      }
    } catch (err) {
      errors++;
      if (err.message.includes("429")) {
        console.error("\n  ⚠ Rate limited, waiting 10s...");
        await new Promise((r) => setTimeout(r, 10000));
        i--;
      } else {
        console.error(`\n  ✗ Embedding error: ${err.message}`);
      }
    }
  }

  console.log("\n");

  const finalSqlite = db.prepare("SELECT COUNT(*) as cnt FROM facts").get().cnt;
  const finalLance = await lanceCount();

  console.log("=== Seed Complete ===");
  console.log(`  SQLite:  ${stored} new facts (${skippedDupe} duplicates skipped)`);
  console.log(`  LanceDB: ${vectorStored} new vectors (${vectorDupes} vector dupes)`);
  console.log(`  Errors:  ${errors}`);
  console.log(`  Totals:  ${finalSqlite} SQLite facts, ${finalLance} vectors`);

  const breakdown = db.prepare("SELECT category, COUNT(*) as cnt FROM facts GROUP BY category").all();
  console.log("\nBy category:");
  for (const row of breakdown) console.log(`  ${row.category.padEnd(12)} ${row.cnt}`);

  const decayBreakdown = db.prepare("SELECT decay_class, COUNT(*) as cnt FROM facts GROUP BY decay_class").all();
  console.log("\nBy decay class:");
  for (const row of decayBreakdown) console.log(`  ${row.decay_class.padEnd(12)} ${row.cnt}`);

  db.close();
  console.log("\nDone! Run `openclaw hybrid-mem stats` to verify.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
