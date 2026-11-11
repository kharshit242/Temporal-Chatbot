/**
 * comparator.ts
 *
 * Deterministic historical-vs-current claim comparison.
 *
 * The comparator receives a HistoricalClaim (from memory) and an array of
 * current Evidence (from the web), and determines the status of the claim:
 *
 *   unchanged   — current evidence strongly agrees with the historical claim.
 *   changed     — current evidence clearly disagrees (e.g. price moved).
 *   new         — no historical context; claim appears only in current sources.
 *   removed     — there is explicit evidence that the item no longer exists.
 *   uncertain   — insufficient evidence to determine the state.
 *   conflicting — credible current sources disagree with each other.
 *
 * Key safety rules:
 *   1. Absence of evidence ≠ evidence of removal.
 *      Only mark "removed" when evidence explicitly states so.
 *   2. When in doubt, return "uncertain" rather than inventing certainty.
 *   3. No LLM calls — all logic is deterministic.
 */

import type {
  ClaimComparison,
  ClaimStatus,
  Evidence,
  HistoricalClaim
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Value extraction helpers
// ---------------------------------------------------------------------------

/**
 * Patterns for extracting monetary/numeric values from text.
 * Each pattern has a named capture group "value".
 */
const CURRENCY_PATTERNS: RegExp[] = [
  // $25/month, $25 per month, $25/mo
  /\$\s*(?<value>[\d,]+(?:\.\d{1,2})?)\s*(?:\/|\s+per\s+)\s*(?:month|mo\b)/i,
  // USD 25
  /USD\s*(?<value>[\d,]+(?:\.\d{1,2})?)/i,
  // 25 dollars
  /(?<value>[\d,]+(?:\.\d{1,2})?)\s*dollars?/i,
  // "priced at $25" / "costs $25" / "is $25" / "at $25"
  /(?:price[ds]?\s+at|costs?\s+|is\s+|at\s+)\$\s*(?<value>[\d,]+(?:\.\d{1,2})?)/i,
  // Any bare dollar amount: $30 (fallback, broad)
  /\$\s*(?<value>[\d,]+(?:\.\d{1,2})?)/i
];

/**
 * Extract all candidate numeric values from a text string.
 * Returns them as normalized strings with up to 2 decimal places.
 */
export function extractCandidateValues(text: string): string[] {
  const results: string[] = [];

  for (const pattern of CURRENCY_PATTERNS) {
    const match = pattern.exec(text);

    if (match?.groups?.["value"]) {
      const normalized = parseFloat(
        match.groups["value"].replace(/,/g, "")
      ).toFixed(2);
      results.push(normalized);
    }
  }

  return [...new Set(results)];
}

/**
 * Normalize a currency amount to a canonical string (e.g. "25.00").
 * Returns null if the input cannot be parsed.
 */
export function normalizeCurrencyValue(raw: string): string | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  const num = parseFloat(cleaned);

  if (isNaN(num)) return null;

  return num.toFixed(2);
}

// ---------------------------------------------------------------------------
// Semantic equivalence helpers
// ---------------------------------------------------------------------------

/**
 * Check whether two claim strings are obviously semantically equivalent
 * using simple, deterministic heuristics:
 *
 *  1. After lowercasing and normalizing whitespace, the strings are identical.
 *  2. Extracted numeric/currency values match exactly.
 *
 * Returns true only when confident of equivalence.
 * Returns false (not "changed") when uncertain.
 */
export function areSemanticallySimilar(a: string, b: string): boolean {
  const normalize = (s: string): string =>
    s
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/['']/g, "'")
      .replace(/[""]/g, '"')
      .trim();

  if (normalize(a) === normalize(b)) return true;

  // Compare extracted numeric values
  const valuesA = extractCandidateValues(a);
  const valuesB = extractCandidateValues(b);

  if (valuesA.length > 0 && valuesB.length > 0) {
    // Intersect: if all values in A appear in B and vice versa → same
    const setB = new Set(valuesB);
    const allMatch = valuesA.every((v) => setB.has(v));
    const setA = new Set(valuesA);
    const allMatchReverse = valuesB.every((v) => setA.has(v));
    if (allMatch && allMatchReverse) return true;
  }

  return false;
}

/**
 * Check whether evidence text clearly contradicts the historical claim
 * on a numeric/currency value.
 *
 * Returns true only when both sides have exactly one extracted value and
 * those values differ.
 */
export function isClearValueChange(
  historicalText: string,
  currentText: string
): boolean {
  const historicalValues = extractCandidateValues(historicalText);
  const currentValues = extractCandidateValues(currentText);

  if (historicalValues.length !== 1 || currentValues.length !== 1) {
    return false;
  }

  return historicalValues[0] !== currentValues[0];
}

// ---------------------------------------------------------------------------
// Removal detection
// ---------------------------------------------------------------------------

/** Phrases that explicitly indicate a thing no longer exists. */
const REMOVAL_PHRASES: ReadonlyArray<RegExp> = [
  /no longer (?:available|offered|exist|supported|active)/i,
  /has been (?:discontinued|removed|deprecated|sunset|shut down|closed)/i,
  /was discontinued/i,
  /is discontinued/i,
  /deprecated and removed/i,
  /end of (?:life|service)/i,
  /eol(?:\s+announced)?/i
];

/**
 * Returns true when any evidence text contains explicit removal language
 * related to the entity in the historical claim.
 */
function detectRemoval(
  historicalClaim: HistoricalClaim,
  evidence: Evidence[]
): boolean {
  const entity = (historicalClaim.entity ?? "").toLowerCase();

  for (const e of evidence) {
    const haystack = [e.snippet ?? "", e.content?.slice(0, 2000) ?? ""]
      .join(" ")
      .toLowerCase();

    // Must mention the entity AND contain a removal phrase
    const mentionsEntity =
      entity.length === 0 || haystack.includes(entity);

    if (
      mentionsEntity &&
      REMOVAL_PHRASES.some((p) => p.test(haystack))
    ) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/**
 * Returns true when two or more credible evidence items contain different
 * numeric values for the same claim.
 *
 * "Credible" = authorityScore ≥ 0.4
 */
function detectConflict(evidence: Evidence[]): boolean {
  const credible = evidence.filter((e) => e.authorityScore >= 0.4);

  if (credible.length < 2) return false;

  const valueSets = credible
    .map((e) =>
      extractCandidateValues(
        [e.snippet ?? "", e.content?.slice(0, 2000) ?? ""].join(" ")
      )
    )
    .filter((vs) => vs.length > 0);

  if (valueSets.length < 2) return false;

  const allValues = new Set(valueSets.flat());

  return allValues.size > 1;
}

// ---------------------------------------------------------------------------
// Evidence → current value synthesis
// ---------------------------------------------------------------------------

/**
 * Produce a "current value" string from the highest-authority evidence.
 *
 * Prefers the first credible evidence item that has a non-empty snippet.
 * Falls back to the URL if no snippet is available.
 */
function synthesizeCurrentValue(evidence: Evidence[]): string {
  const best = [...evidence].sort(
    (a, b) => b.authorityScore - a.authorityScore
  );

  for (const e of best) {
    if (e.snippet && e.snippet.trim().length > 0) return e.snippet;
    if (e.content && e.content.trim().length > 0) {
      return e.content.slice(0, 300);
    }
  }

  return best[0]?.url ?? "(no evidence)";
}

// ---------------------------------------------------------------------------
// Status determination
// ---------------------------------------------------------------------------

function determineStatus(
  historicalClaim: HistoricalClaim,
  evidence: Evidence[]
): ClaimStatus {
  if (evidence.length === 0) {
    // No evidence at all — uncertain, not removed
    return "uncertain";
  }

  // Check for explicit removal language in evidence
  if (detectRemoval(historicalClaim, evidence)) {
    return "removed";
  }

  // Check for conflicting values across credible sources
  if (detectConflict(evidence)) {
    return "conflicting";
  }

  // Compare historical value with best current evidence
  const historicalText = historicalClaim.claim;
  const currentText = synthesizeCurrentValue(evidence);

  if (areSemanticallySimilar(historicalText, currentText)) {
    return "unchanged";
  }

  if (isClearValueChange(historicalText, currentText)) {
    return "changed";
  }

  // Not enough signal to be certain
  return "uncertain";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compare a historical claim against an array of current Evidence items.
 *
 * Returns a ClaimComparison with:
 *   - claim       — the original claim text.
 *   - historical  — the historical value and when it was valid.
 *   - current     — the best current synthesis and its supporting evidence.
 *   - status      — the deterministic comparison result.
 *
 * Note: ClaimComparison.current.sources is typed as Evidence[] (not Source[]).
 *       We pass currentEvidence directly — full metadata is preserved.
 *       ClaimComparison.historical.sources is typed as Source[]; the memory
 *       layer populates those when building the full comparison from SQLite.
 */
export function compareClaim(
  historicalClaim: HistoricalClaim,
  currentEvidence: Evidence[]
): ClaimComparison {
  const status = determineStatus(historicalClaim, currentEvidence);
  const currentValue = synthesizeCurrentValue(currentEvidence);

  // Use the most recent evidence date as the "current" date
  const currentDate =
    currentEvidence.length > 0
      ? currentEvidence.reduce((latest, e) => {
          const d = e.publishedAt ?? e.retrievedAt;
          return d > latest ? d : latest;
        }, currentEvidence[0]?.publishedAt ?? currentEvidence[0]?.retrievedAt ?? new Date().toISOString())
      : new Date().toISOString();

  return {
    claim: historicalClaim.claim,

    historical: {
      value: historicalClaim.claim,
      date: historicalClaim.validAt,
      sources: [] // Historical sources come from the memory layer
    },

    current: {
      value: currentValue,
      date: currentDate,
      sources: currentEvidence // Evidence[] satisfies ClaimComparison.current.sources
    },

    status
  };
}

/**
 * Compare multiple historical claims against the same evidence pool.
 *
 * Each claim is compared independently.
 */
export function compareAllClaims(
  historicalClaims: HistoricalClaim[],
  currentEvidence: Evidence[]
): ClaimComparison[] {
  return historicalClaims.map((claim) =>
    compareClaim(claim, currentEvidence)
  );
}
