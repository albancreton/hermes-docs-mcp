import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureModel, createEmbeddingState, MODEL_PATH, cosineSimilarity, type EmbeddingMode } from "./rag_model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ──────────────────────────────────────────────────────────
const DB_NAME = path.join(__dirname, "docs_rag.db");
const DOCS_DIR = path.join(__dirname, "docs");
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 100;

// Docs from GitHub
const REPO = "NousResearch/hermes-agent";
const BRANCH = "main";
const REMOTE_DOCS_PATH = "website/docs";
const TMP_DIR = path.join(__dirname, ".tmp-download");
const ARCHIVE_URL = `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz`;

// ── Auto-setup helpers ─────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

async function downloadAndExtractDocs(): Promise<void> {
  console.error(`Downloading docs from ${REPO}...`);

  const response = await fetch(ARCHIVE_URL);
  if (!response.ok) throw new Error(`Failed: ${response.status} ${response.statusText}`);

  const totalBytes = parseInt(response.headers.get("content-length") || "0", 10);
  let downloadedBytes = 0;

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const archivePath = path.join(TMP_DIR, "repo.tar.gz");

  const writer = fs.createWriteStream(archivePath);
  const reader = response.body!.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writer.write(value);
    downloadedBytes += value.length;
    if (totalBytes) {
      process.stderr.write(`\r  ${((downloadedBytes / totalBytes) * 100).toFixed(1)}% (${formatBytes(downloadedBytes)}/${formatBytes(totalBytes)})`);
    }
  }
  writer.end();
  await new Promise<void>((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
  console.error(`\n Downloaded (${formatBytes(downloadedBytes)}). Extracting...`);

  // Extract only the docs subfolder
  fs.mkdirSync(path.join(TMP_DIR, "extracted"), { recursive: true });
  execSync(`tar -xzf "${archivePath}" --wildcards --strip-components=1 -C "${TMP_DIR}/extracted" "*/${REMOTE_DOCS_PATH}"`, { stdio: "pipe" });

  // Replace local docs/
  fs.rmSync(DOCS_DIR, { recursive: true, force: true });
  fs.cpSync(path.join(TMP_DIR, "extracted", REMOTE_DOCS_PATH), DOCS_DIR, { recursive: true });

  // Cleanup
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  const count = countMdFiles(DOCS_DIR);
  console.error(` ${count} .md files synced to docs/`);
}

function countMdFiles(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    count += entry.isDirectory() ? countMdFiles(fp) : (entry.name.endsWith(".md") ? 1 : 0);
  }
  return count;
}

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

function findMdFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findMdFiles(fp));
    else if (entry.name.endsWith(".md")) files.push(fp);
  }
  return files;
}

async function buildDatabase(embedder: Awaited<ReturnType<typeof createEmbeddingState>>): Promise<void> {
  console.error("Building database...");

  const db = new Database(DB_NAME);
  db.exec("DROP TABLE IF EXISTS chunks");
  db.exec(`CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT, content TEXT, embedding TEXT)`);
  const insert = db.prepare("INSERT INTO chunks (file_path, content, embedding) VALUES (?, ?, ?)");

  const mdFiles = findMdFiles(DOCS_DIR);
  console.error(` Found ${mdFiles.length} .md files.`);

  let totalChunks = 0;
  for (const fp of mdFiles) totalChunks += chunkText(fs.readFileSync(fp, "utf-8")).length;

  const batchInsert = db.transaction((items: { file_path: string; content: string; embedding: string }[]) => {
    for (const item of items) insert.run(item.file_path, item.content, item.embedding);
  });

  const batch: { file_path: string; content: string; embedding: string }[] = [];
  let embedded = 0;

  for (const fullPath of mdFiles) {
    const relPath = path.relative(__dirname, fullPath);
    const chunks = chunkText(fs.readFileSync(fullPath, "utf-8"));

    for (const chunk of chunks) {
      const emb = await embedder.getEmbedding(chunk);
      if (emb) {
        batch.push({ file_path: relPath, content: chunk, embedding: emb.join(",") });
        embedded++;
      }
      if (batch.length >= 50) {
        batchInsert(batch);
        batch.length = 0;
        process.stderr.write(`\r  ${embedded}/${totalChunks} (${((embedded / totalChunks) * 100).toFixed(0)}%)`);
      }
    }
  }
  if (batch.length > 0) batchInsert(batch);

  const count = db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
  console.error(`\n Database built: ${count.n} chunks in ${DB_NAME}`);
  db.close();
}

// ── MCP Server ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Step 1: Download model if missing
  await ensureModel();

  // Step 2: Download docs if missing
  if (!fs.existsSync(DOCS_DIR)) {
    console.error("docs/ not found — downloading from GitHub...\n");
    await downloadAndExtractDocs();
    console.error("");
  }

  // Read mode from environment (cpu | gpu | auto, defaults to auto)
  const mode: EmbeddingMode = (process.env.HERMES_DOCS_MODE as EmbeddingMode) ?? "auto";
  if (mode !== "cpu" && mode !== "gpu" && mode !== "auto") {
    console.error(`Warning: Invalid MODE '${process.env.HERMES_DOCS_MODE}', defaulting to 'auto'`);
  }
  const resolvedMode: EmbeddingMode = ["cpu", "gpu", "auto"].includes(mode) ? mode : "auto";

  // Load model into memory (needed for both DB build and queries)
  const embedder = await createEmbeddingState(MODEL_PATH, resolvedMode);

  try {
    // Step 3: Build DB if missing
    if (!fs.existsSync(DB_NAME)) {
      console.error("docs_rag.db not found — building database...\n");
      await buildDatabase(embedder);
      console.error("");
    }
  } catch (err) {
    await embedder.dispose();
    console.error("Fatal during setup:", err);
    process.exit(1);
  }

  // Open database
  const db: DatabaseType = new Database(DB_NAME, { readonly: true });

  const server = new McpServer({ name: "hermes-docs", version: "1.0.0" });

  // Tool 1: Semantic search
  server.registerTool(
    "search_docs",
    {
      description: "Search the Hermes documentation using semantic (embedding-based) search. Returns the most relevant document chunks matching the query.",
      inputSchema: {
        query: z.string().describe("The search query text"),
        top_k: z.number().optional().default(5).describe("Number of results to return (default: 5)"),
      },
    },
    async ({ query, top_k }) => {
      const queryEmbedding = await embedder.getEmbedding(query);
      const stmt = db.prepare<{ id: number; file_path: string; content: string; embedding: string }>("SELECT id, file_path, content, embedding FROM chunks");
      const rows = stmt.all();

      type RowResult = { similarity: number; id: number; file_path: string; content: string };
      const results: RowResult[] = [];
      for (const row of rows) {
        results.push({
          similarity: cosineSimilarity(queryEmbedding, row.embedding.split(",").map(Number)),
          id: row.id,
          file_path: row.file_path,
          content: row.content,
        });
      }

      results.sort((a, b) => b.similarity - a.similarity);
      const top = results.slice(0, top_k);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            query,
            result_count: top.length,
            results: top.map((r, i) => ({
              rank: i + 1,
              similarity: parseFloat(r.similarity.toFixed(4)),
              chunk_id: r.id,
              file_path: r.file_path,
              content: r.content.trim(),
            })),
          }, null, 2),
        }],
      };
    }
  );

  // Tool 2: Get document by path
  server.registerTool(
    "get_document",
    {
      description: "Retrieve the full content of a Hermes documentation file by its path relative to the docs directory. Use this to read complete documentation files.",
      inputSchema: {
        file_path: z.string().describe("Path to the document relative to the docs directory, e.g. 'user-guide/security.md'"),
      },
    },
    async ({ file_path }) => {
      const normalized = path.normalize(file_path).replace(/^(\.\.(\/|\\|$))/g, "");
      const fullPath = path.join(DOCS_DIR, normalized);

      if (!fullPath.startsWith(DOCS_DIR)) {
        return { content: [{ type: "text", text: `Error: Invalid path '${file_path}'.` }], isError: true };
      }

      if (!fs.existsSync(fullPath)) {
        const found = [fullPath, fullPath + ".md"].find((p) => fs.existsSync(p));
        if (!found) {
          const dirs = fs.readdirSync(DOCS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
          return { content: [{ type: "text", text: `Error: Not found '${file_path}'.\nDirs: ${dirs.join(", ")}` }], isError: true };
        }
        return { content: [{ type: "text", text: fs.readFileSync(found, "utf-8") }] };
      }

      return { content: [{ type: "text", text: fs.readFileSync(fullPath, "utf-8") }] };
    }
  );

  // Start
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Hermes Docs MCP server running on stdio");

  const shutdown = async () => {
    await embedder.dispose();
    db.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
