/**
 * src/agent/planner.ts
 *
 * LLM Hop #1 — Research Planning.
 *
 * Receives: user query + historical context + routing decision
 * Produces: SearchPlan (structured JSON — no prose)
 *
 * Uses NVIDIA NIM (nvidia/nemotron-3.5-super-vl-120b-a12b).
 * This module makes exactly ONE LLM call per user request.
 * If the LLM call fails, it falls back to a deterministic keyword-based plan.
 *
 * No web search here. No answer generation here.
 */

import type {
  HistoricalClaim,
  Message,
  SearchPlan
} from "../types/index.js";
import { Config } from "../config.js";
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerUserPrompt,
  plannerFallback
} from "./prompts.js";
import { getNvidiaClient } from "./nvidia.js";

// ---------------------------------------------------------------------------
// JSON parsing with safety
// ---------------------------------------------------------------------------

/**
 * Parse a SearchPlan from a raw LLM response string.
 * Strips markdown code fences if the model wrapped the JSON.
 * Returns null if the JSON is structurally invalid.
 */
function parsePlannerOutput(raw: string): SearchPlan | null {
  // Strip markdown fences: ```json ... ``` or ``` ... ```
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;

  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Try to extract JSON object from surrounding text
    const match = /\{[\s\S]*\}/.exec(stripped);
    if (!match) return null;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") return null;

  const obj = parsed as Record<string, unknown>;

  // Validate required fields with sensible defaults
  const mode = obj["mode"] as string;
  if (!["web", "memory", "verify"].includes(mode)) return null;

  const searchQueries = Array.isArray(obj["searchQueries"])
    ? (obj["searchQueries"] as Array<{ query: string; domains?: string[] }>).filter(
        (q) => typeof q?.query === "string" && q.query.trim().length > 0
      )
    : [];

  const claimsToVerify = Array.isArray(obj["claimsToVerify"])
    ? (
        obj["claimsToVerify"] as Array<{
          entity: string;
          claim: string;
        }>
      ).filter(
        (c) =>
          typeof c?.entity === "string" && typeof c?.claim === "string"
      )
    : [];

  const needsDeepRead =
    typeof obj["needsDeepRead"] === "boolean"
      ? obj["needsDeepRead"]
      : false;

  return {
    mode: mode as SearchPlan["mode"],
    searchQueries,
    claimsToVerify,
    needsDeepRead
  };
}

function enforcePlanConstraints(
  plan: SearchPlan,
  input: PlannerInput
): SearchPlan {
  // Safety: enforce budget cap (never let planner exceed budget)
  plan.searchQueries = plan.searchQueries.slice(0, input.budget);

  // Safety: memory mode must not trigger searches
  if (input.mode === "memory") {
    plan.searchQueries = [];
    plan.needsDeepRead = false;
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PlannerInput {
  query: string;
  mode: "web" | "memory" | "verify";
  budget: number;
  currentDate: string;
  historicalMessages: Message[];
  historicalClaims: HistoricalClaim[];
  resolvedDate?: string;
}

/**
 * Run LLM Hop #1: generate a research/search plan using NVIDIA Nemotron.
 *
 * Returns a validated SearchPlan.
 * Falls back to a deterministic keyword-based plan if the LLM fails.
 *
 * The returned plan's searchQueries are capped to the budget.
 * This function makes exactly one LLM call (or zero on fallback).
 */
export async function runPlanner(
  input: PlannerInput
): Promise<SearchPlan> {
  const apiKey = Config.nvidia.apiKey;

  if (!apiKey) {
    console.warn(
      "[planner] NVIDIA_API_KEY is not configured — using fallback plan."
    );
    return enforcePlanConstraints(
      plannerFallback(input.query, input.mode, input.budget),
      input
    );
  }

  const systemPrompt = PLANNER_SYSTEM_PROMPT.replace(
    "{BUDGET}",
    String(input.budget)
  );

  const userPrompt = buildPlannerUserPrompt({
    query: input.query,
    mode: input.mode,
    budget: input.budget,
    currentDate: input.currentDate,
    historicalMessages: input.historicalMessages,
    historicalClaims: input.historicalClaims,
    resolvedDate: input.resolvedDate
  });

  console.log("[LLM] Planner → NVIDIA Nemotron");

  let plan: SearchPlan | null = null;

  try {
    const client = getNvidiaClient();
    const response = await client.chat.completions.create(
      {
        model: Config.nvidia.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: Config.nvidia.plannerMaxTokens,
        temperature: 1.0,
        top_p: 0.95,
        response_format: { type: "json_object" },
        ...({
          chat_template_kwargs: {
            enable_thinking: false
          }
        } as any)
      },
      {
        timeout: Config.nvidia.plannerTimeoutMs
      }
    );

    const raw = response.choices?.[0]?.message?.content ?? "";
    plan = parsePlannerOutput(raw);

    if (!plan) {
      console.warn("[planner] LLM returned invalid JSON — using fallback plan.");
    }
  } catch (err) {
    console.warn(
      "[planner] LLM call failed — using fallback plan:",
      err instanceof Error ? err.message : String(err)
    );
  }

  // Fallback: keyword-based deterministic plan
  if (!plan) {
    plan = plannerFallback(input.query, input.mode, input.budget);
  }

  return enforcePlanConstraints(plan, input);
}
