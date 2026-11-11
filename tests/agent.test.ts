/**
 * tests/agent.test.ts
 *
 * Tests for Batch 3:
 *  - Memory-only mode (temporal resolution + SQLite retrieval, NO web search)
 *  - Web-only mode (planner + web search + synthesizer)
 *  - Temporal verification mode (memory + web search + comparator + synthesizer)
 *  - Maximum 2 LLM calls per request (assert plannerCalls <= 1, synthesizerCalls <= 1)
 *  - No hallucinated citations (citations originate exclusively from evidence URLs)
 *  - Missing history handled gracefully (no fabricated answers)
 *  - Search failure handled gracefully (uncertainty / error, no crash)
 *  - Health endpoint check
 *
 * All external APIs (LLM, Search) are mocked — no live network required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Memory layer
import { createConversation, addMessage, addClaim } from "../src/memory/store.js";
import { db } from "../src/memory/db.js";

// Agent layer
import { runController, runControllerAndStore } from "../src/agent/controller.js";
import type { ControllerInput } from "../src/agent/controller.js";
import { runPlanner } from "../src/agent/planner.js";
import { streamSynthesizer, computeMetadata } from "../src/agent/synthesizer.js";

// Provenance & Types
import type { Evidence, HistoricalClaim } from "../src/types/index.js";
import { buildCitations } from "../src/evidence/provenance.js";

// ---------------------------------------------------------------------------
// Helpers & fixtures
// ---------------------------------------------------------------------------

const FIXED_DATE = new Date("2026-11-10T12:00:00.000Z");

function makeTestEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: overrides.id ?? "ev-1",
    title: overrides.title ?? "Supabase Pricing",
    url: overrides.url ?? "https://supabase.com/pricing",
    domain: overrides.domain ?? "supabase.com",
    snippet: overrides.snippet ?? "Supabase Pro is $25/month.",
    content: overrides.content,
    publishedAt: overrides.publishedAt ?? "2026-11-01T00:00:00.000Z",
    retrievedAt: overrides.retrievedAt ?? "2026-11-10T00:00:00.000Z",
    authorityScore: overrides.authorityScore ?? 1.0,
    sourceType: overrides.sourceType ?? "official"
  };
}

// ---------------------------------------------------------------------------
// Mocking external network calls
// ---------------------------------------------------------------------------

let llmCallCount = 0;
let plannerCallCount = 0;
let synthesizerCallCount = 0;
let webSearchCallCount = 0;

beforeEach(() => {
  llmCallCount = 0;
  plannerCallCount = 0;
  synthesizerCallCount = 0;
  webSearchCallCount = 0;

  // Set mock environment variables
  process.env.NVIDIA_API_KEY = "mock-nvidia-key";
  process.env.NVIDIA_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
  process.env.NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
  process.env.LLM_API_KEY = "mock-llm-key";
  process.env.SEARCH_API_KEY = "mock-search-key";
  process.env.LLM_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";

  // Mock global fetch to intercept LLM and Tavily calls
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;

    // Tavily Search API
    if (url.includes("api.tavily.com")) {
      webSearchCallCount++;
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

    // LLM Chat Completions (OpenAI-compatible)
    if (url.includes("/chat/completions")) {
      llmCallCount++;
      const body = JSON.parse((init?.body as string) ?? "{}");
      const isStreaming = body.stream === true;

      // Detect whether this is planner (expects JSON) or synthesizer (streaming)
      const systemPrompt: string =
        body.messages?.find((m: { role: string }) => m.role === "system")
          ?.content ?? "";

      const isPlanner = systemPrompt.includes("research planning assistant");

      if (isPlanner) {
        plannerCallCount++;
        const plan = {
          mode: "web",
          searchQueries: [{ query: "Supabase pricing 2026" }],
          claimsToVerify: [],
          needsDeepRead: false
        };
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify(plan)
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // Synthesizer call
      synthesizerCallCount++;

      if (isStreaming) {
        // Return a mock SSE stream
        const chunks = [
          'data: {"choices":[{"delta":{"reasoning_content":"hidden chain-of-thought"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"Supabase Pro "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"costs $25/month [1]."}}]}\n\n',
          "data: [DONE]\n\n"
        ];
        const stream = new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
          }
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Supabase Pro costs $25/month [1]."
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Default 404 for anything else
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Memory-Only Mode
// ---------------------------------------------------------------------------

describe("Memory-Only Mode", () => {
  it("uses memory and does NOT call web search for purely historical queries", async () => {
    // Seed a conversation message on a specific date
    const convo = createConversation("CRM discussion");
    addMessage(
      convo.id,
      "user",
      "We discussed HubSpot and Salesforce pricing on November 3."
    );

    const result = await runControllerAndStore({
      conversationId: convo.id,
      message: "What did we discuss about CRM tools?",
      referenceDate: FIXED_DATE
    });

    // Web search must NOT have been called
    expect(webSearchCallCount).toBe(0);
    // Planner must NOT have been called for pure memory mode
    expect(plannerCallCount).toBe(0);
    // Synthesizer called to format the answer
    expect(synthesizerCallCount).toBe(1);
    expect(result.metadata.usedMemory).toBe(true);
  }, 10_000);

  it("resolves date deterministically and retrieves past message on November 3 without web search", async () => {
    const convo = createConversation("Nov 3 conversation");
    const msgId = "nov-3-msg-" + Date.now();
    const nov3Date = "2026-11-03T14:30:00.000Z";
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(msgId, convo.id, "user", "What are the top CRM tools for a 20-person sales team?", nov3Date);
    db.prepare(`
      INSERT INTO messages_fts (message_id, content)
      VALUES (?, ?)
    `).run(msgId, "What are the top CRM tools for a 20-person sales team?");

    const result = await runControllerAndStore({
      conversationId: convo.id,
      message: "What did I ask you on November 3?",
      referenceDate: FIXED_DATE
    });

    expect(result.metadata.usedMemory).toBe(true);
    expect(result.metadata.historicalDate).toBe("2026-11-03T00:00:00.000Z");
    expect(webSearchCallCount).toBe(0);
    expect(plannerCallCount).toBe(0);
    expect(synthesizerCallCount).toBe(1);
  });

  it("handles missing historical memory gracefully without hallucination", async () => {
    const convo = createConversation("Empty test");

    const result = await runControllerAndStore({
      conversationId: convo.id,
      message: "What did I ask you on October 15?",
      referenceDate: FIXED_DATE
    });

    // Should indicate no history found, not invent an answer
    expect(result.answer.toLowerCase()).toMatch(
      /couldn't find|no matching conversation|stored history/
    );
    expect(webSearchCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Web-Only Mode
// ---------------------------------------------------------------------------

describe("Web-Only Mode", () => {
  it("calls planner, web search, and synthesizer for current questions", async () => {
    const convo = createConversation("Web query");

    const result = await runControllerAndStore({
      conversationId: convo.id,
      message: "What is the current pricing of Supabase Pro?",
      referenceDate: FIXED_DATE
    });

    // Planner called once
    expect(plannerCallCount).toBe(1);
    // Web search called
    expect(webSearchCallCount).toBeGreaterThan(0);
    // Synthesizer called once
    expect(synthesizerCallCount).toBe(1);
    // Total LLM calls <= 2
    expect(plannerCallCount + synthesizerCallCount).toBeLessThanOrEqual(2);

    expect(result.answer).toContain("Supabase");
    expect(result.citations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Temporal Verification Mode
// ---------------------------------------------------------------------------

describe("Temporal Verification Mode", () => {
  it("verifies historical pricing against current web sources", async () => {
    const convo = createConversation("Temporal verification test");
    const msgId = "nov-3-verify-msg-" + Date.now();
    const nov3Date = "2026-11-03T10:00:00.000Z";
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(msgId, convo.id, "user", "Supabase Pro costs $25/month.", nov3Date);
    db.prepare(`
      INSERT INTO messages_fts (message_id, content)
      VALUES (?, ?)
    `).run(msgId, "Supabase Pro costs $25/month.");

    addClaim({
      messageId: msgId,
      claim: "Supabase Pro costs $25/month.",
      validAt: nov3Date,
      entity: "Supabase",
      topic: "pricing"
    });

    const result = await runControllerAndStore({
      conversationId: convo.id,
      message: "Is the pricing information I asked about on November 3 still correct?",
      referenceDate: FIXED_DATE
    });

    expect(result.metadata.usedMemory).toBe(true);
    expect(plannerCallCount).toBe(1);
    expect(webSearchCallCount).toBeGreaterThan(0);
    expect(synthesizerCallCount).toBe(1);
    expect(plannerCallCount + synthesizerCallCount).toBeLessThanOrEqual(2);
    expect(result.citations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Two-Hop Limit
// ---------------------------------------------------------------------------

describe("Two-Hop LLM Limit", () => {
  it("enforces at most two LLM calls for a complex verification query", async () => {
    const convo = createConversation("Verification convo");
    // Seed past message
    addMessage(
      convo.id,
      "user",
      "Supabase Pro costs $25/month."
    );

    await runControllerAndStore({
      conversationId: convo.id,
      message: "Has the pricing we discussed earlier changed since then?",
      referenceDate: FIXED_DATE
    });

    // Hard invariant: at most 1 planner, at most 1 synthesizer
    expect(plannerCallCount).toBeLessThanOrEqual(1);
    expect(synthesizerCallCount).toBeLessThanOrEqual(1);
    expect(plannerCallCount + synthesizerCallCount).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Citation Safety
// ---------------------------------------------------------------------------

describe("Citation Safety", () => {
  it("all citations originate exclusively from Evidence.url values", () => {
    const evidenceList: Evidence[] = [
      makeTestEvidence({
        id: "ev-1",
        url: "https://supabase.com/pricing",
        authorityScore: 1.0
      }),
      makeTestEvidence({
        id: "ev-2",
        url: "https://news.ycombinator.com/item?id=123",
        authorityScore: 0.45
      })
    ];

    const citations = buildCitations(evidenceList);

    // Every citation URL must match an item in evidenceList
    for (const citation of citations) {
      const match = evidenceList.some((e) => e.url === citation.url);
      expect(match).toBe(true);
    }

    expect(citations).toHaveLength(2);
    // Sorted by authority: supabase.com (1.0) before hackernews (0.45)
    expect(citations[0]?.url).toBe("https://supabase.com/pricing");
  });

  it("never invents URLs", () => {
    const citations = buildCitations([]);
    expect(citations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Search Failure Handling
// ---------------------------------------------------------------------------

describe("Search Failure Handling", () => {
  it("controller does not crash when web search fails", async () => {
    // Override fetch to make Tavily return a 500 error
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;

      if (url.includes("api.tavily.com")) {
        return new Response("Internal Server Error", { status: 500 });
      }

      // LLM still works
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  mode: "web",
                  searchQueries: [{ query: "test" }],
                  claimsToVerify: [],
                  needsDeepRead: false
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const convo = createConversation("Fail test");

    // Should complete without throwing an unhandled exception
    await expect(
      runControllerAndStore({
        conversationId: convo.id,
        message: "Current pricing of tool X?",
        referenceDate: FIXED_DATE
      })
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Metadata Computation
// ---------------------------------------------------------------------------

describe("Metadata Computation", () => {
  it("calculates metadata deterministically", () => {
    const ev = makeTestEvidence({
      authorityScore: 1.0,
      sourceType: "official"
    });

    const meta = computeMetadata({
      startMs: Date.now() - 500,
      usedMemory: true,
      historicalDate: "2026-11-03T00:00:00.000Z",
      historicalClaims: [],
      comparisons: [],
      evidence: [ev],
      answer: "Test answer."
    });

    expect(meta.usedMemory).toBe(true);
    expect(meta.sourcesUsed).toBe(1);
    expect(meta.officialSources).toBe(1);
    expect(meta.conflicts).toBe(0);
    expect(meta.latencyMs).toBeGreaterThanOrEqual(400);
    expect(["high", "medium", "low"]).toContain(meta.confidence);
  });
});

// ---------------------------------------------------------------------------
// 7. Streaming Events
// ---------------------------------------------------------------------------

describe("Streaming Events", () => {
  it("yields status events then token events then done event", async () => {
    const convo = createConversation("Streaming test");
    const events: string[] = [];

    for await (const event of runController({
      conversationId: convo.id,
      message: "What is Supabase Pro?",
      referenceDate: FIXED_DATE
    })) {
      events.push(event.type);
    }

    // Should contain at least status, token, done
    expect(events).toContain("status");
    expect(events).toContain("token");
    expect(events[events.length - 1]).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// 8. NVIDIA NIM Integration & Invariants
// ---------------------------------------------------------------------------

describe("NVIDIA NIM Integration & Invariants", () => {
  it("Planner calls NVIDIA client exactly once and returns a valid SearchPlan", async () => {
    const plan = await runPlanner({
      query: "What is current Tavily pricing?",
      mode: "web",
      budget: 4,
      currentDate: FIXED_DATE.toISOString(),
      historicalMessages: [],
      historicalClaims: []
    });

    expect(plannerCallCount).toBe(1);
    expect(plan.mode).toBe("web");
    expect(plan.searchQueries.length).toBeGreaterThan(0);
    expect(plan.searchQueries.length).toBeLessThanOrEqual(4);
    expect(Array.isArray(plan.claimsToVerify)).toBe(true);
    expect(typeof plan.needsDeepRead).toBe("boolean");
  });

  it("Planner handles malformed JSON from NVIDIA gracefully via fallback", async () => {
    // Override fetch to return broken JSON string for planner
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Here is your plan: { invalid json ..."
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const plan = await runPlanner({
      query: "Compare PostgreSQL pricing",
      mode: "web",
      budget: 4,
      currentDate: FIXED_DATE.toISOString(),
      historicalMessages: [],
      historicalClaims: []
    });

    // Should return deterministic fallback plan without throwing
    expect(plan).toBeDefined();
    expect(plan.mode).toBe("web");
    expect(plan.searchQueries.length).toBeGreaterThan(0);
  });

  it("Synthesizer calls NVIDIA client exactly once and streams answer without reasoning tokens", async () => {
    const tokens: string[] = [];
    for await (const token of streamSynthesizer({
      query: "What is Supabase Pro?",
      mode: "web",
      currentDate: FIXED_DATE.toISOString(),
      historicalMessages: [],
      historicalClaims: [],
      evidence: [makeTestEvidence()],
      comparisons: [],
      citations: []
    })) {
      tokens.push(token);
    }

    expect(synthesizerCallCount).toBe(1);
    const fullAnswer = tokens.join("");
    expect(fullAnswer).toContain("Supabase Pro costs $25/month [1].");
    // Verify reasoning content is NEVER leaked into answer
    expect(fullAnswer).not.toContain("hidden chain-of-thought");
  });

  it("Enforces two-hop invariant: temporal verification has Planner = 1, Synthesizer = 1 (Total = 2)", async () => {
    const convo = createConversation("Two-hop test");
    const msg = addMessage(convo.id, "user", "On November 3 we evaluated HubSpot CRM at $20/mo.");
    addClaim({
      messageId: msg.id,
      entity: "HubSpot",
      claim: "CRM pricing is $20/mo",
      validAt: "2026-11-03T00:00:00.000Z",
      topic: "pricing"
    });

    await runControllerAndStore({
      conversationId: convo.id,
      message: "On November 3 we looked at HubSpot. Has its pricing changed since then?",
      referenceDate: FIXED_DATE
    });

    expect(plannerCallCount).toBe(1);
    expect(synthesizerCallCount).toBe(1);
    expect(plannerCallCount + synthesizerCallCount).toBe(2);
  });

  it("Enforces two-hop invariant: memory-only has Planner = 0, Synthesizer <= 1", async () => {
    const convo = createConversation("Memory-only invariant");
    addMessage(convo.id, "user", "I like Postgres");

    await runControllerAndStore({
      conversationId: convo.id,
      message: "What did I mention earlier about Postgres?",
      referenceDate: FIXED_DATE
    });

    expect(plannerCallCount).toBe(0);
    expect(synthesizerCallCount).toBeLessThanOrEqual(1);
  });
});
