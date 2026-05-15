import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getLlama } from "node-llama-cpp";
import type { LlamaEmbedding, LlamaModel } from "node-llama-cpp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ──────────────────────────────────────────────────────────
export const MODEL_DIR = path.join(__dirname, "models");
export const MODEL_FILENAME = "nomic-embed-text-v1.5.Q6_K.gguf";
export const MODEL_PATH = path.join(MODEL_DIR, MODEL_FILENAME);
export const MODEL_URL = `https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/${MODEL_FILENAME}`;

// ── Model download ─────────────────────────────────────────────────────────
export async function ensureModel(): Promise<string> {
  if (fs.existsSync(MODEL_PATH)) {
    return MODEL_PATH;
  }

  fs.mkdirSync(MODEL_DIR, { recursive: true });
  console.error(`Downloading ${MODEL_FILENAME} ...`);

  const response = await fetch(MODEL_URL);
  if (!response.ok) {
    throw new Error(`Failed to download model: ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
  let downloadedBytes = 0;

  if (!response.body) {
    throw new Error("ReadableStream not supported");
  }

  const writer = fs.createWriteStream(MODEL_PATH);
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    writer.write(value);
    downloadedBytes += value.length;

    if (totalBytes) {
      const pct = ((downloadedBytes / totalBytes) * 100).toFixed(1);
      process.stderr.write(`\r  ${pct}% (${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)})`);
    }
  }

  writer.end();
  await new Promise<void>((resolve, reject) => {
    writer.on("finish", () => resolve());
    writer.on("error", reject);
  });

  console.error("\n Download complete.");
  return MODEL_PATH;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

// ── Embedding context ──────────────────────────────────────────────────────
export interface EmbeddingState {
  getEmbedding(text: string): Promise<number[]>;
  dispose(): Promise<void>;
}

export async function createEmbeddingState(modelPath: string): Promise<EmbeddingState> {
  const llama = await getLlama();
  const model: LlamaModel = await llama.loadModel({
    modelPath,
    gpuLayers: "auto",
    onLoadProgress: (pct: number) => {
      process.stderr.write(`\r  Loading model ${(pct * 100).toFixed(0)}%`);
    },
  });
  console.error("\n Model loaded.");

  const embeddingCtx = await model.createEmbeddingContext();

  return {
    async getEmbedding(text: string): Promise<number[]> {
      const embedding: LlamaEmbedding = await embeddingCtx.getEmbeddingFor(text);
      return embedding.vector;
    },
    async dispose(): Promise<void> {
      await embeddingCtx.dispose();
      await model.dispose();
      await llama.dispose();
    },
  };
}

// ── Cosine similarity ──────────────────────────────────────────────────────
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
