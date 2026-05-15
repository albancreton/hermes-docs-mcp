import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ──────────────────────────────────────────────────────────
const REPO = "NousResearch/hermes-agent";
const BRANCH = "main";
const REMOTE_DOCS_PATH = "website/docs";
const LOCAL_DOCS_DIR = path.join(__dirname, "docs");
const TMP_DIR = path.join(__dirname, ".tmp-download");
const ARCHIVE_URL = `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz`;

// ── Download archive ───────────────────────────────────────────────────────
async function downloadArchive(): Promise<void> {
  console.error(`Downloading ${BRANCH} from ${REPO} ...`);

  const response = await fetch(ARCHIVE_URL);
  if (!response.ok) {
    throw new Error(`Failed to download archive: ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
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
      const pct = ((downloadedBytes / totalBytes) * 100).toFixed(1);
      process.stderr.write(`\r  Downloading ${pct}% (${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)})`);
    }
  }

  writer.end();
  await new Promise<void>((resolve, reject) => {
    writer.on("finish", () => resolve());
    writer.on("error", reject);
  });

  console.error(`\n Downloaded (${formatBytes(downloadedBytes)}).`);
}

// ── Extract docs folder ────────────────────────────────────────────────────
function extractDocs(archivePath: string): void {
  // GitHub tarballs extract to a folder named <repo>-<commit> or <repo>-<branch>
  // We only want the website/docs subfolder
  console.error("Extracting docs ...");

  // Extract just the docs folder using tar
  // The archive root is something like "hermes-agent-main/"
  execSync(
    `tar -xzf "${archivePath}" --strip-components=1 -C "${TMP_DIR}/extracted" "*/${REMOTE_DOCS_PATH}"`,
    { stdio: "pipe" }
  );
}

// ── Sync to local docs ─────────────────────────────────────────────────────
function syncToDestination(): number {
  const sourceDir = path.join(TMP_DIR, "extracted", REMOTE_DOCS_PATH);

  if (!fs.existsSync(sourceDir)) {
    // Try without the leading path component (tar might have extracted differently)
    const extracted = path.join(TMP_DIR, "extracted");
    const entries = fs.readdirSync(extracted);
    console.error(`  Extracted entries: ${entries.join(", ")}`);

    // If the first level is the repo root folder, go into it
    const repoRoot = path.join(extracted, entries[0]);
    const docsPath = path.join(repoRoot, REMOTE_DOCS_PATH);
    if (fs.existsSync(docsPath)) {
      return doSync(docsPath);
    }
    throw new Error(`Could not find ${REMOTE_DOCS_PATH} in archive`);
  }

  return doSync(sourceDir);
}

function doSync(sourceDir: string): number {
  // Clear existing docs
  console.error("Syncing to docs/ ...");
  fs.rmSync(LOCAL_DOCS_DIR, { recursive: true, force: true });
  fs.cpSync(sourceDir, LOCAL_DOCS_DIR, { recursive: true });

  // Count files
  const count = countFiles(LOCAL_DOCS_DIR);
  return count;
}

// ── Cleanup ────────────────────────────────────────────────────────────────
function cleanup(): void {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

// ── Helpers ────────────────────────────────────────────────────────────────
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

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countFiles(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      count++;
    }
  }
  return count;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  try {
    await downloadArchive();
    fs.mkdirSync(path.join(TMP_DIR, "extracted"), { recursive: true });
    extractDocs(path.join(TMP_DIR, "repo.tar.gz"));
    const count = syncToDestination();
    cleanup();
    console.error(`\nDone: ${count} .md files synced to docs/`);
  } catch (err) {
    cleanup();
    console.error("Fatal:", err);
    process.exit(1);
  }
}

main();
