import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ensureModel, createEmbeddingState, type EmbeddingState } from "./rag_model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ──────────────────────────────────────────────────────────
const DOCS_DIR = path.join(__dirname, "docs");
const DB_NAME = path.join(__dirname, "docs_rag.db");
const CHUNK_SIZE = 1000;   // characters
const CHUNK_OVERLAP = 100; // characters

// ── Chunking ───────────────────────────────────────────────────────────────
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = start + CHUNK_SIZE;
    chunks.push(text.slice(start, end));
    start += CHUNK_SIZE - CHUNK_OVERLAP;
    if (start >= text.length) break;
  }
  return chunks;
}

// ── Recursive .md file finder ──────────────────────────────────────────────
function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

// ── Build ──────────────────────────────────────────────────────────────────
async function buildDb(): Promise<void> {
  // Check docs exist
  if (!fs.existsSync(DOCS_DIR)) {
    console.error("Error: docs/ not found. Run `pnpm sync-docs` first.");
    process.exit(1);
  }

  // Ensure model is available
  const modelPath = await ensureModel();
  const embedder = await createEmbeddingState(modelPath);

  try {
    // Open / recreate database
    const db = new Database(DB_NAME);
    db.exec("DROP TABLE IF EXISTS chunks");
    db.exec(`
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT,
        content TEXT,
        embedding TEXT
      )
    `);

    const insert = db.prepare("INSERT INTO chunks (file_path, content, embedding) VALUES (?, ?, ?)");

    // Find all .md files
    const mdFiles = findMarkdownFiles(DOCS_DIR);
    console.error(`Found ${mdFiles.length} markdown files.\n`);

    let totalChunks = 0;
    let embeddedChunks = 0;
    let skippedChunks = 0;

    // First pass: count total chunks
    for (const fullPath of mdFiles) {
      const content = fs.readFileSync(fullPath, "utf-8");
      totalChunks += chunkText(content).length;
    }

    const batchInsert = db.transaction((items: { file_path: string; content: string; embedding: string }[]) => {
      for (const item of items) {
        insert.run(item.file_path, item.content, item.embedding);
      }
    });

    const BATCH_SIZE = 50;
    const batch: { file_path: string; content: string; embedding: string }[] = [];

    for (let f = 0; f < mdFiles.length; f++) {
      const fullPath = mdFiles[f];
      const relPath = path.relative(__dirname, fullPath);

      console.error(`[${f + 1}/${mdFiles.length}] ${relPath}`);

      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const chunks = chunkText(content);
        console.error(`  ${chunks.length} chunks`);

        for (const chunk of chunks) {
          const embedding = await embedder.getEmbedding(chunk);
          if (embedding) {
            batch.push({ file_path: relPath, content: chunk, embedding: embedding.join(",") });
            embeddedChunks++;
          } else {
            skippedChunks++;
            console.error(`  Skipped chunk (no embedding)`);
          }

          // Flush batch periodically
          if (batch.length >= BATCH_SIZE) {
            batchInsert(batch);
            batch.length = 0;

            const pct = ((embeddedChunks + skippedChunks) / totalChunks * 100).toFixed(0);
            process.stderr.write(`\r  Embedding progress: ${embeddedChunks}/${totalChunks} (${pct}%)`);
          }
        }
      } catch (err) {
        console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Flush remaining
    if (batch.length > 0) {
      batchInsert(batch);
    }

    console.error(`\nDone: ${embeddedChunks} chunks embedded, ${skippedChunks} skipped.`);

    // Verify
    const count = db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
    console.error(`Database: ${DB_NAME} (${count.n} rows)`);

    db.close();
  } finally {
    await embedder.dispose();
  }
}

buildDb().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
