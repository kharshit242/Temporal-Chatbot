/**
 * tests/server.test.ts
 *
 * Tests for the HTTP route handlers:
 *   - GET  /api/health
 *   - POST /api/chat
 *
 * Tested in-process with mock requests/responses to avoid loopback TCP restrictions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  handleHealth,
  handleChat
} from "../src/server/routes.js";
import { handleRequest } from "../src/server/server.js";
import { createConversation } from "../src/memory/store.js";

function createMockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new Readable({
    read() {
      if (body !== undefined) {
        this.push(Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
      }
      this.push(null);
    }
  }) as unknown as IncomingMessage;

  req.method = method;
  req.url = url;
  return req;
}

function createMockRes(): {
  res: ServerResponse;
  getStatusCode: () => number;
  getHeaders: () => Record<string, string>;
  getBody: () => any;
  getRawBody: () => string;
  done: Promise<void>;
} {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  let resolveDone: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const mockRes = {
    setHeader(key: string, val: string) {
      headers[key.toLowerCase()] = val;
    },
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          headers[k.toLowerCase()] = v;
        }
      }
    },
    write(chunk: any) {
      chunks.push(Buffer.from(chunk));
    },
    end(chunk?: any) {
      if (chunk) chunks.push(Buffer.from(chunk));
      resolveDone();
    }
  } as unknown as ServerResponse;

  return {
    res: mockRes,
    getStatusCode: () => statusCode,
    getHeaders: () => headers,
    getBody: () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : null;
    },
    getRawBody: () => Buffer.concat(chunks).toString("utf-8"),
    done
  };
}

beforeEach(() => {
  process.env.NVIDIA_API_KEY = "mock-nvidia-key";
  process.env.NVIDIA_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
  process.env.NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
  process.env.LLM_API_KEY = "mock-llm-key";
  process.env.SEARCH_API_KEY = "mock-search-key";
  process.env.LLM_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;

    if (url.includes("api.tavily.com")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Supabase Pricing",
              url: "https://supabase.com/pricing",
              content: "Supabase Pro plan is $25 per month.",
              score: 0.95,
              published_date: "2026-11-01T00:00:00.000Z"
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("/chat/completions")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  mode: "web",
                  searchQueries: [{ query: "Supabase pricing" }],
                  claimsToVerify: [],
                  needsDeepRead: false
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404
    });
  });
});

describe("Server Route Handlers", () => {
  it("GET /api/health returns { ok: true } and never exposes secrets", async () => {
    const req = createMockReq("GET", "/api/health");
    const { res, getStatusCode, getBody, done } = createMockRes();

    handleHealth(req, res);
    await done;

    expect(getStatusCode()).toBe(200);
    const body = getBody();
    expect(body).toEqual({ ok: true });
    // Must never leak secrets
    expect(body).not.toHaveProperty("NVIDIA_API_KEY");
    expect(body).not.toHaveProperty("LLM_API_KEY");
    expect(body).not.toHaveProperty("SEARCH_API_KEY");
    expect(body).not.toHaveProperty("TAVILY_API_KEY");
  });

  it("POST /api/chat returns a controlled error when NVIDIA_API_KEY is missing", async () => {
    const origNvidiaKey = process.env.NVIDIA_API_KEY;
    const origLlmKey = process.env.LLM_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.LLM_API_KEY;

    try {
      const convo = createConversation("Missing key test");
      const req = createMockReq("POST", "/api/chat", {
        conversationId: convo.id,
        message: "What is Tavily?"
      });
      const { res, getStatusCode, getBody, done } = createMockRes();

      await handleChat(req, res);
      await done;

      expect(getStatusCode()).toBe(503);
      const body = getBody();
      expect(body).toHaveProperty("error");
      expect(body.error).toContain("NVIDIA_API_KEY");
    } finally {
      if (origNvidiaKey !== undefined) process.env.NVIDIA_API_KEY = origNvidiaKey;
      if (origLlmKey !== undefined) process.env.LLM_API_KEY = origLlmKey;
    }
  });

  it("POST /api/chat rejects empty body with 400", async () => {
    const req = createMockReq("POST", "/api/chat", {});
    const { res, getStatusCode, done } = createMockRes();

    await handleChat(req, res);
    await done;

    expect(getStatusCode()).toBe(400);
  });

  it("POST /api/chat processes query and returns answer + metadata", async () => {
    const convo = createConversation("API route chat test");
    const req = createMockReq("POST", "/api/chat", {
      conversationId: convo.id,
      message: "What did we discuss about CRM tools?"
    });
    const { res, getStatusCode, getBody, done } = createMockRes();

    await handleChat(req, res);
    await done;

    expect(getStatusCode()).toBe(200);
    const body = getBody();
    expect(body).toHaveProperty("answer");
    expect(body).toHaveProperty("metadata");
    expect(body).toHaveProperty("conversationId");
    expect(body.conversationId).toBe(convo.id);
  });

  it("GET / serves public/index.html with 200 and text/html", async () => {
    const req = createMockReq("GET", "/");
    const { res, getStatusCode, getHeaders, getRawBody, done } = createMockRes();

    await handleRequest(req, res);
    await done;

    expect(getStatusCode()).toBe(200);
    expect(getHeaders()["content-type"]).toBe("text/html; charset=utf-8");
    const html = getRawBody();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Temporal Chatbot");
  });

  it("GET /index.html serves public/index.html with 200 and text/html", async () => {
    const req = createMockReq("GET", "/index.html");
    const { res, getStatusCode, getHeaders, getRawBody, done } = createMockRes();

    await handleRequest(req, res);
    await done;

    expect(getStatusCode()).toBe(200);
    expect(getHeaders()["content-type"]).toBe("text/html; charset=utf-8");
    const html = getRawBody();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Temporal Chatbot");
  });

  it("GET /nonexistent returns 404 with JSON error", async () => {
    const req = createMockReq("GET", "/nonexistent-file.xyz");
    const { res, getStatusCode, getHeaders, getBody, done } = createMockRes();

    await handleRequest(req, res);
    await done;

    expect(getStatusCode()).toBe(404);
    expect(getHeaders()["content-type"]).toBe("application/json");
    expect(getBody()).toEqual({ error: "Not found" });
  });
});
