/**
 * dedupe.ts
 *
 * Remove duplicate Evidence objects before ranking.
 *
 * Duplicates appear when multiple queries return the same URL.
 * URLs are normalized conservatively before comparison to handle:
 *   - Trailing slash differences
 *   - Common tracking parameters (utm_*)
 * Meaningful query parameters (e.g. plan=pro) are preserved.
 */

import type { Evidence } from "../types/index.js";
import { extractCandidateValues } from "../evidence/comparator.js";

// ---------------------------------------------------------------------------
// Tracking parameters to strip (conservative list)
// ---------------------------------------------------------------------------

/**
 * URL query parameters that carry tracking information and do NOT
 * affect which resource is returned.  Extend this list carefully.
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_reader",
  "utm_name",
  "fbclid",
  "gclid",
  "msclkid",
  "ref",
  "referrer",
  "_ga",
  "_gl",
  "mc_cid",
  "mc_eid",
  "igshid",
  "s_cid",
  "ncid",
  "mkt_tok",
  "WT.mc_id"
]);

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a URL for deduplication purposes.
 *
 * Rules applied:
 *  1. Lowercase the scheme and hostname.
 *  2. Remove a trailing slash from the path (unless the path is "/").
 *  3. Strip known tracking query parameters.
 *  4. Preserve all other query parameters (sorted for stable comparison).
 *  5. Preserve fragment only when it identifies a document section
 *     (kept as-is — not stripped, not modified).
 *
 * Returns the original URL string unchanged when it cannot be parsed.
 */
export function normalizeUrl(raw: string): string {
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    // Malformed URL — use as-is
    return raw;
  }

  // 1. Lowercase scheme and hostname
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();

  // 2. Remove trailing slash from path (but keep bare "/")
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  // 3. Strip tracking params, preserve the rest
  const toDelete: string[] = [];

  for (const key of parsed.searchParams.keys()) {
    if (TRACKING_PARAMS.has(key) || TRACKING_PARAMS.has(key.toLowerCase())) {
      toDelete.push(key);
    }
  }

  for (const key of toDelete) {
    parsed.searchParams.delete(key);
  }

  // 4. Sort remaining query parameters for stable comparison
  parsed.searchParams.sort();

  return parsed.toString();
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * When the same normalized URL appears in multiple Evidence objects, keep
 * the one with the most useful metadata (preferring richer content/snippets
 * and higher authority scores).
 */
function mergeEvidence(a: Evidence, b: Evidence): Evidence {
  // Prefer the one with content; otherwise prefer higher authority score.
  if (a.content && !b.content) return a;
  if (b.content && !a.content) return b;

  if (a.authorityScore >= b.authorityScore) {
    return {
      ...a,
      // Carry over snippet from b if a lacks one
      snippet: a.snippet ?? b.snippet,
      // Carry over published date from b if a lacks one
      publishedAt: a.publishedAt ?? b.publishedAt
    };
  }

  return {
    ...b,
    snippet: b.snippet ?? a.snippet,
    publishedAt: b.publishedAt ?? a.publishedAt
  };
}

/**
 * Remove duplicate Evidence entries based on normalized URL.
 *
 * When two entries share the same normalized URL, they are merged to
 * preserve the strongest available metadata.
 *
 * The original array is not mutated.
 */
export function dedupeEvidence(evidence: Evidence[]): Evidence[] {
  const seen = new Map<string, Evidence>();

  for (const item of evidence) {
    const key = normalizeUrl(item.url);

    const existing = seen.get(key);

    if (existing === undefined) {
      seen.set(key, item);
    } else {
      seen.set(key, mergeEvidence(existing, item));
    }
  }

  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Selective Redundancy Pruning
// ---------------------------------------------------------------------------

export interface PruneEvidenceOptions {
  /** Maximum sources per domain (default: 2, or up to 3 if distinct values exist). */
  maxPerDomain?: number;
  /** Target maximum total sources (default: 18, within the 8–20 range). */
  maxTotal?: number;
}

/**
 * Prune redundant evidence while strictly preserving:
 *  1. Diverse domains and entities.
 *  2. Genuinely conflicting or tiered credible sources (e.g. startup offer vs standard pricing).
 *  3. Supporting sources from independent domains (news, review, community).
 *
 * Enforces a target of 8–20 sources for complex queries without dropping conflict signals.
 */
export function pruneRedundantEvidence(
  evidence: Evidence[],
  options: PruneEvidenceOptions = {}
): Evidence[] {
  const maxTotal = options.maxTotal ?? 18;
  const maxPerDomain = options.maxPerDomain ?? 2;

  // If already at or under the threshold, return as-is
  if (evidence.length <= 8) {
    return evidence;
  }

  const domainGroups = new Map<string, Evidence[]>();
  for (const item of evidence) {
    const d = item.domain.toLowerCase();
    const group = domainGroups.get(d) ?? [];
    group.push(item);
    domainGroups.set(d, group);
  }

  const kept: Evidence[] = [];

  for (const [, items] of domainGroups.entries()) {
    // Always keep the top-ranked item for this domain
    const top = items[0]!;
    kept.push(top);

    // Track candidate values (prices/numbers) seen for this domain
    const seenValues = new Set<string>(
      extractCandidateValues(
        [top.title, top.snippet ?? "", top.content?.slice(0, 2000) ?? ""].join(" ")
      )
    );

    let domainCount = 1;

    for (let i = 1; i < items.length; i++) {
      if (domainCount >= maxPerDomain + 1) break;

      const candidate = items[i]!;
      const candidateText = [
        candidate.title,
        candidate.snippet ?? "",
        candidate.content?.slice(0, 2000) ?? ""
      ].join(" ");
      const candidateValues = extractCandidateValues(candidateText);

      // Check if this page introduces a distinct numeric value (e.g., startup offer vs standard pricing)
      const hasDistinctValue = candidateValues.some((v) => !seenValues.has(v));

      if (hasDistinctValue) {
        // Genuinely conflicting or tiered credible source — PRESERVE
        for (const v of candidateValues) {
          seenValues.add(v);
        }
        kept.push(candidate);
        domainCount++;
      } else if (domainCount < maxPerDomain && candidate.sourceType !== "official") {
        // For non-official domains (e.g. news/review), allow up to maxPerDomain even without distinct prices
        kept.push(candidate);
        domainCount++;
      }
    }
  }

  // If pruning made it too small (< 8) but original had more, fill back from original ranked list respecting maxPerDomain
  if (kept.length < 8 && evidence.length >= 8) {
    const keptIds = new Set(kept.map((e) => e.id));
    const domainCounts = new Map<string, number>();
    for (const item of kept) {
      const d = item.domain.toLowerCase();
      domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
    }

    for (const item of evidence) {
      if (!keptIds.has(item.id)) {
        const d = item.domain.toLowerCase();
        const currentCount = domainCounts.get(d) ?? 0;
        if (currentCount < maxPerDomain) {
          kept.push(item);
          keptIds.add(item.id);
          domainCounts.set(d, currentCount + 1);
          if (kept.length >= 8) break;
        }
      }
    }
  }

  // Sort back by original rank order
  const idToRank = new Map<string, number>();
  evidence.forEach((e, idx) => idToRank.set(e.id, idx));

  kept.sort((a, b) => (idToRank.get(a.id) ?? 0) - (idToRank.get(b.id) ?? 0));

  // Cap to maxTotal (e.g. 18, within 8-20 range)
  return kept.slice(0, maxTotal);
}

