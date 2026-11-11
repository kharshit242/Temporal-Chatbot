/**
 * ranker.ts
 *
 * Evidence ranking: Authority × Freshness × Relevance.
 *
 * Scoring is entirely deterministic — no LLM calls.
 *
 * Authority scale (0–1):
 *   official       = 1.00
 *   documentation  = 0.90
 *   news           = 0.70
 *   community      = 0.45
 *   unknown        = 0.25
 *
 * Freshness scale (0–1):
 *   Based on days since publishedAt/retrievedAt.
 *   Very recent (< 7 days)  = ~1.00
 *   < 30 days               = ~0.80
 *   < 90 days               = ~0.60
 *   < 365 days              = ~0.40
 *   > 365 days              = ~0.20
 *   No date available       = 0.50 (neutral)
 *
 * Relevance scale (0–1):
 *   Simple keyword overlap between evidence title/snippet and query.
 *   At least one word match = partial relevance.
 *   No query provided       = 1.00 (no penalty).
 *
 * Content completeness bonus:
 *   Evidence with a non-empty snippet or content gets a +0.05 bonus.
 *
 * Final composite score = (authority * 0.45) + (freshness * 0.30) + (relevance * 0.20) + (completeness * 0.05)
 */

import type { Evidence } from "../types/index.js";

// ---------------------------------------------------------------------------
// Source classification
// ---------------------------------------------------------------------------

/** Subdomain prefixes that indicate documentation. */
const DOCUMENTATION_SUBDOMAINS: ReadonlySet<string> = new Set([
  "docs",
  "developer",
  "developers",
  "dev",
  "api",
  "reference",
  "help",
  "support",
  "wiki",
  "kb",
  "knowledge",
  "guide",
  "guides",
  "learn",
  "learning",
  "manual",
  "handbook",
  "ref"
]);

/** Domains known to be reputable news outlets. */
const NEWS_DOMAINS: ReadonlySet<string> = new Set([
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "nytimes.com",
  "theguardian.com",
  "washingtonpost.com",
  "wsj.com",
  "ft.com",
  "bloomberg.com",
  "forbes.com",
  "techcrunch.com",
  "theverge.com",
  "wired.com",
  "arstechnica.com",
  "venturebeat.com",
  "zdnet.com",
  "cnet.com",
  "engadget.com",
  "9to5mac.com",
  "macrumors.com",
  "infoq.com",
  "thenewstack.io",
  "devclass.com",
  "heise.de",
  "computerworld.com",
  "infoworld.com",
  "networkworld.com",
  "pcmag.com",
  "tomshardware.com",
  "anandtech.com",
  "axios.com",
  "politico.com",
  "cnbc.com",
  "businessinsider.com",
  "inc.com",
  "fastcompany.com",
  "economist.com",
  "time.com",
  "nationalgeographic.com",
  "scientificamerican.com",
  "nature.com",
  "science.org",
  "popsci.com",
  "spectrum.ieee.org"
]);

/** Domains known to be community platforms. */
const COMMUNITY_DOMAINS: ReadonlySet<string> = new Set([
  "reddit.com",
  "stackoverflow.com",
  "stackexchange.com",
  "news.ycombinator.com",
  "lobste.rs",
  "dev.to",
  "medium.com",
  "hashnode.com",
  "substack.com",
  "quora.com",
  "discourse.org",
  "discuss.com",
  "forum.com",
  "forums.com"
]);

/**
 * Classify a domain into a source type.
 * Uses heuristics only — does not consult an exhaustive domain database.
 */
export function classifySourceType(
  domain: string
): Evidence["sourceType"] {
  if (!domain) return "unknown";

  const lower = domain.toLowerCase();

  // Check community domains first (before subdomain logic)
  if (COMMUNITY_DOMAINS.has(lower)) return "community";
  for (const cd of COMMUNITY_DOMAINS) {
    if (lower.endsWith(`.${cd}`)) return "community";
  }

  // Check news domains
  if (NEWS_DOMAINS.has(lower)) return "news";
  for (const nd of NEWS_DOMAINS) {
    if (lower.endsWith(`.${nd}`)) return "news";
  }

  // Check for documentation subdomains
  const parts = lower.split(".");
  if (parts.length >= 2) {
    const subdomain = parts[0];
    if (DOCUMENTATION_SUBDOMAINS.has(subdomain)) return "documentation";
  }

  // Check for documentation paths not captured above
  if (
    lower.startsWith("docs.") ||
    lower.startsWith("developer.") ||
    lower.startsWith("developers.")
  ) {
    return "documentation";
  }

  // Everything else is treated as the official site for its domain
  // (i.e., company.com → official)
  return "official";
}

// ---------------------------------------------------------------------------
// Authority scoring
// ---------------------------------------------------------------------------

/** Map source type → authority score [0–1]. */
const AUTHORITY_SCORES: Record<Evidence["sourceType"], number> = {
  official: 1.0,
  documentation: 0.9,
  news: 0.7,
  community: 0.45,
  unknown: 0.25
};

/**
 * Return the numeric authority score for a given source type.
 */
export function computeAuthorityScore(
  sourceType: Evidence["sourceType"]
): number {
  return AUTHORITY_SCORES[sourceType] ?? 0.25;
}

// ---------------------------------------------------------------------------
// Freshness scoring
// ---------------------------------------------------------------------------

/**
 * Compute a freshness score [0–1] based on how many days ago the content
 * was published or retrieved.
 *
 *  < 7 days   → 1.0
 *  < 30 days  → 0.80
 *  < 90 days  → 0.60
 *  < 365 days → 0.40
 *  ≥ 365 days → 0.20
 *  no date    → 0.50 (neutral)
 */
function computeFreshnessScore(evidence: Evidence): number {
  const dateStr = evidence.publishedAt ?? evidence.retrievedAt;

  if (!dateStr) return 0.5;

  const date = new Date(dateStr);

  if (isNaN(date.getTime())) return 0.5;

  const nowMs = Date.now();
  const ageMs = nowMs - date.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays < 7) return 1.0;
  if (ageDays < 30) return 0.8;
  if (ageDays < 90) return 0.6;
  if (ageDays < 365) return 0.4;
  return 0.2;
}

// ---------------------------------------------------------------------------
// Relevance scoring
// ---------------------------------------------------------------------------

/**
 * Compute a simple keyword-overlap relevance score [0–1].
 *
 * Tokenizes the query into lowercased words (≥ 3 characters) and counts
 * how many appear in the title + snippet of the evidence.
 *
 * Returns 1.0 when no query is provided.
 */
function computeRelevanceScore(
  evidence: Evidence,
  query?: string
): number {
  if (!query || query.trim() === "") return 1.0;

  const queryTokens = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length >= 3);

  if (queryTokens.length === 0) return 1.0;

  const haystack = [
    evidence.title,
    evidence.snippet ?? "",
    evidence.content?.slice(0, 500) ?? ""
  ]
    .join(" ")
    .toLowerCase();

  const matched = queryTokens.filter((t) => haystack.includes(t));

  return matched.length / queryTokens.length;
}

// ---------------------------------------------------------------------------
// Composite score
// ---------------------------------------------------------------------------

/**
 * Compute a composite ranking score for a single Evidence item.
 *
 * Weights:
 *   Authority    45%
 *   Freshness    30%
 *   Relevance    20%
 *   Completeness  5%
 */
function compositeScore(evidence: Evidence, query?: string): number {
  const authority = computeAuthorityScore(evidence.sourceType);
  const freshness = computeFreshnessScore(evidence);
  const relevance = computeRelevanceScore(evidence, query);
  const completeness =
    evidence.snippet || evidence.content ? 1.0 : 0.0;

  return (
    authority * 0.45 +
    freshness * 0.3 +
    relevance * 0.2 +
    completeness * 0.05
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rank an array of Evidence from highest to lowest composite score.
 *
 * Returns a new sorted array; the original is not mutated.
 * An optional query string improves relevance scoring.
 */
export function rankEvidence(
  evidence: Evidence[],
  query?: string
): Evidence[] {
  return [...evidence].sort(
    (a, b) => compositeScore(b, query) - compositeScore(a, query)
  );
}

