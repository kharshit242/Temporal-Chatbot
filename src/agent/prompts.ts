/**
 * src/agent/prompts.ts
 *
 * All LLM prompt text lives here.
 *
 * Rules:
 *  - No provider-specific logic.
 *  - No business logic.
 *  - Pure string construction only.
 *  - Planner prompts produce strict JSON (no prose).
 *  - Synthesizer prompts produce the final user-facing answer.
 */

import type {
  ClaimComparison,
  Evidence,
  HistoricalClaim,
  Message,
  SearchPlan
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Shared date/context helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC"
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Planner prompts
// ---------------------------------------------------------------------------

export const PLANNER_SYSTEM_PROMPT = `\
You are a research planning assistant for Temporal Chatbot.
Your sole job is to output a JSON search plan — nothing else.

The agent has access to:
  1. Conversation memory (SQLite) — historical messages from the user
  2. Web search (Tavily) — current information from the web

You will receive:
  - The user's current question
  - Any relevant historical messages retrieved from memory
  - Any historical claims that may need verification
  - The current date
  - The routing mode that has already been determined

Output ONLY a valid JSON object matching this exact schema:
{
  "mode": "web" | "memory" | "verify",
  "searchQueries": [
    { "query": string, "domains"?: string[] }
  ],
  "claimsToVerify": [
    { "entity": string, "claim": string }
  ],
  "needsDeepRead": boolean
}

Rules:
  - mode must match the routing mode provided to you
  - searchQueries: generate 1–{BUDGET} specific, targeted queries. For memory mode: []
  - Each query must be specific and actionable (not vague)
  - For verification queries, generate focused queries directly targeting the specific entities/claims from history. Avoid generating multiple overlapping queries for the same entity.
  - claimsToVerify: list historical claims that need current web verification
  - needsDeepRead: true only when pricing pages, changelogs, or documentation are needed
  - For memory-only mode, searchQueries must be empty and needsDeepRead must be false
  - Output ONLY the JSON object — no markdown fences, no explanation, no prose
`;

export function buildPlannerUserPrompt(opts: {
  query: string;
  mode: string;
  budget: number;
  currentDate: string;
  historicalMessages: Message[];
  historicalClaims: HistoricalClaim[];
  resolvedDate?: string;
}): string {
  const lines: string[] = [
    `Current date: ${formatDate(opts.currentDate)}`,
    `Routing mode: ${opts.mode}`,
    `Max search queries: ${opts.budget}`,
    "",
    `User question: ${opts.query}`
  ];

  if (opts.resolvedDate) {
    lines.push(`Resolved temporal reference: ${formatDate(opts.resolvedDate)}`);
  }

  if (opts.historicalMessages.length > 0) {
    lines.push("", "--- Relevant historical messages ---");
    for (const m of opts.historicalMessages.slice(0, 8)) {
      const role = m.role === "user" ? "User" : "Assistant";
      const date = formatDate(m.createdAt);
      lines.push(`[${date}] ${role}: ${m.content.slice(0, 400)}`);
    }
  }

  if (opts.historicalClaims.length > 0) {
    lines.push("", "--- Historical claims to potentially verify ---");
    for (const c of opts.historicalClaims.slice(0, 10)) {
      const entity = c.entity ? `[${c.entity}] ` : "";
      lines.push(`- ${entity}${c.claim} (valid at: ${formatDate(c.validAt)})`);
    }
  }

  lines.push(
    "",
    "Generate the JSON search plan now. Output ONLY the JSON — no other text."
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Synthesizer prompts
// ---------------------------------------------------------------------------

export const SYNTHESIZER_SYSTEM_PROMPT = `\
You are a research synthesizer for Temporal Chatbot.
Your job is to produce a clear, accurate answer to the user's question.

Core principle: Past conversation is historical evidence, not current truth.
If information has changed since it was last discussed, say so explicitly.

Citation rules:
  - Use inline citations like [1], [2] referencing the EVIDENCE LIST below
  - Every factual claim must have a citation
  - NEVER invent URLs, sources, or citations not in the evidence list
  - If you have no evidence for a claim, say you couldn't verify it

Formatting:
  - Be concise but complete
  - For temporal verification (Mode: verify, when current web evidence is provided):
      Summary: one-sentence answer
      Historical: what was said before
      Current: what the evidence shows now
      Status: Unchanged / Changed / Uncertain / Conflicting
  - For current web questions (Mode: web):
      Direct answer with inline citations [1], [2] referencing current evidence.
  - For memory-only questions (Mode: memory):
      Answer strictly what was asked or discussed historically from conversation memory.
      Structure:
        On [Date], you asked/discussed:
        - [bullet points of questions or topics discussed]
        This is based on the conversation history from [Date].
      Rules for memory-only mode:
        * Do NOT include a "Current" section.
        * Do NOT claim something is "unchanged" or "current".
        * Do NOT imply that web verification occurred.
        * Do NOT assign a temporal change status such as "Status: Unchanged".

Honesty rules:
  - If information is conflicting, acknowledge the conflict
  - If evidence is missing, say so — do NOT fabricate
  - Use "as of [date]" for time-sensitive facts
  - Never claim certainty you do not have
`;

export function buildSynthesizerUserPrompt(opts: {
  query: string;
  mode: string;
  currentDate: string;
  historicalMessages: Message[];
  historicalClaims: HistoricalClaim[];
  evidence: Evidence[];
  comparisons: ClaimComparison[];
  resolvedDate?: string;
}): string {
  const lines: string[] = [
    `Current date: ${formatDate(opts.currentDate)}`,
    `Mode: ${opts.mode}`,
    "",
    `User question: ${opts.query}`
  ];

  if (opts.resolvedDate) {
    lines.push(`Temporal reference resolved to: ${formatDate(opts.resolvedDate)}`);
  }

  // Historical context
  if (opts.historicalMessages.length > 0) {
    lines.push("", "=== HISTORICAL CONVERSATION ===");
    for (const m of opts.historicalMessages.slice(0, 10)) {
      const role = m.role === "user" ? "User" : "Assistant";
      const date = formatDate(m.createdAt);
      lines.push(`[${date}] ${role}: ${m.content.slice(0, 600)}`);
    }
  }

  if (opts.historicalClaims.length > 0) {
    lines.push("", "=== HISTORICAL CLAIMS ===");
    for (const c of opts.historicalClaims.slice(0, 10)) {
      const entity = c.entity ? `[${c.entity}] ` : "";
      lines.push(`- ${entity}"${c.claim}" (from ${formatDate(c.validAt)})`);
    }
  }

  // Claim comparisons
  if (opts.comparisons.length > 0) {
    lines.push("", "=== CLAIM COMPARISONS (historical vs current) ===");
    for (const cmp of opts.comparisons) {
      lines.push(`Claim: "${cmp.claim}"`);
      lines.push(`  Historical: ${cmp.historical.value} (as of ${formatDate(cmp.historical.date)})`);
      lines.push(`  Current:    ${cmp.current.value}`);
      lines.push(`  Status:     ${cmp.status.toUpperCase()}`);
    }
  }

  // Current evidence (numbered for citation)
  if (opts.evidence.length > 0) {
    lines.push("", "=== CURRENT EVIDENCE (use [N] for inline citations) ===");
    opts.evidence.forEach((e, i) => {
      const pub = e.publishedAt ? ` | published ${formatDate(e.publishedAt)}` : "";
      lines.push(`[${i + 1}] ${e.title} — ${e.url}${pub}`);
      if (e.snippet) {
        lines.push(`    Snippet: ${e.snippet.slice(0, 300)}`);
      }
      if (e.content && !e.snippet) {
        lines.push(`    Content: ${e.content.slice(0, 300)}`);
      }
    });
  }

  if (opts.mode === "memory") {
    const dateStr = opts.resolvedDate ? formatDate(opts.resolvedDate) : "the referenced date";
    lines.push(
      "",
      "=== INSTRUCTIONS FOR MEMORY-ONLY MODE ===",
      "This is a MEMORY-ONLY query. No web search or current verification was conducted.",
      `Answer what was discussed or asked on ${dateStr} using the historical conversation above.`,
      "- Do NOT include a 'Current' section.",
      "- Do NOT output a 'Status' line (e.g. do not write 'Status: Unchanged').",
      "- Do NOT claim that information is currently valid or unchanged.",
      "- Do NOT imply web verification occurred.",
      `Structure your response as:`,
      `On ${dateStr}, you asked/discussed:`,
      `- [bullet points of questions or topics discussed]`,
      `This is based on the conversation history from ${dateStr}.`
    );
  } else {
    lines.push(
      "",
      "Now answer the user's question using ONLY the information above.",
      "Cite evidence with [N] numbers matching the list. Do NOT invent sources."
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Fallback answer templates (no LLM)
// ---------------------------------------------------------------------------

export function noHistoryFoundAnswer(query: string): string {
  return (
    `I couldn't find a matching conversation in the stored history for your query: "${query}". ` +
    `The memory only contains conversations that have been stored in this session.`
  );
}

export function noEvidenceAnswer(query: string): string {
  return (
    `I found historical context related to your query, but I couldn't retrieve current web evidence to verify or answer it. ` +
    `Please check your SEARCH_API_KEY configuration or try again later.`
  );
}

export function plannerFallback(query: string, mode: string, budget: number): SearchPlan {
  // Extract key terms as fallback search queries
  const terms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 3)
    .slice(0, 4);

  const fallbackQuery = terms.length > 0 ? terms.join(" ") : query;

  return {
    mode: mode as SearchPlan["mode"],
    searchQueries:
      mode === "memory"
        ? []
        : [{ query: fallbackQuery }, { query: `${fallbackQuery} 2026` }].slice(
            0,
            budget
          ),
    claimsToVerify: [],
    needsDeepRead: false
  };
}

