/**
 * src/agent/controller.ts
 *
 * Main orchestrator for Temporal Chatbot.
 *
 * This module owns the pipeline sequencing.
 * It does NOT contain:
 *   - SQL implementation details (delegated to memory/*)
 *   - LLM prompt text (delegated to prompts.ts)
 *   - Search provider logic (delegated to search/*)
 *   - Ranking/dedup/reader logic (delegated to search/*)
 *   - Comparison/provenance logic (delegated to evidence/*)
 *
 * Flow per request:
 *   1. Deterministic temporal resolution
 *   2. Memory retrieval (SQLite + FTS5)
 *   3. Routing decision (deterministic)
 *   4. LLM Planner — Hop #1 (skipped for memory-only)
 *   5. Web search → dedupe → rank → selective deep read
 *   6. Claim comparison + provenance
 *   7. LLM Synthesizer — Hop #2 (streaming)
 *   8. Store messages + return result
 *
 * Maximum LLM calls per request: 2 (planner + synthesizer).
 */

import { randomUUID } from "node:crypto";
import type {
  AgentMode,
  AnswerMetadata,
  ClaimComparison,
  Evidence,
  HistoricalClaim,
  Message,
  SearchPlan
} from "../types/index.js";

// Memory layer
import { createConversation, addMessage } from "../memory/store.js";
import {
  searchMessages,
  getMessagesByDateRange,
  getClaimsByDateRange
} from "../memory/retrieval.js";

// Temporal
import {
  resolveDateFromQuery
} from "../temporal/resolver.js";
import type { DateRange } from "../temporal/resolver.js";

// Search layer (Batch 2)
import { webSearch } from "../search/web-search.js";
import { dedupeEvidence, pruneRedundantEvidence } from "../search/dedupe.js";
import { rankEvidence } from "../search/ranker.js";
import {
  selectPagesForDeepRead,
  deepReadPages
} from "../search/reader.js";

// Evidence layer (Batch 2)
import { findRelevantEvidence } from "../evidence/claims.js";
import { compareClaim } from "../evidence/comparator.js";
import {
  buildEvidenceIndex,
  buildCitations
} from "../evidence/provenance.js";
import type { Citation } from "../evidence/provenance.js";

// Agent layer (Batch 3)
import { runPlanner } from "./planner.js";
import {
  streamSynthesizer,
  computeMetadata
} from "./synthesizer.js";
import type { SynthesizerInput } from "./synthesizer.js";
import { noHistoryFoundAnswer } from "./prompts.js";
import { Config } from "../config.js";

// ---------------------------------------------------------------------------
// Stop words and topic extraction
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "aren't",
  "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "can", "can't", "cannot", "could", "couldn't", "did", "didn't", "do", "does", "doesn't", "doing",
  "don't", "down", "during", "each", "few", "for", "from", "further", "had", "hadn't", "has", "hasn't",
  "have", "haven't", "having", "he", "her", "here", "hers", "herself", "him", "himself", "his", "how",
  "i", "if", "in", "into", "is", "isn't", "it", "it's", "its", "itself", "let's", "me", "more", "most",
  "my", "myself", "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other", "ought", "our",
  "ours", "ourselves", "out", "over", "own", "same", "she", "should", "shouldn't", "so", "some", "such",
  "than", "that", "that's", "the", "their", "theirs", "them", "themselves", "then", "there", "there's",
  "these", "they", "this", "those", "through", "to", "too", "under", "until", "up", "very", "was", "wasn't",
  "we", "we'd", "we'll", "we're", "we've", "were", "weren't", "what", "what's", "when", "where", "which",
  "while", "who", "whom", "why", "with", "won't", "would", "wouldn't", "you", "you'd", "you'll", "you're",
  "you've", "your", "yours", "yourself", "yourselves",
  // Common conversation/meta words:
  "ask", "asked", "tell", "told", "discuss", "discussed", "mention", "mentioned", "talk", "talked",
  "say", "said", "remember", "recall", "earlier", "previous", "previously", "shortlist", "shortlisted",
  "still", "correct", "true", "valid", "accurate", "change", "changed", "current", "currently",
  // Temporal words:
  "today", "yesterday", "tomorrow", "last", "next", "week", "month", "year", "day", "days",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"
]);

function extractTopicTokens(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Signals extracted deterministically from the query string.
 */
interface RoutingSignals {
  hasTemporalExpression: boolean;
  asksAboutHistory: boolean;
  asksAboutCurrent: boolean;
  asksForVerification: boolean;
  resolvedDateRange: DateRange | null;
}

function extractRoutingSignals(
  query: string,
  now: Date
): RoutingSignals {
  const lower = query.toLowerCase();

  // Historical indicators — user is asking about past conversation
  const historicalPatterns =
    /\b(what did (?:i|we|you)|last (?:week|month|tuesday|monday|wednesday|thursday|friday|saturday|sunday)|yesterday|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|we discussed|you (?:told|said|mentioned)|shortlisted|we (?:looked at|talked about|decided|agreed)|in (?:our|the) (?:last|previous)|november|october|september|august|january|february|march|april|may|june|july|december)\b/i;

  // Current information indicators
  const currentPatterns =
    /\b(current(?:ly)?|right now|today|latest|at (?:the )?moment|as of now|up to date|this week|this month|now)\b/i;

  // Verification indicators — user wants to verify historical info
  const verificationPatterns =
    /\b(still (true|correct|valid|accurate)|has (?:it|this|anything|that) changed|changed since|is it still|since (?:then|we|our|last)|has .+ (changed|updated|announced|released|launched|shifted|moved)|what('s| is) new|any (?:updates?|changes?|news)|still the same|still (stands?|holds?|applies?)|outdated|out of date)\b/i;

  const hasTemporalExpression = historicalPatterns.test(lower);
  const asksAboutCurrent = currentPatterns.test(lower);
  const asksForVerification = verificationPatterns.test(lower);
  const asksAboutHistory = historicalPatterns.test(lower) && !asksForVerification;

  const resolvedDateRange = resolveDateFromQuery(query, now);

  return {
    hasTemporalExpression,
    asksAboutHistory,
    asksAboutCurrent,
    asksForVerification,
    resolvedDateRange
  };
}

/**
 * Determine the routing mode and search budget from query signals.
 *
 * Priority:
 *   1. Verification signals with memory → "verify"
 *   2. Historical-only signals (no current/verify) → "memory"
 *   3. Temporal reference without memory / current query → "memory" (report missing history)
 *   4. Everything else → "web"
 */
function determineMode(
  signals: RoutingSignals,
  hasHistoricalMemory: boolean
): { mode: AgentMode; budget: number } {
  if (signals.asksForVerification && hasHistoricalMemory) {
    return {
      mode: "verify",
      budget: Config.searchBudgets.temporalVerification
    };
  }

  if (
    signals.asksAboutHistory &&
    !signals.asksAboutCurrent &&
    !signals.asksForVerification
  ) {
    return { mode: "memory", budget: 0 };
  }

  if (signals.hasTemporalExpression && !signals.asksAboutCurrent) {
    if (hasHistoricalMemory) {
      return {
        mode: "verify",
        budget: Config.searchBudgets.temporalVerification
      };
    }
    // Has temporal reference but no memory found in history -> memory mode to report no history
    return { mode: "memory", budget: 0 };
  }

  // Default: web search
  return {
    mode: "web",
    budget: Config.searchBudgets.simple
  };
}

// ---------------------------------------------------------------------------
// Status event types (for streaming progress)
// ---------------------------------------------------------------------------

export type StatusEventType =
  | "status"
  | "token"
  | "done"
  | "error";

export interface StatusEvent {
  type: StatusEventType;
  content: string;
  metadata?: AnswerMetadata;
  citations?: Citation[];
}

// ---------------------------------------------------------------------------
// Controller input / output
// ---------------------------------------------------------------------------

export interface ControllerInput {
  conversationId: string;
  message: string;
  /** Current message ID to exclude from history retrieval */
  currentMessageId?: string;
  /** If provided, use as the reference "now". Defaults to actual now. */
  referenceDate?: Date;
}

export interface ControllerResult {
  answer: string;
  citations: Citation[];
  metadata: AnswerMetadata;
}

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

/** Retrieve historical messages for the current query. */
function retrieveHistoricalMessages(
  query: string,
  resolvedRange: DateRange | null,
  excludeMessageId?: string,
  limit = 10
): Message[] {
  const messages: Message[] = [];
  const seen = new Set<string>();

  if (excludeMessageId) {
    seen.add(excludeMessageId);
  }

  // 1. Date-range retrieval if a date was resolved
  if (resolvedRange) {
    const byDate = getMessagesByDateRange(resolvedRange.start, resolvedRange.end);
    for (const m of byDate) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        messages.push(m);
      }
    }
  }

  // 2. FTS5 semantic search for topic tokens
  const topicTokens = extractTopicTokens(query);
  if (topicTokens.length > 0) {
    try {
      const ftsQuery = topicTokens.slice(0, 5).join(" ");
      const ftsResults = searchMessages(ftsQuery, limit);
      for (const r of ftsResults) {
        if (!seen.has(r.message.id)) {
          seen.add(r.message.id);
          messages.push(r.message);
        }
      }
    } catch {
      // FTS query might fail for special chars — not critical
    }
  }

  // Filter out any messages matching current query created within last 10 seconds
  const now = Date.now();
  const filtered = messages.filter((m) => {
    if (
      m.content.trim().toLowerCase() === query.trim().toLowerCase() &&
      Math.abs(now - new Date(m.createdAt).getTime()) < 10000
    ) {
      return false;
    }
    return true;
  });

  return filtered.slice(0, limit);
}

/** Retrieve historical claims for the resolved date range. */
function retrieveHistoricalClaims(
  resolvedRange: DateRange | null,
  windowDays = 30
): HistoricalClaim[] {
  if (!resolvedRange) return [];

  // Look at a ±windowDays window around the resolved date
  const start = new Date(resolvedRange.start);
  start.setUTCDate(start.getUTCDate() - windowDays);

  const end = new Date(resolvedRange.end);
  end.setUTCDate(end.getUTCDate() + windowDays);

  return getClaimsByDateRange(
    start.toISOString(),
    end.toISOString()
  );
}

// ---------------------------------------------------------------------------
// Evidence pipeline (Batch 2 layer)
// ---------------------------------------------------------------------------

async function buildEvidencePipeline(
  plan: SearchPlan,
  query: string
): Promise<Evidence[]> {
  if (plan.searchQueries.length === 0) return [];

  // 1. Parallel web search
  let evidence: Evidence[] = [];
  try {
    evidence = await webSearch({ queries: plan.searchQueries });
  } catch (err) {
    console.warn(
      "[controller] Web search failed:",
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }

  // 2. Deduplicate
  evidence = dedupeEvidence(evidence);

  // 3. Rank
  evidence = rankEvidence(evidence, query);

  // 4. Selective deep read
  if (plan.needsDeepRead) {
    const pages = selectPagesForDeepRead(evidence, 3);
    if (pages.length > 0) {
      const deepRead = await deepReadPages(pages);
      // Merge deep-read content back into ranked evidence
      const deepReadMap = new Map(deepRead.map((e) => [e.id, e]));
      evidence = evidence.map((e) => deepReadMap.get(e.id) ?? e);
    }
  }

  // 5. Selective redundancy pruning (keeps distinct candidate values, caps to 8-18 sources)
  evidence = pruneRedundantEvidence(evidence, { maxTotal: 18 });

  return evidence;
}

// ---------------------------------------------------------------------------
// Claim comparison pipeline
// ---------------------------------------------------------------------------

function buildComparisons(
  historicalClaims: HistoricalClaim[],
  claimsToVerify: Array<{ entity: string; claim: string }>,
  evidence: Evidence[]
): ClaimComparison[] {
  if (historicalClaims.length === 0 || evidence.length === 0) {
    return [];
  }

  // Find historical claims that match the planner's claimsToVerify list
  const candidateClaims =
    claimsToVerify.length > 0
      ? historicalClaims.filter((hc) =>
          claimsToVerify.some(
            (ctv) =>
              hc.entity
                ?.toLowerCase()
                .includes(ctv.entity.toLowerCase()) ||
              hc.claim.toLowerCase().includes(ctv.entity.toLowerCase())
          )
        )
      : historicalClaims;

  if (candidateClaims.length === 0) return [];

  const comparisons: ClaimComparison[] = [];

  for (const claim of candidateClaims.slice(0, 10)) {
    const relevantEvidence = findRelevantEvidence(claim, evidence);
    if (relevantEvidence.length > 0) {
      comparisons.push(compareClaim(claim, relevantEvidence));
    }
  }

  return comparisons;
}

// ---------------------------------------------------------------------------
// Main controller: streaming version
// ---------------------------------------------------------------------------

/**
 * Run the full research pipeline and stream status events + answer tokens.
 *
 * Yields StatusEvent objects in order:
 *   - status: progress messages ("Checking history...", etc.)
 *   - token:  answer text chunks (from LLM streaming)
 *   - done:   final event with metadata and citations
 *   - error:  if something went catastrophically wrong
 */
export async function* runController(
  input: ControllerInput,
  signal?: AbortSignal
): AsyncGenerator<StatusEvent> {
  const startMs = Date.now();
  const now = input.referenceDate ?? new Date();
  const currentDate = now.toISOString();

  // -------------------------------------------------------------------------
  // Step 1: Deterministic temporal resolution
  // -------------------------------------------------------------------------

  yield { type: "status", content: "Analyzing your query..." };

  const signals = extractRoutingSignals(input.message, now);

  // -------------------------------------------------------------------------
  // Step 2: Memory retrieval
  // -------------------------------------------------------------------------

  yield { type: "status", content: "Checking conversation history..." };

  const historicalMessages = retrieveHistoricalMessages(
    input.message,
    signals.resolvedDateRange,
    input.currentMessageId
  );

  const historicalClaims = retrieveHistoricalClaims(
    signals.resolvedDateRange
  );

  const hasHistoricalMemory = historicalMessages.length > 0;

  // -------------------------------------------------------------------------
  // Step 3: Routing
  // -------------------------------------------------------------------------

  const { mode, budget } = determineMode(signals, hasHistoricalMemory);

  if (signals.resolvedDateRange) {
    const dateStr = signals.resolvedDateRange.start.slice(0, 10);
    yield {
      type: "status",
      content: `Found temporal reference: ${dateStr}. ${
        hasHistoricalMemory
          ? `Found ${historicalMessages.length} relevant message(s).`
          : "No matching history found."
      }`
    };
  } else if (hasHistoricalMemory) {
    yield {
      type: "status",
      content: `Found ${historicalMessages.length} relevant message(s) in history.`
    };
  }

  // -------------------------------------------------------------------------
  // Step 4: LLM Planner — Hop #1 (skipped for pure memory mode)
  // -------------------------------------------------------------------------

  let plan: SearchPlan = {
    mode,
    searchQueries: [],
    claimsToVerify: [],
    needsDeepRead: false
  };

  let llmHops = 0;

  if (mode !== "memory") {
    yield { type: "status", content: "Planning research..." };
    llmHops++;

    plan = await runPlanner({
      query: input.message,
      mode,
      budget,
      currentDate,
      historicalMessages,
      historicalClaims,
      resolvedDate: signals.resolvedDateRange?.start
    });
  }

  // -------------------------------------------------------------------------
  // Step 5: Web search → dedupe → rank → deep read
  // -------------------------------------------------------------------------

  let evidence: Evidence[] = [];

  if (plan.searchQueries.length > 0) {
    yield {
      type: "status",
      content: `Searching the web (${plan.searchQueries.length} queries)...`
    };

    evidence = await buildEvidencePipeline(plan, input.message);

    if (evidence.length > 0) {
      yield {
        type: "status",
        content: `Found ${evidence.length} source(s).${
          plan.needsDeepRead ? " Reading top pages..." : ""
        }`
      };
    } else {
      yield {
        type: "status",
        content: "No web results found — using available context."
      };
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Claim comparison + provenance
  // -------------------------------------------------------------------------

  const comparisons = buildComparisons(
    historicalClaims,
    plan.claimsToVerify,
    evidence
  );

  if (comparisons.length > 0) {
    yield {
      type: "status",
      content: `Comparing ${comparisons.length} historical claim(s)...`
    };
  }

  const evidenceIndex = buildEvidenceIndex(evidence);
  void evidenceIndex; // available for future use
  const citations = buildCitations(evidence);

  // -------------------------------------------------------------------------
  // Step 7: Graceful fallback for memory-only with no results
  // -------------------------------------------------------------------------

  if (mode === "memory" && historicalMessages.length === 0) {
    const fallbackAnswer = noHistoryFoundAnswer(input.message);

    yield { type: "token", content: fallbackAnswer };

    const metadata = computeMetadata({
      startMs,
      usedMemory: false,
      historicalDate: signals.resolvedDateRange?.start,
      historicalClaims,
      comparisons,
      evidence,
      answer: fallbackAnswer
    });

    yield {
      type: "done",
      content: "",
      metadata,
      citations
    };

    return;
  }

  // -------------------------------------------------------------------------
  // Step 8: LLM Synthesizer — Hop #2 (streaming)
  // -------------------------------------------------------------------------

  yield { type: "status", content: "Preparing answer..." };
  llmHops++;

  const synthInput: SynthesizerInput = {
    query: input.message,
    mode,
    currentDate,
    historicalMessages,
    historicalClaims,
    evidence,
    comparisons,
    citations,
    resolvedDate: signals.resolvedDateRange?.start
  };

  const answerTokens: string[] = [];

  for await (const token of streamSynthesizer(synthInput, signal)) {
    answerTokens.push(token);
    yield { type: "token", content: token };
  }

  const fullAnswer = answerTokens.join("");

  if (llmHops > 0) {
    console.log(`[LLM] Hop count: ${llmHops}`);
  }

  // -------------------------------------------------------------------------
  // Step 9: Compute metadata (deterministic — no LLM)
  // -------------------------------------------------------------------------

  const metadata = computeMetadata({
    startMs,
    usedMemory: historicalMessages.length > 0,
    historicalDate: signals.resolvedDateRange?.start,
    historicalClaims,
    comparisons,
    evidence,
    answer: fullAnswer
  });

  yield {
    type: "done",
    content: "",
    metadata,
    citations
  };
}

// ---------------------------------------------------------------------------
// Non-streaming wrapper (stores messages in SQLite)
// ---------------------------------------------------------------------------

/**
 * Run the controller and collect the complete result.
 * Stores user message and assistant response in SQLite.
 *
 * Used for simple request-response endpoints.
 */
export async function runControllerAndStore(
  input: ControllerInput
): Promise<ControllerResult> {
  // Ensure conversation exists
  let conversationId = input.conversationId;
  if (!conversationId) {
    const convo = createConversation("Research session");
    conversationId = convo.id;
  }

  // Store user message
  const userMessage = addMessage(conversationId, "user", input.message);
  void userMessage;

  let answer = "";
  let citations: Citation[] = [];
  let metadata: AnswerMetadata | undefined;

  for await (const event of runController({
    ...input,
    conversationId,
    currentMessageId: userMessage.id
  })) {
    if (event.type === "token") {
      answer += event.content;
    } else if (event.type === "done") {
      citations = event.citations ?? [];
      metadata = event.metadata;
    }
  }

  // Store assistant response
  if (answer) {
    addMessage(conversationId, "assistant", answer);
  }

  // Kick off background claim extraction (non-blocking, failure-safe)
  if (answer) {
    setImmediate(() => {
      import("../memory/extractor.js")
        .then(({ extractClaims }) => {
          const msgId = randomUUID(); // placeholder; real msg id from addMessage
          return extractClaims(msgId, answer, new Date().toISOString());
        })
        .catch(() => {
          /* extraction failure must never surface */
        });
    });
  }

  return {
    answer,
    citations,
    metadata: metadata ?? {
      usedMemory: false,
      claimsRetrieved: 0,
      claimsVerified: 0,
      sourcesUsed: 0,
      officialSources: 0,
      conflicts: 0,
      confidence: "low",
      latencyMs: 0
    }
  };
}

