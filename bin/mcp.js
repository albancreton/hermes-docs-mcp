#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve tsx package directory and its CLI entry point
const tsxPkgDir = path.dirname(require.resolve("tsx/package.json"));
const tsxCli = path.join(tsxPkgDir, "dist", "cli.mjs");
const serverPath = path.join(__dirname, "..", "mcp_server.ts");

const child = spawn("node", [tsxCli, serverPath], {
  stdio: "inherit",
});

// Forward signals to the child process
const shutdown = (signal) => {
  child.kill(signal);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

child.on("close", (code) => process.exit(code ?? 0));
