/**
 * src/agent/synthesizer.ts
 *
 * LLM Hop #2 — Answer Synthesis.
 *
 * Receives: everything gathered in the pipeline (evidence, comparisons,
 *           historical context, citations)
 * Produces: streaming text answer with inline citations
 *
 * Uses NVIDIA NIM (nvidia/nemotron-3.5-super-vl-120b-a12b).
 * This module makes exactly ONE LLM call per user request (streaming).
 * It never calls the web. It never calls the planner.
 * Citation URLs are ONLY resolved from actual Evidence.url values.
 */

import type {
  AnswerMetadata,
  ClaimComparison,
  Evidence,
  HistoricalClaim,
  Message
} from "../types/index.js";
import { Config } from "../config.js";
import {
  SYNTHESIZER_SYSTEM_PROMPT,
  buildSynthesizerUserPrompt
} from "./prompts.js";
import type { Citation } from "../evidence/provenance.js";
import { getNvidiaClient } from "./nvidia.js";

// ---------------------------------------------------------------------------
// Synthesizer output types
// ---------------------------------------------------------------------------

export interface SynthesizerInput {
  query: string;
  mode: "web" | "memory" | "verify";
  currentDate: string;
  historicalMessages: Message[];
  historicalClaims: HistoricalClaim[];
  evidence: Evidence[];
  comparisons: ClaimComparison[];
  citations: Citation[];
  resolvedDate?: string;
}

export interface SynthesisResult {
  /** Complete answer text. */
  answer: string;
  /** Ordered citation list from actual Evidence. */
  citations: Citation[];
  /** Computed metadata (not from LLM). */
  metadata: AnswerMetadata;
}

// ---------------------------------------------------------------------------
// Metadata computation (deterministic — never LLM)
// ---------------------------------------------------------------------------

export function computeMetadata(opts: {
  startMs: number;
  usedMemory: boolean;
  historicalDate?: string;
  historicalClaims: HistoricalClaim[];
  comparisons: ClaimComparison[];
  evidence: Evidence[];
  answer: string;
}): AnswerMetadata {
  const officialSources = opts.evidence.filter(
    (e) => e.sourceType === "official" || e.sourceType === "documentation"
  ).length;

  const conflicts = opts.comparisons.filter(
    (c) => c.status === "conflicting"
  ).length;

  const claimsVerified = opts.comparisons.filter(
    (c) => c.status !== "uncertain"
  ).length;

  // Confidence heuristic (deterministic)
  let confidence: AnswerMetadata["confidence"] = "low";
  if (officialSources >= 2 && opts.evidence.length >= 3) {
    confidence = "high";
  } else if (officialSources >= 1 || opts.evidence.length >= 2) {
    confidence = "medium";
  } else if (opts.usedMemory && opts.evidence.length === 0) {
    confidence = "high";
  }

  // Downgrade for conflicts
  if (conflicts > 0 && confidence === "high") confidence = "medium";

  return {
    usedMemory: opts.usedMemory,
    historicalDate: opts.historicalDate,
    claimsRetrieved: opts.historicalClaims.length,
    claimsVerified,
    sourcesUsed: opts.evidence.length,
    officialSources,
    conflicts,
    confidence,
    latencyMs: Date.now() - opts.startMs
  };
}

// ---------------------------------------------------------------------------
// Fallback synthesizer (no LLM)
// ---------------------------------------------------------------------------

function buildFallbackAnswer(input: SynthesizerInput): string {
  const lines: string[] = [];

  if (input.mode === "memory" && input.historicalMessages.length === 0) {
    return (
      `I couldn't find a matching conversation in the stored history ` +
      `for your query: "${input.query}".`
    );
  }

  if (input.mode === "memory" && input.historicalMessages.length > 0) {
    lines.push(`Here is what I found in the conversation history:\n`);
    for (const m of input.historicalMessages.slice(0, 5)) {
      const role = m.role === "user" ? "You" : "Assistant";
      lines.push(`**${role}** (${m.createdAt.slice(0, 10)}): ${m.content}`);
    }
    return lines.join("\n");
  }

  if (input.evidence.length === 0) {
    return (
      `I found historical context related to your query but couldn't retrieve ` +
      `current web evidence to verify or answer it confidently.`
    );
  }

  lines.push(`Based on current web sources:\n`);
  for (const e of input.evidence.slice(0, 3)) {
    if (e.snippet) lines.push(`- ${e.snippet} (${e.url})`);
  }

  if (input.comparisons.length > 0) {
    lines.push(`\n**Claim comparisons:**`);
    for (const c of input.comparisons) {
      lines.push(
        `- "${c.claim}": ${c.status.toUpperCase()} ` +
          `(was: "${c.historical.value.slice(0, 80)}", ` +
          `now: "${c.current.value.slice(0, 80)}")`
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public streaming API
// ---------------------------------------------------------------------------

/**
 * Run LLM Hop #2: stream the synthesized answer using NVIDIA Nemotron.
 *
 * Yields string tokens as they arrive from NVIDIA.
 * On LLM failure, yields a deterministic fallback answer as a single chunk.
 *
 * Makes exactly one LLM call (streaming).
 * Never calls the web or the planner.
 * Never yields reasoning_content to the consumer.
 */
export async function* streamSynthesizer(
  input: SynthesizerInput,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const apiKey = Config.nvidia.apiKey;

  if (!apiKey) {
    console.warn(
      "[synthesizer] NVIDIA_API_KEY is not configured — using fallback."
    );
    yield buildFallbackAnswer(input);
    return;
  }

  const userPrompt = buildSynthesizerUserPrompt({
    query: input.query,
    mode: input.mode,
    currentDate: input.currentDate,
    historicalMessages: input.historicalMessages,
    historicalClaims: input.historicalClaims,
    evidence: input.evidence,
    comparisons: input.comparisons,
    resolvedDate: input.resolvedDate
  });

  console.log("[LLM] Synthesizer → NVIDIA Nemotron");

  try {
    const client = getNvidiaClient();
    const stream = (await client.chat.completions.create(
      {
        model: Config.nvidia.model,
        messages: [
          { role: "system", content: SYNTHESIZER_SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ],
        max_tokens: Config.nvidia.synthesizerMaxTokens,
        temperature: 1.0,
        top_p: 0.95,
        stream: true,
        ...({
          chat_template_kwargs: {
            enable_thinking: false
          }
        } as any)
      } as any,
      {
        signal,
        timeout: Config.nvidia.synthesizerTimeoutMs
      }
    )) as unknown as AsyncIterable<any>;

    let hasYielded = false;

    for await (const chunk of stream) {
      if (signal?.aborted) break;

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      // DO NOT yield reasoning_content
      // Only stream user-facing answer content
      const content = choice.delta?.content;
      if (content) {
        hasYielded = true;
        yield content;
      }
    }

    if (!hasYielded && !signal?.aborted) {
      console.warn(
        "[synthesizer] LLM returned empty stream — using fallback answer."
      );
      yield buildFallbackAnswer(input);
    }
  } catch (err) {
    console.warn(
      "[synthesizer] LLM streaming failed — using fallback:",
      err instanceof Error ? err.message : String(err)
    );
    yield buildFallbackAnswer(input);
  }
}

/**
 * Non-streaming variant — collects all tokens into a single string.
 * Used when streaming is not needed (e.g. tests, batch processing).
 */
export async function runSynthesizer(
  input: SynthesizerInput,
  signal?: AbortSignal
): Promise<string> {
  const tokens: string[] = [];

  for await (const token of streamSynthesizer(input, signal)) {
    tokens.push(token);
  }

  return tokens.join("");
}
