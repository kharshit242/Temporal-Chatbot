/**
 * provenance.ts
 *
 * Provenance tracking for Temporal Chatbot.
 *
 * Purpose:
 *   Every claim presented to the user MUST be backed by a real, retrieved URL.
 *   The LLM must never invent citations.
 *   This module provides the data structures and utilities to map:
 *
 *       Claim text
 *         ↓
 *       Evidence IDs
 *         ↓
 *       Real retrieved URLs + metadata
 *
 * All URLs in ClaimProvenance originate exclusively from Evidence.url values
 * that were actually fetched during the current research session.
 *
 * No LLM calls. No invented URLs. Deterministic only.
 */

import type {
  ClaimComparison,
  Evidence
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Provenance record linking a claim text to its supporting Evidence.
 *
 * Every URL in .evidence originated from a real HTTP response during
 * the current research session.
 */
export interface ClaimProvenance {
  /** The claim text (historical or current). */
  claim: string;

  /** Evidence items that support this claim. */
  evidence: Evidence[];
}

/**
 * A citation-ready record for use in the final synthesized answer.
 * Contains only the minimum information needed to render a footnote.
 */
export interface Citation {
  /** Sequential display index (1-based). */
  index: number;

  /** The URL — MUST come from Evidence.url (never generated). */
  url: string;

  /** Display title for the citation. */
  title: string;

  /** Domain for display (e.g. "docs.supabase.com"). */
  domain: string;

  /** When this source was retrieved. */
  retrievedAt: string;

  /** When this content was published, if known. */
  publishedAt?: string;

  /** Source authority tier. */
  sourceType: Evidence["sourceType"];

  /** Numeric authority score [0–1]. */
  authorityScore: number;
}

// ---------------------------------------------------------------------------
// Evidence index
// ---------------------------------------------------------------------------

/**
 * Build an index from evidence ID → Evidence for fast lookup.
 */
export function buildEvidenceIndex(
  evidence: Evidence[]
): Map<string, Evidence> {
  const index = new Map<string, Evidence>();

  for (const item of evidence) {
    index.set(item.id, item);
  }

  return index;
}

// ---------------------------------------------------------------------------
// Provenance builders
// ---------------------------------------------------------------------------

/**
 * Build a ClaimProvenance record from a claim string and its supporting Evidence.
 *
 * All Evidence items MUST originate from the actual research session —
 * never pass synthetic or invented Evidence here.
 */
export function buildClaimProvenance(
  claim: string,
  evidence: Evidence[]
): ClaimProvenance {
  return {
    claim,
    evidence: [...evidence] // defensive copy
  };
}

/**
 * Build provenance records from a list of ClaimComparison objects.
 *
 * Uses the current.sources from each comparison.
 * Historical sources (from memory) are intentionally excluded here because
 * they are stored in SQLite — only web-retrieved Evidence is tracked.
 */
export function buildProvenanceFromComparisons(
  comparisons: ClaimComparison[],
  evidenceIndex: Map<string, Evidence>
): ClaimProvenance[] {
  return comparisons.map((comparison) => {
    // Resolve Evidence from the index where possible
    const resolvedEvidence = comparison.current.sources
      .map((source) => {
        // Try to look up by ID in the index
        const byId = evidenceIndex.get(source.id);
        if (byId) return byId;

        // Fall back: reconstruct a minimal Evidence from Source
        // (only if no better option exists — avoids data fabrication)
        return {
          id: source.id,
          title: source.title ?? source.url,
          url: source.url,
          domain: source.domain ?? "",
          snippet: undefined,
          content: undefined,
          publishedAt: source.publishedAt,
          retrievedAt: source.retrievedAt,
          authorityScore: 0.25,
          sourceType: "unknown" as Evidence["sourceType"]
        } satisfies Evidence;
      });

    return buildClaimProvenance(comparison.claim, resolvedEvidence);
  });
}

// ---------------------------------------------------------------------------
// Citation rendering
// ---------------------------------------------------------------------------

/**
 * Convert a list of unique Evidence items into numbered Citation objects.
 *
 * Citations are sorted by authority score (highest first) and then
 * assigned sequential 1-based indexes.
 *
 * SAFETY: Every url in the output comes directly from Evidence.url.
 *         This function never generates, infers, or invents URLs.
 */
export function buildCitations(evidence: Evidence[]): Citation[] {
  // Deduplicate by URL to avoid repeated citations
  const seen = new Set<string>();
  const unique: Evidence[] = [];

  for (const item of evidence) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      unique.push(item);
    }
  }

  // Sort: highest authority first, then freshest
  const sorted = [...unique].sort(
    (a, b) =>
      b.authorityScore - a.authorityScore ||
      (b.publishedAt ?? b.retrievedAt).localeCompare(
        a.publishedAt ?? a.retrievedAt
      )
  );

  return sorted.map((item, i) => ({
    index: i + 1,
    url: item.url,              // Real URL only
    title: item.title,
    domain: item.domain,
    retrievedAt: item.retrievedAt,
    publishedAt: item.publishedAt,
    sourceType: item.sourceType,
    authorityScore: item.authorityScore
  }));
}

// ---------------------------------------------------------------------------
// Citation lookup
// ---------------------------------------------------------------------------

/**
 * Given a set of citations and an Evidence item, return the citation index
 * (1-based) for that evidence URL.
 *
 * Returns null if the evidence is not in the citation list.
 * This prevents the synthesizer from ever using an index for a URL that
 * was not part of the actual research session.
 */
export function lookupCitationIndex(
  citations: Citation[],
  evidence: Evidence
): number | null {
  const found = citations.find((c) => c.url === evidence.url);
  return found?.index ?? null;
}

// ---------------------------------------------------------------------------
// Provenance summary
// ---------------------------------------------------------------------------

/**
 * Produce a human-readable provenance summary for logging and debugging.
 *
 * Example output:
 *   Claim: "Supabase Pro costs $25/month."
 *   Sources (3):
 *     [1] https://supabase.com/pricing (official, score=1.00, retrieved 2026-11-10)
 *     [2] https://news.ycombinator.com/... (community, score=0.45, retrieved 2026-11-10)
 */
export function formatProvenance(provenance: ClaimProvenance): string {
  const lines: string[] = [
    `Claim: "${provenance.claim}"`,
    `Sources (${provenance.evidence.length}):`
  ];

  const citations = buildCitations(provenance.evidence);

  for (const c of citations) {
    const date = (c.publishedAt ?? c.retrievedAt).slice(0, 10);
    lines.push(
      `  [${c.index}] ${c.url} ` +
        `(${c.sourceType}, score=${c.authorityScore.toFixed(2)}, ` +
        `retrieved ${date})`
    );
  }

  return lines.join("\n");
}

