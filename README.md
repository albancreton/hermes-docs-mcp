# Hermes Docs MCP Server

MCP server that provides semantic search and document retrieval for [NousResearch Hermes Agent](https://github.com/NousResearch/hermes-agent) documentation.

Uses a local embedding model (`nomic-embed-text-v1.5`, Q6_K quantized, ~108 MB) loaded via `node-llama-cpp` — no external API keys or network calls needed at query time.

## What it does

Two MCP tools are exposed to connected AI agents:

| Tool | Description |
|---|---|
| `search_docs` | Semantic search across all docs. Returns ranked chunks with similarity scores, file paths, and content. |
| `get_document` | Retrieves the full content of a specific doc file by path (e.g. `user-guide/security.md`). |

## Install

### Via npm (recommended)

```bash
npm install -g @patate/hermes-docs-mcp
```

Or run directly with `npx`:

```bash
npx @patate/hermes-docs-mcp
```

### From source

```bash
git clone <repo> && cd hermes-doc
pnpm install
pnpm run setup    # downloads model + syncs docs + builds DB
```

The `setup` step does three things:

1. **Downloads the embedding model** from Hugging Face (~108 MB, cached in `models/`)
2. **Syncs docs** from the Hermes Agent GitHub repo (~27 MB tarball, written to `docs/`)
3. **Builds the database** — chunks every `.md` file and generates embeddings (~15 min on M-series Mac)

## MCP installation

Add the server to your MCP client config (e.g. `~/.config/<client>/mcp.json` or your project's `.mcp.json`):

### From npm

```json
{
  "mcpServers": {
    "hermes-docs": {
      "command": "npx",
      "args": ["-y", "@patate/hermes-docs-mcp"]
    }
  }
}
```

### From source

```json
{
  "mcpServers": {
    "hermes-docs": {
      "command": "pnpm",
      "args": ["mcp"],
      "cwd": "<path-to-hermes-doc>"
    }
  }
}
```

Replace `<path-to-hermes-doc>` with the absolute path to this repo.

That's it — the MCP server auto-boots on first connection: if the model, docs, or database are missing, it downloads and builds them automatically.

## CLI tools

Besides the MCP server, standalone CLI tools are available (from source):

| Command | Description |
|---|---|
| `pnpm run setup` | Full setup: download model, sync docs, build DB |
| `pnpm query "how to deploy"` | One-shot semantic search from terminal |
| `pnpm run sync-docs` | Refresh docs from GitHub |
| `pnpm run build:db` | Rebuild embeddings (e.g. after doc refresh) |

## Publishing

```bash
npm login
npm publish --access public
```

## Requirements

- Node.js 20+
- Xcode Command Line Tools (for native dependencies: `better-sqlite3`, `node-llama-cpp`)
