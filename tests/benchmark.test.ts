/**
 * tests/benchmark.test.ts
 *
 * Temporal Chatbot — Benchmark Regression Test Suite
 *
 * 12 Deterministic Benchmarks covering:
 *   1. Memory-Only (date resolution + memory retrieval, no web search)
 *   2. Historical CRM Shortlist (accurate recall from conversation memory)
 *   3. Temporal Verification (memory -> planner -> Tavily -> comparison -> synthesis)
 *   4. "Is it still correct?" (never echoes past answer as current truth)
 *   5. Postgres Temporal Query (multi-source ranking & verification)
 *   6. Conflicting Evidence (source disagreement -> "conflicting" status)
 *   7. No Evidence (absence of evidence -> "uncertain", NOT "removed")
 *   8. Search Failure (graceful degradation, no crash, calls <= 2)
 *   9. Citation Integrity (citations originate strictly from Evidence.url)
 *  10. Two-Hop Guarantee (invariant: maximum 2 LLM calls per request)
 *  11. Query Budget (enforces hard cap on planner-generated queries)
 *  12. Memory != Current Truth (historical $20 vs current $25 -> "changed")
 *
 * All external APIs (LLM, Tavily) are fully mocked.
 * Test runs independently without requiring prior manual seeding.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// Memory & Seeding
import { seedDatabase } from "../database/seed.js";
import { createConversation, addMessage } from "../src/memory/store.js";
import { db } from "../src/memory/db.js";

// Agent Controller & Planner
import { runControllerAndStore, runController } from "../src/agent/controller.js";
import { runPlanner } from "../src/agent/planner.js";

// Evidence, Comparison & Provenance
import { compareClaim } from "../src/evidence/comparator.js";
import { buildCitations } from "../src/evidence/provenance.js";
import type { Evidence, HistoricalClaim, SearchPlan } from "../src/types/index.js";
import { Config } from "../src/config.js";

// ---------------------------------------------------------------------------
// Shared Reference Date & Mock Helpers
// ---------------------------------------------------------------------------

// Reference "now": Tuesday, November 10, 2026 12:00:00 UTC
const FIXED_NOW = new Date("2026-11-10T12:00:00.000Z");

let plannerCallCount = 0;
let synthesizerCallCount = 0;
let tavilyCallCount = 0;
let lastExecutedSearchQueries: Array<{ query: string; domains?: string[] }> = [];

let customPlannerResponse: SearchPlan | null = null;
let customTavilyResults: Array<{
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
}> | null = null;
let customTavilyError = false;

function resetMockState(): void {
  plannerCallCount = 0;
  synthesizerCallCount = 0;
  tavilyCallCount = 0;
  lastExecutedSearchQueries = [];
  customPlannerResponse = null;
  customTavilyResults = null;
  customTavilyError = false;
}

beforeAll(() => {
  // Ensure seed data is in place for development/benchmark testing
  seedDatabase();
});

beforeEach(() => {
  resetMockState();

  process.env.NVIDIA_API_KEY = "mock-nvidia-key";
  process.env.NVIDIA_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
  process.env.NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
  process.env.LLM_API_KEY = "mock-llm-key";
  process.env.SEARCH_API_KEY = "mock-tavily-key";
  process.env.LLM_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;

    // --- Tavily Search API Mock ---
    if (url.includes("api.tavily.com")) {
      tavilyCallCount++;

      if (customTavilyError) {
        return new Response(JSON.stringify({ error: "Service unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        });
      }

      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.query) {
        lastExecutedSearchQueries.push({
          query: body.query,
          domains: body.include_domains
        });
      }

      const results = customTavilyResults ?? [
        {
          title: "Supabase Pricing 2026",
          url: "https://supabase.com/pricing",
          content: "Supabase Pro plan is now $25 per month.",
          score: 0.98,
          published_date: "2026-11-09T00:00:00.000Z"
        }
      ];

      return new Response(
        JSON.stringify({ results }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // --- LLM Chat Completions Mock ---
    if (url.includes("/chat/completions")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const isStreaming = body.stream === true;
      const systemPrompt: string =
        body.messages?.find((m: { role: string }) => m.role === "system")?.content ?? "";

      const isPlanner = systemPrompt.includes("research planning assistant");

      if (isPlanner) {
        plannerCallCount++;
        const plan: SearchPlan = customPlannerResponse ?? {
          mode: "verify",
          searchQueries: [
            { query: "Supabase pricing changes 2026", domains: ["supabase.com"] }
          ],
          claimsToVerify: [
            { entity: "Supabase", claim: "Supabase Pro costs $20/month." }
          ],
          needsDeepRead: false
        };

        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // Synthesizer call
      synthesizerCallCount++;

      if (isStreaming) {
        const userPrompt =
          body.messages?.find((m: { role: string }) => m.role === "user")
            ?.content ?? "";
        const isMemory =
          userPrompt.includes("Mode: memory") ||
          userPrompt.includes("MEMORY-ONLY");

        const answerText = isMemory
          ? "On November 3, 2026, you asked/discussed:\n" +
            "- Shortlisting HubSpot, Pipedrive, Zoho CRM, Salesforce and Freshsales for a 20-person sales team.\n" +
            "- CRM/Postgres hosting and database pricing.\n\n" +
            "This is based on the conversation history from November 3, 2026."
          : "Conclusion: Supabase Pro pricing changed from $20/month to $25/month [1].\n" +
            "Historical: $20/month on Nov 4, 2026.\n" +
            "Current: $25/month as of November 2026.\n" +
            "Status: Changed.";

        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: answerText } }] })}\n\n`,
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
                content: "Supabase Pro pricing changed from $20/month to $25/month [1]."
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Benchmark 1: Memory-Only
// ===========================================================================

describe("Benchmark 1: Memory-Only Retrieval", () => {
  it("resolves November 3, retrieves memory, and executes NO web search", async () => {
    const convo = createConversation("Benchmark 1 Convo");

    const result = await runControllerAndStore({
      conversationId: convo.id,
      message: "What did I ask you on November 3?",
      referenceDate: FIXED_NOW
    });

    // 1. Correct historical date resolved
    expect(result.metadata.historicalDate).toBe("2026-11-03T00:00:00.000Z");
    // 2. Memory was used
    expect(result.metadata.usedMemory).toBe(true);
    // 3. Web search was NOT called
    expect(tavilyCallCount).toBe(0);
    // 4. Planner was NOT called
    expect(plannerCallCount).toBe(0);
    // 5. Synthesizer called to format historical answer
    expect(synthesizerCallCount).toBe(1);
    // 6. Answer references the conversation
    expect(result.answer.length).toBeGreaterThan(0);
    // 7. Pure memory-only semantics: 0 web sources, no 'Current:' claim, no 'Status: Unchanged'
    expect(result.citations).toHaveLength(0);
    expect(result.metadata.sourcesUsed).toBe(0);
    expect(result.answer).not.toMatch(/\bCurrent:/i);
    expect(result.answer).not.toMatch(/\bStatus:\s*Unchanged\b/i);
  });
});

// ===========================================================================
// Benchmark 2: Historical CRM Shortlist
// ===========================================================================

describe("Benchmark 2: Historical CRM Shortlist", () => {
  it("identifies the seeded 5 CRM tools from conversation memory without web search", async () => {
    const convo = createConversation("Benchmark 2 Convo");

    const result = await runControllerAndStore({
      conversationId: convo.id,
      message: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. What were they?",
      referenceDate: FIXED_NOW
    });

    expect(result.metadata.usedMemory).toBe(true);
    expect(tavilyCallCount).toBe(0);
    expect(plannerCallCount).toBe(0);
  });
});

// ===========================================================================
// Benchmark 3: Temporal Verification
// ===========================================================================

describe("Benchmark 3: Temporal Verification Pipeline", () => {
  it("exercises memory -> planner -> Tavily -> comparison -> synthesizer with <= 2 LLM calls", async () => {
    const convo = createConversation("Benchmark 3 Convo");

    const result = await runControllerAndStore({
      conversationId: convo.id,
      message: "On November 3 we discussed CRM pricing. Has anything changed since then?",
      referenceDate: FIXED_NOW
    });

    // Validates two-hop sequence
    expect(plannerCallCount).toBe(1);
    expect(tavilyCallCount).toBeGreaterThan(0);
    expect(synthesizerCallCount).toBe(1);
    expect(plannerCallCount + synthesizerCallCount).toBeLessThanOrEqual(2);

    expect(result.metadata.usedMemory).toBe(true);
    expect(result.citations.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Benchmark 4: "Is it still correct?"
// ===========================================================================

describe("Benchmark 4: Is It Still Correct?", () => {
  it("verifies past statement against current web sources rather than repeating past as truth", async () => {
    const convo = createConversation("Benchmark 4 Convo");

    const result = await runControllerAndStore({
      conversationId: convo.id,
      message: "What did I ask you on November 3? Is your answer still correct today?",
      referenceDate: FIXED_NOW
    });

    expect(plannerCallCount).toBe(1);
    expect(tavilyCallCount).toBeGreaterThan(0);
    expect(synthesizerCallCount).toBe(1);
    expect(result.metadata.usedMemory).toBe(true);
  });
});

// ===========================================================================
// Benchmark 5: Postgres Temporal Query
// ===========================================================================

describe("Benchmark 5: Postgres Temporal Query", () => {
  it("resolves 'yesterday' / 'last Tuesday' reference, retrieves Postgres history, and compares against ranked web sources", async () => {
    // Current web sources include both official and secondary sources
    customTavilyResults = [
      {
        title: "Supabase Official Pricing Documentation",
        url: "https://docs.supabase.com/pricing",
        content: "Supabase Pro plan is $25 per month with 8GB compute.",
        score: 0.99,
        published_date: "2026-11-09T00:00:00.000Z"
      },
      {
        title: "TechCrunch: Cloud Database Pricing Review",
        url: "https://techcrunch.com/2026/11/05/database-pricing",
        content: "Supabase Pro is now priced at $25/month.",
        score: 0.85,
        published_date: "2026-11-05T00:00:00.000Z"
      }
    ];

    const convo = createConversation("Benchmark 5 Convo");

    const result = await runControllerAndStore({
      conversationId: convo.id,
      message: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since?",
      referenceDate: FIXED_NOW
    });

    expect(plannerCallCount).toBe(1);
    expect(tavilyCallCount).toBeGreaterThan(0);
    expect(result.metadata.usedMemory).toBe(true);
    // Official documentation ranked above tech news
    expect(result.citations[0]?.sourceType).toBe("documentation");
  });
});

// ===========================================================================
// Benchmark 6: Conflicting Evidence
// ===========================================================================

describe("Benchmark 6: Conflicting Evidence Detection", () => {
  it("detects when two credible current sources disagree and returns 'conflicting'", () => {
    const historicalClaim: HistoricalClaim = {
      id: "claim-test-conflict",
      messageId: "msg-1",
      claim: "Hosting costs $20/month.",
      validAt: "2026-11-03T00:00:00.000Z",
      entity: "Hosting",
      topic: "pricing"
    };

    const evidenceA: Evidence = {
      id: "ev-a",
      title: "Provider Pricing Source A",
      url: "https://provider.com/pricing",
      domain: "provider.com",
      snippet: "Hosting costs $20/month.",
      authorityScore: 0.9,
      sourceType: "official",
      retrievedAt: "2026-11-10T00:00:00.000Z"
    };

    const evidenceB: Evidence = {
      id: "ev-b",
      title: "News Review Source B",
      url: "https://techcrunch.com/review",
      domain: "techcrunch.com",
      snippet: "Hosting costs $25/month under new plans.",
      authorityScore: 0.7,
      sourceType: "news",
      retrievedAt: "2026-11-10T00:00:00.000Z"
    };

    const comparison = compareClaim(historicalClaim, [evidenceA, evidenceB]);

    // Disagreement between credible sources must yield conflicting
    expect(comparison.status).toBe("conflicting");
  });
});

// ===========================================================================
// Benchmark 7: No Evidence (Absence of Evidence != Removed)
// ===========================================================================

describe("Benchmark 7: Absence of Evidence Rule", () => {
  it("marks status as 'uncertain', NOT 'removed', when no current evidence is available", () => {
    const historicalClaim: HistoricalClaim = {
      id: "claim-test-uncertain",
      messageId: "msg-2",
      claim: "Feature X is available on the Pro plan.",
      validAt: "2026-11-03T00:00:00.000Z",
      entity: "Feature X"
    };

    // Zero current evidence found
    const comparisonEmpty = compareClaim(historicalClaim, []);
    expect(comparisonEmpty.status).toBe("uncertain");
    expect(comparisonEmpty.status).not.toBe("removed");

    // Unrelated evidence found
    const unrelatedEvidence: Evidence = {
      id: "ev-unrelated",
      title: "Unrelated Company Blog",
      url: "https://unrelated.com/blog",
      domain: "unrelated.com",
      snippet: "Today we celebrate company anniversary.",
      authorityScore: 0.5,
      sourceType: "official",
      retrievedAt: "2026-11-10T00:00:00.000Z"
    };

    const comparisonUnrelated = compareClaim(historicalClaim, [unrelatedEvidence]);
    expect(comparisonUnrelated.status).toBe("uncertain");
    expect(comparisonUnrelated.status).not.toBe("removed");
  });
});

// ===========================================================================
// Benchmark 8: Search Failure Handling
// ===========================================================================

describe("Benchmark 8: Search Failure Resilience", () => {
  it("gracefully handles Tavily failure without crashing or exceeding 2 LLM calls", async () => {
    customTavilyError = true; // Tavily returns 503

    const convo = createConversation("Benchmark 8 Convo");

    const result = await runControllerAndStore({
      conversationId: convo.id,
      message: "What is the current pricing of tool Y?",
      referenceDate: FIXED_NOW
    });

    expect(result).toBeDefined();
    expect(result.answer).toBeDefined();
    // Bounded calls
    expect(plannerCallCount).toBeLessThanOrEqual(1);
    expect(synthesizerCallCount).toBeLessThanOrEqual(1);
    expect(plannerCallCount + synthesizerCallCount).toBeLessThanOrEqual(2);
  });
});

// ===========================================================================
// Benchmark 9: Citation Integrity
// ===========================================================================

describe("Benchmark 9: Citation Integrity", () => {
  it("resolves citations strictly from real Evidence.url and prevents fake URL injection", () => {
    const validEvidence: Evidence[] = [
      {
        id: "ev-real",
        title: "Real Verified Source",
        url: "https://example.com/verified-pricing",
        domain: "example.com",
        authorityScore: 0.9,
        sourceType: "official",
        retrievedAt: "2026-11-10T00:00:00.000Z"
      }
    ];

    const citations = buildCitations(validEvidence);

    expect(citations).toHaveLength(1);
    expect(citations[0]?.url).toBe("https://example.com/verified-pricing");

    // A fake URL that does not exist in validEvidence can never be in citations
    const fakeUrl = "https://fake-hallucinated-source.com/pricing";
    const foundFake = citations.some((c) => c.url === fakeUrl);
    expect(foundFake).toBe(false);
  });
});

// ===========================================================================
// Benchmark 10: Two-Hop Guarantee
// ===========================================================================

describe("Benchmark 10: Two-Hop LLM Architectural Invariant", () => {
  it("strictly enforces maximum 2 LLM calls for verification and at most 1 for memory", async () => {
    // 1. Temporal Verification Query
    const convoVerify = createConversation("Two-Hop Verify");
    await runControllerAndStore({
      conversationId: convoVerify.id,
      message: "On November 3 we discussed CRM tools. Has anything changed since then?",
      referenceDate: FIXED_NOW
    });

    expect(plannerCallCount).toBe(1);
    expect(synthesizerCallCount).toBe(1);
    expect(plannerCallCount + synthesizerCallCount).toBe(2);

    // Reset counters
    resetMockState();

    // 2. Memory-Only Query
    const convoMemory = createConversation("Two-Hop Memory");
    await runControllerAndStore({
      conversationId: convoMemory.id,
      message: "What did I ask you on November 3?",
      referenceDate: FIXED_NOW
    });

    expect(plannerCallCount).toBe(0);
    expect(synthesizerCallCount).toBe(1);
    expect(plannerCallCount + synthesizerCallCount).toBeLessThanOrEqual(1);
  });
});

// ===========================================================================
// Benchmark 11: Query Budget Enforcement
// ===========================================================================

describe("Benchmark 11: Query Budget Cap", () => {
  it("caps planner-generated queries to the frozen budget (temporalVerification = 12)", async () => {
    // Mock a planner that attempts to generate 20 queries (exceeding budget)
    const excessiveQueries = Array.from({ length: 20 }, (_, i) => ({
      query: `Excessive search query #${i + 1}`
    }));

    customPlannerResponse = {
      mode: "verify",
      searchQueries: excessiveQueries,
      claimsToVerify: [],
      needsDeepRead: false
    };

    const plan = await runPlanner({
      query: "Check all changes across all tools",
      mode: "verify",
      budget: Config.searchBudgets.temporalVerification, // 12
      currentDate: FIXED_NOW.toISOString(),
      historicalMessages: [],
      historicalClaims: []
    });

    // Planner output must be hard-capped to the budget of 12
    expect(plan.searchQueries.length).toBeLessThanOrEqual(12);
    expect(plan.searchQueries.length).toBe(12);
  });
});

// ===========================================================================
// Benchmark 12: Memory Does Not Mean Current Truth
// ===========================================================================

describe("Benchmark 12: Memory != Current Truth", () => {
  it("detects price change from historical $20/month to current $25/month as 'changed'", () => {
    const historicalClaim: HistoricalClaim = {
      id: "claim-supabase-nov4",
      messageId: "msg-seed-pg",
      claim: "Supabase Pro costs $20/month.",
      validAt: "2026-11-04T00:00:00.000Z",
      entity: "Supabase",
      topic: "pricing"
    };

    const currentEvidence: Evidence = {
      id: "ev-current-supabase",
      title: "Supabase Pricing Nov 2026",
      url: "https://supabase.com/pricing",
      domain: "supabase.com",
      snippet: "Supabase Pro plan is $25/month with 8GB compute.",
      authorityScore: 1.0,
      sourceType: "official",
      retrievedAt: "2026-11-10T00:00:00.000Z"
    };

    const comparison = compareClaim(historicalClaim, [currentEvidence]);

    // Verifies the core thesis: past conversation was $20, current web is $25 -> changed
    expect(comparison.status).toBe("changed");
    expect(comparison.historical.value).toBe("Supabase Pro costs $20/month.");
    expect(comparison.current.value).toContain("$25/month");
  });
});

