import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { ensureModel, createEmbeddingState, MODEL_PATH, cosineSimilarity } from "./rag_model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ──────────────────────────────────────────────────────────
const DB_NAME = path.join(__dirname, "docs_rag.db");

// ── Query ──────────────────────────────────────────────────────────────────
interface Chunk {
  id: number;
  file_path: string;
  content: string;
  embedding: string;
}

async function runQuery(queryText: string, topK: number, db: DatabaseType): Promise<void> {
  const embedder = await createEmbeddingState(MODEL_PATH);

  try {
    const queryEmbedding = await embedder.getEmbedding(queryText);

    const stmt = db.prepare<[], Chunk>("SELECT id, file_path, content, embedding FROM chunks");
    const rows = stmt.all();

    interface Result {
      similarity: number;
      id: number;
      file_path: string;
      content: string;
    }

    const results: Result[] = [];
    for (const row of rows) {
      const chunkEmbedding = row.embedding.split(",").map(Number);
      const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);
      results.push({
        similarity,
        id: row.id,
        file_path: row.file_path,
        content: row.content,
      });
    }

    results.sort((a, b) => b.similarity - a.similarity);

    console.log(`\nTop ${topK} results for: '${queryText}'\n`);
    for (let i = 0; i < Math.min(topK, results.length); i++) {
      const r = results[i];
      console.log(`${i + 1}. [Similarity: ${r.similarity.toFixed(4)}] [ID: ${r.id}] [${r.file_path}]`);
      console.log(`   Content: ${r.content.trim().slice(0, 200)}...`);
      console.log("-".repeat(40));
    }
  } finally {
    await embedder.dispose();
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Parse args manually (simple approach, works with tsx)
  const args = process.argv.slice(2);
  const topKIdx = args.indexOf("--top_k");
  const topK = topKIdx >= 0 ? parseInt(args[topKIdx + 1], 10) || 5 : 5;
  const queryText = args.filter((a, i) => i !== topKIdx && i !== (topKIdx > 0 ? topKIdx + 1 : -1)).join(" ");

  if (!queryText) {
    console.error("Usage: tsx query_rag_db.ts <query> [--top_k <n>]");
    process.exit(1);
  }

  // Ensure model is downloaded
  await ensureModel();

  // Check DB exists
  if (!fs.existsSync(DB_NAME)) {
    console.error(`Error: ${DB_NAME} not found. Run 'pnpm setup' first.`);
    process.exit(1);
  }

  // Open DB
  const db = new Database(DB_NAME, { readonly: true });

  try {
    await runQuery(queryText, topK, db);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
