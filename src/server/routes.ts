/**
 * src/server/routes.ts
 *
 * HTTP route handlers for Temporal Chatbot.
 *
 * Routes:
 *   GET  /api/health        — health check
 *   POST /api/chat          — non-streaming chat (JSON response)
 *   POST /api/chat/stream   — streaming chat (SSE)
 *
 * Security:
 *   - API keys are NEVER exposed to the client.
 *   - Environment variables are NEVER sent in responses.
 *   - User input is validated before passing to the controller.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Config } from "../config.js";
import { createConversation } from "../memory/store.js";
import {
  runController,
  runControllerAndStore
} from "../agent/controller.js";
import type { StatusEvent } from "../agent/controller.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the full JSON body from an IncomingMessage. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Send a JSON response. */
function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

/** Send a JSON error response. */
function sendError(
  res: ServerResponse,
  statusCode: number,
  message: string
): void {
  sendJson(res, statusCode, { error: message });
}

/** Add CORS headers for all responses. */
function addCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
}

// ---------------------------------------------------------------------------
// Route: GET /api/health
// ---------------------------------------------------------------------------

export function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse
): void {
  addCorsHeaders(res);
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Route: POST /api/chat  (non-streaming, JSON response)
// ---------------------------------------------------------------------------

export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  addCorsHeaders(res);

  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    sendError(res, 400, "Invalid JSON body");
    return;
  }

  if (!body || typeof body !== "object") {
    sendError(res, 400, "Request body must be a JSON object");
    return;
  }

  const { message, conversationId } = body as Record<string, unknown>;

  if (typeof message !== "string" || message.trim().length === 0) {
    sendError(res, 400, "Field 'message' is required and must be a non-empty string");
    return;
  }

  if (!Config.nvidia.apiKey) {
    sendError(res, 503, "NVIDIA_API_KEY is not configured.");
    return;
  }

  // Resolve or create conversation
  let resolvedConversationId: string;
  if (typeof conversationId === "string" && conversationId.trim()) {
    resolvedConversationId = conversationId.trim();
  } else {
    const convo = createConversation();
    resolvedConversationId = convo.id;
  }

  try {
    const result = await runControllerAndStore({
      conversationId: resolvedConversationId,
      message: message.trim()
    });

    sendJson(res, 200, {
      conversationId: resolvedConversationId,
      answer: result.answer,
      citations: result.citations,
      metadata: result.metadata
    });
  } catch (err) {
    console.error("[routes] Chat handler error:", err);
    sendError(
      res,
      500,
      "An error occurred while processing your request."
    );
  }
}

// ---------------------------------------------------------------------------
// Route: POST /api/chat/stream  (SSE streaming)
// ---------------------------------------------------------------------------

export async function handleChatStream(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  addCorsHeaders(res);

  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    sendError(res, 400, "Invalid JSON body");
    return;
  }

  if (!body || typeof body !== "object") {
    sendError(res, 400, "Request body must be a JSON object");
    return;
  }

  const { message, conversationId } = body as Record<string, unknown>;

  if (typeof message !== "string" || message.trim().length === 0) {
    sendError(res, 400, "Field 'message' is required");
    return;
  }

  if (!Config.nvidia.apiKey) {
    sendError(res, 503, "NVIDIA_API_KEY is not configured.");
    return;
  }

  // Resolve or create conversation
  let resolvedConversationId: string;
  if (typeof conversationId === "string" && conversationId.trim()) {
    resolvedConversationId = conversationId.trim();
  } else {
    const convo = createConversation();
    resolvedConversationId = convo.id;
  }

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no" // disable nginx buffering if present
  });

  // Send a keepalive comment immediately
  res.write(": connected\n\n");

  // Handle client disconnect
  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  /** Write one SSE event */
  function sendEvent(event: StatusEvent): void {
    if (res.writableEnded) return;
    const data = JSON.stringify({
      type: event.type,
      content: event.content,
      ...(event.metadata ? { metadata: event.metadata } : {}),
      ...(event.citations ? { citations: event.citations } : {})
    });
    res.write(`data: ${data}\n\n`);
  }

  const answerTokens: string[] = [];

  try {
    for await (const event of runController(
      {
        conversationId: resolvedConversationId,
        message: message.trim()
      },
      abortController.signal
    )) {
      sendEvent(event);

      if (event.type === "token") {
        answerTokens.push(event.content);
      }
    }

    // Store messages in SQLite after streaming completes
    const { addMessage } = await import("../memory/store.js");
    addMessage(resolvedConversationId, "user", message.trim());
    const fullAnswer = answerTokens.join("");
    if (fullAnswer) {
      addMessage(resolvedConversationId, "assistant", fullAnswer);
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      console.error("[routes] Stream error:", err);
      const errEvent: StatusEvent = {
        type: "error",
        content: "An error occurred while processing your request."
      };
      sendEvent(errEvent);
    }
  } finally {
    if (!res.writableEnded) {
      res.write("data: {\"type\":\"close\"}\n\n");
      res.end();
    }
  }
}

// ---------------------------------------------------------------------------
// OPTIONS (CORS preflight)
// ---------------------------------------------------------------------------

export function handleOptions(
  _req: IncomingMessage,
  res: ServerResponse
): void {
  addCorsHeaders(res);
  res.writeHead(204);
  res.end();
}

