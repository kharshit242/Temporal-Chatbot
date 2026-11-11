/**
 * claims.ts
 *
 * Evidence and claim data structures for the Batch 2 pipeline.
 *
 * Architectural principle:
 *   "Search results are evidence. Claims are statements derived from
 *    historical conversations or current sources."
 *
 * This module is entirely deterministic — no LLM calls.
 *
 * The claim layer operates on two classes of information:
 *   1. HistoricalClaim — from memory (SQLite), represents past state.
 *   2. Evidence        — from the web, represents current state.
 *
 * Utilities here help associate evidence with claims and prepare input
 * for the comparator.
 */

import type {
  Evidence,
  HistoricalClaim,
  Source
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Associates a claim text with the evidence IDs that support it.
 * Used internally before full ClaimComparison is built.
 */
export interface ClaimEvidence {
  claim: string;
  evidenceIds: string[];
}

/**
 * A current claim derived from web evidence (not historical memory).
 * The "claim" text is typically a snippet or extracted sentence.
 */
export interface CurrentClaim {
  /** The claim text as found in the evidence. */
  claim: string;
  /** The Evidence item from which this claim was derived. */
  evidence: Evidence;
  /** ISO timestamp of when this claim was retrieved. */
  retrievedAt: string;
}

// ---------------------------------------------------------------------------
// Evidence → Source conversion
// ---------------------------------------------------------------------------

/**
 * Convert an Evidence object into a Source for use in ClaimComparison.historical.
 *
 * Evidence and Source share most fields; this adapter bridges the gap.
 */
export function evidenceToSource(
  evidence: Evidence,
  messageId: string
): Source {
  return {
    id: evidence.id,
    messageId,
    url: evidence.url,
    title: evidence.title,
    domain: evidence.domain,
    retrievedAt: evidence.retrievedAt,
    publishedAt: evidence.publishedAt
  };
}

// ---------------------------------------------------------------------------
// Evidence grouping
// ---------------------------------------------------------------------------

/**
 * Group an array of Evidence items by their domain.
 * Useful for detecting when multiple results come from the same source.
 */
export function groupEvidenceByDomain(
  evidence: Evidence[]
): Map<string, Evidence[]> {
  const map = new Map<string, Evidence[]>();

  for (const item of evidence) {
    const existing = map.get(item.domain);

    if (existing) {
      existing.push(item);
    } else {
      map.set(item.domain, [item]);
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Claim → Evidence association
// ---------------------------------------------------------------------------

const GENERIC_ENTITIES: ReadonlySet<string> = new Set([
  "crm",
  "database",
  "databases",
  "software",
  "tool",
  "tools",
  "hosting",
  "cloud",
  "api",
  "service",
  "services",
  "product",
  "products",
  "app",
  "apps",
  "inquiry",
  "shortlist"
]);

/**
 * Find all Evidence items that are likely relevant to a HistoricalClaim.
 *
 * Matching strategy (deterministic, keyword-based):
 *  1. If claim has a specific entity (e.g. "HubSpot"), evidence must reference that entity.
 *  2. Tokenize the claim's entity, topic, and claim text into words.
 *  3. Score by token overlap, then sort by overlap desc and authority score desc.
 *
 * Returns the matching Evidence items.
 */
export function findRelevantEvidence(
  historicalClaim: HistoricalClaim,
  currentEvidence: Evidence[]
): Evidence[] {
  const tokens = buildClaimTokens(historicalClaim);

  if (tokens.length === 0) {
    // No useful tokens — return all evidence ranked by authority
    return [...currentEvidence].sort(
      (a, b) => b.authorityScore - a.authorityScore
    );
  }

  const rawEntity = (historicalClaim.entity ?? "").trim().toLowerCase();
  const hasSpecificEntity =
    rawEntity.length >= 3 && !GENERIC_ENTITIES.has(rawEntity);

  const scored = currentEvidence
    .map((e) => {
      const haystack = [
        e.domain,
        e.title,
        e.snippet ?? "",
        e.content?.slice(0, 1000) ?? ""
      ]
        .join(" ")
        .toLowerCase();

      // If this claim is specifically about a concrete entity (e.g. "HubSpot"),
      // evidence from unrelated vendors (e.g. pure Salesforce pages) cannot be relevant
      if (hasSpecificEntity && !haystack.includes(rawEntity)) {
        return { evidence: e, score: 0 };
      }

      return {
        evidence: e,
        score: computeTokenOverlap(e, tokens)
      };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        // Primary: token overlap; secondary: authority score
        b.score - a.score ||
        b.evidence.authorityScore - a.evidence.authorityScore
    );

  return scored.map(({ evidence }) => evidence);
}

/** Build a deduplicated set of lowercase tokens from a claim's metadata. */
function buildClaimTokens(claim: HistoricalClaim): string[] {
  const raw = [
    claim.entity ?? "",
    claim.topic ?? "",
    claim.claim
  ].join(" ");

  const tokens = raw
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length >= 3);

  return [...new Set(tokens)];
}

/** Count how many tokens appear in the evidence title/snippet/content. */
function computeTokenOverlap(evidence: Evidence, tokens: string[]): number {
  const haystack = [
    evidence.title,
    evidence.snippet ?? "",
    evidence.content?.slice(0, 1000) ?? ""
  ]
    .join(" ")
    .toLowerCase();

  return tokens.filter((t) => haystack.includes(t)).length;
}

// ---------------------------------------------------------------------------
// Claim building utilities
// ---------------------------------------------------------------------------

/**
 * Build a ClaimEvidence record linking a natural-language claim to
 * the IDs of the supporting Evidence objects.
 */
export function buildClaimEvidence(
  claim: string,
  supportingEvidence: Evidence[]
): ClaimEvidence {
  return {
    claim,
    evidenceIds: supportingEvidence.map((e) => e.id)
  };
}

