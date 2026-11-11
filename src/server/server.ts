/**
 * src/server/server.ts
 *
 * HTTP server entry point for Temporal Chatbot.
 *
 * Loads dotenv before any other import that reads process.env.
 * Routes:
 *   GET  /api/health
 *   POST /api/chat
 *   POST /api/chat/stream
 *   GET  /           → public/index.html (static)
 *   GET  /index.html → public/index.html (static)
 */

import "dotenv/config";

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  handleHealth,
  handleChat,
  handleChatStream,
  handleOptions
} from "./routes.js";
import { Config } from "../config.js";

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * Robustly find the public/ directory.
 * When executed with tsx from src/server/ or compiled from dist/server/,
 * the project root containing public/ is 2 levels up.
 */
function findPublicDir(): string {
  // Candidate 1: 2 levels up from __dirname (src/server or dist/server -> project root)
  const candidate1 = resolve(__dirname, "../../public");
  if (existsSync(candidate1)) return candidate1;

  // Candidate 2: relative to process.cwd()
  const candidate2 = resolve(process.cwd(), "public");
  if (existsSync(candidate2)) return candidate2;

  // Candidate 3: 1 level up from __dirname
  const candidate3 = resolve(__dirname, "../public");
  if (existsSync(candidate3)) return candidate3;

  return candidate1;
}

export const PUBLIC_DIR = findPublicDir();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

export function serveStatic(
  urlPath: string,
  res: ServerResponse
): boolean {
  const normalizedPath = urlPath.split("?")[0];
  const safePath =
    normalizedPath === "/" || normalizedPath === ""
      ? "index.html"
      : normalizedPath.replace(/^\/+/, "");

  // Prevent path traversal
  const filePath = resolve(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return false;
  }
  if (!existsSync(filePath)) return false;

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const method = req.method?.toUpperCase() ?? "GET";
  const urlPath = req.url?.split("?")[0] ?? "/";

  // CORS preflight
  if (method === "OPTIONS") {
    handleOptions(req, res);
    return;
  }

  // API routes
  if (urlPath === "/api/health" && method === "GET") {
    handleHealth(req, res);
    return;
  }

  if (urlPath === "/api/chat" && method === "POST") {
    await handleChat(req, res);
    return;
  }

  if (urlPath === "/api/chat/stream" && method === "POST") {
    await handleChatStream(req, res);
    return;
  }

  // Static files (including GET / -> public/index.html)
  if (method === "GET") {
    if (serveStatic(urlPath, res)) return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

const PORT = Config.server.port;

export const server = createServer((req, res) => {
  handleRequest(req, res).catch((err: unknown) => {
    console.error("[server] Unhandled request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });
});

if (process.env.VITEST !== "true") {
  server.listen(PORT, () => {
    console.log(`\n🕰  Temporal Chatbot`);
    console.log(`   Server: http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/api/health`);
    console.log(`   Chat:   http://localhost:${PORT}/api/chat\n`);
  });

  server.on("error", (err) => {
    console.error("[server] Fatal error:", err);
    process.exit(1);
  });
}
