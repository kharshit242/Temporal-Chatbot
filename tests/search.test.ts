/**
 * search.test.ts
 *
 * Tests for Batch 2: search, deduplication, ranking, reader, comparator,
 * claims, and provenance.
 *
 * Network calls are mocked — no live API keys required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { dedupeEvidence, normalizeUrl, pruneRedundantEvidence } from "../src/search/dedupe.js";
import {
  rankEvidence,
  classifySourceType,
  computeAuthorityScore
} from "../src/search/ranker.js";
import {
  selectPagesForDeepRead,
  deepReadPage
} from "../src/search/reader.js";
import {
  compareClaim,
  extractCandidateValues,
  areSemanticallySimilar,
  isClearValueChange
} from "../src/evidence/comparator.js";
import {
  buildClaimProvenance,
  buildCitations,
  lookupCitationIndex
} from "../src/evidence/provenance.js";
import {
  buildClaimEvidence,
  findRelevantEvidence
} from "../src/evidence/claims.js";
import type { Evidence, HistoricalClaim } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: overrides.id ?? "test-id",
    title: overrides.title ?? "Test Page",
    url: overrides.url ?? "https://example.com/page",
    domain: overrides.domain ?? "example.com",
    snippet: overrides.snippet,
    content: overrides.content,
    publishedAt: overrides.publishedAt,
    retrievedAt: overrides.retrievedAt ?? new Date().toISOString(),
    authorityScore: overrides.authorityScore ?? 0.5,
    sourceType: overrides.sourceType ?? "unknown"
  };
}

function makeHistoricalClaim(
  overrides: Partial<HistoricalClaim> = {}
): HistoricalClaim {
  return {
    id: overrides.id ?? "claim-1",
    messageId: overrides.messageId ?? "msg-1",
    claim: overrides.claim ?? "Test claim",
    validAt: overrides.validAt ?? "2026-01-01T00:00:00.000Z",
    entity: overrides.entity,
    topic: overrides.topic
  };
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

describe("URL normalization", () => {
  it("lowercases the hostname", () => {
    expect(normalizeUrl("https://Example.COM/path")).toBe(
      "https://example.com/path"
    );
  });

  it("removes trailing slash from path", () => {
    expect(normalizeUrl("https://example.com/page/")).toBe(
      "https://example.com/page"
    );
  });

  it("preserves bare root slash", () => {
    expect(normalizeUrl("https://example.com/")).toBe(
      "https://example.com/"
    );
  });

  it("strips utm_ tracking parameters", () => {
    const url = "https://example.com/pricing?utm_source=x&utm_medium=y";
    expect(normalizeUrl(url)).toBe("https://example.com/pricing");
  });

  it("preserves meaningful query parameters", () => {
    const url = "https://example.com/pricing?plan=pro";
    expect(normalizeUrl(url)).toBe("https://example.com/pricing?plan=pro");
  });

  it("does NOT equate different meaningful params", () => {
    const a = normalizeUrl("https://example.com/pricing?plan=pro");
    const b = normalizeUrl("https://example.com/pricing?plan=free");
    expect(a).not.toBe(b);
  });

  it("equates utm-only difference to no params", () => {
    const a = normalizeUrl(
      "https://example.com/pricing?utm_source=newsletter"
    );
    const b = normalizeUrl("https://example.com/pricing");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("dedupeEvidence", () => {
  it("returns a single result when the same URL appears twice", () => {
    const e1 = makeEvidence({
      id: "a",
      url: "https://example.com/page",
      authorityScore: 0.9
    });
    const e2 = makeEvidence({
      id: "b",
      url: "https://example.com/page",
      authorityScore: 0.5
    });

    const result = dedupeEvidence([e1, e2]);
    expect(result).toHaveLength(1);
    // Should keep the higher-authority one
    expect(result[0]?.authorityScore).toBe(0.9);
  });

  it("treats trailing-slash variant as duplicate", () => {
    const e1 = makeEvidence({ id: "a", url: "https://example.com/page" });
    const e2 = makeEvidence({ id: "b", url: "https://example.com/page/" });

    const result = dedupeEvidence([e1, e2]);
    expect(result).toHaveLength(1);
  });

  it("treats utm-stripped URL as duplicate", () => {
    const e1 = makeEvidence({
      id: "a",
      url: "https://example.com/page?utm_source=twitter"
    });
    const e2 = makeEvidence({ id: "b", url: "https://example.com/page" });

    const result = dedupeEvidence([e1, e2]);
    expect(result).toHaveLength(1);
  });

  it("preserves distinct URLs", () => {
    const e1 = makeEvidence({ id: "a", url: "https://example.com/a" });
    const e2 = makeEvidence({ id: "b", url: "https://example.com/b" });

    const result = dedupeEvidence([e1, e2]);
    expect(result).toHaveLength(2);
  });

  it("does not mutate the original array", () => {
    const original = [
      makeEvidence({ id: "a", url: "https://example.com/page" }),
      makeEvidence({ id: "b", url: "https://example.com/page/" })
    ];
    const copy = [...original];
    dedupeEvidence(original);
    expect(original).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// Source classification
// ---------------------------------------------------------------------------

describe("classifySourceType", () => {
  it("classifies docs.* as documentation", () => {
    expect(classifySourceType("docs.supabase.com")).toBe("documentation");
  });

  it("classifies developer.* as documentation", () => {
    expect(classifySourceType("developer.apple.com")).toBe("documentation");
  });

  it("classifies reddit.com as community", () => {
    expect(classifySourceType("reddit.com")).toBe("community");
  });

  it("classifies stackoverflow.com as community", () => {
    expect(classifySourceType("stackoverflow.com")).toBe("community");
  });

  it("classifies reuters.com as news", () => {
    expect(classifySourceType("reuters.com")).toBe("news");
  });

  it("classifies techcrunch.com as news", () => {
    expect(classifySourceType("techcrunch.com")).toBe("news");
  });

  it("classifies a plain company domain as official", () => {
    expect(classifySourceType("supabase.com")).toBe("official");
  });

  it("returns unknown for empty string", () => {
    expect(classifySourceType("")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

describe("rankEvidence", () => {
  it("official source ranks above unknown source", () => {
    const official = makeEvidence({
      id: "a",
      sourceType: "official",
      authorityScore: computeAuthorityScore("official"),
      retrievedAt: new Date().toISOString(),
      snippet: "Official pricing page"
    });

    const unknown = makeEvidence({
      id: "b",
      sourceType: "unknown",
      authorityScore: computeAuthorityScore("unknown"),
      retrievedAt: new Date().toISOString(),
      snippet: "Some page"
    });

    const ranked = rankEvidence([unknown, official]);

    expect(ranked[0]?.id).toBe("a");
  });

  it("news ranks above community", () => {
    const news = makeEvidence({
      id: "a",
      sourceType: "news",
      authorityScore: computeAuthorityScore("news"),
      retrievedAt: new Date().toISOString(),
      snippet: "Breaking"
    });

    const community = makeEvidence({
      id: "b",
      sourceType: "community",
      authorityScore: computeAuthorityScore("community"),
      retrievedAt: new Date().toISOString(),
      snippet: "Reddit post"
    });

    const ranked = rankEvidence([community, news]);
    expect(ranked[0]?.id).toBe("a");
  });

  it("does not mutate the input array", () => {
    const e1 = makeEvidence({ id: "a", sourceType: "community", authorityScore: 0.45 });
    const e2 = makeEvidence({ id: "b", sourceType: "official", authorityScore: 1.0 });
    const original = [e1, e2];
    rankEvidence(original);
    expect(original[0]?.id).toBe("a");
  });

  it("recent source scores better than old one (same type)", () => {
    const recent = makeEvidence({
      id: "a",
      sourceType: "unknown",
      authorityScore: 0.25,
      publishedAt: new Date().toISOString(), // today
      snippet: "new info"
    });

    const old = makeEvidence({
      id: "b",
      sourceType: "unknown",
      authorityScore: 0.25,
      publishedAt: new Date(
        Date.now() - 400 * 24 * 60 * 60 * 1000
      ).toISOString(), // > 1 year ago
      snippet: "old info"
    });

    const ranked = rankEvidence([old, recent]);
    expect(ranked[0]?.id).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// Deep-read selection
// ---------------------------------------------------------------------------

describe("selectPagesForDeepRead", () => {
  it("selects pricing page", () => {
    const e = makeEvidence({
      url: "https://example.com/pricing",
      authorityScore: 0.9,
      sourceType: "official"
    });

    const selected = selectPagesForDeepRead([e]);
    expect(selected).toHaveLength(1);
  });

  it("selects changelog page", () => {
    const e = makeEvidence({
      url: "https://example.com/changelog",
      authorityScore: 0.9,
      sourceType: "official"
    });

    const selected = selectPagesForDeepRead([e]);
    expect(selected).toHaveLength(1);
  });

  it("caps at maxPages", () => {
    const pages = Array.from({ length: 10 }, (_, i) =>
      makeEvidence({
        id: `id-${i}`,
        url: `https://example.com/pricing${i}`,
        authorityScore: 0.9
      })
    );

    const selected = selectPagesForDeepRead(pages, 3);
    expect(selected).toHaveLength(3);
  });

  it("rejects file:// URLs", () => {
    const e = makeEvidence({
      url: "file:///etc/passwd",
      authorityScore: 0.9
    });

    const selected = selectPagesForDeepRead([e]);
    expect(selected).toHaveLength(0);
  });

  it("rejects low-authority pages", () => {
    const e = makeEvidence({
      url: "https://example.com/pricing",
      authorityScore: 0.1 // below threshold
    });

    const selected = selectPagesForDeepRead([e]);
    expect(selected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reader safety
// ---------------------------------------------------------------------------

describe("deepReadPage — safety", () => {
  it("rejects file:// protocol without crashing", async () => {
    const e = makeEvidence({ url: "file:///etc/passwd" });
    const result = await deepReadPage(e);
    // Should return original evidence unchanged (graceful failure)
    expect(result.url).toBe("file:///etc/passwd");
    expect(result.content).toBeUndefined();
  });

  it("rejects data: protocol without crashing", async () => {
    const e = makeEvidence({
      url: "data:text/html,<h1>hello</h1>"
    });
    const result = await deepReadPage(e);
    expect(result.content).toBeUndefined();
  });

  it("rejects javascript: protocol without crashing", async () => {
    const e = makeEvidence({ url: "javascript:alert(1)" });
    const result = await deepReadPage(e);
    expect(result.content).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Comparator — value extraction
// ---------------------------------------------------------------------------

describe("extractCandidateValues", () => {
  it("extracts dollar per month", () => {
    expect(
      extractCandidateValues("Supabase Pro costs $25/month.")
    ).toContain("25.00");
  });

  it("extracts price from 'priced at $30'", () => {
    expect(
      extractCandidateValues("The plan is priced at $30.")
    ).toContain("30.00");
  });

  it("returns empty for no price", () => {
    expect(extractCandidateValues("No price mentioned here.")).toHaveLength(
      0
    );
  });
});

// ---------------------------------------------------------------------------
// Comparator — semantic similarity
// ---------------------------------------------------------------------------

describe("areSemanticallySimilar", () => {
  it("matches identical strings", () => {
    expect(areSemanticallySimilar("foo bar", "foo bar")).toBe(true);
  });

  it("matches case-insensitive", () => {
    expect(areSemanticallySimilar("Supabase Pro", "supabase pro")).toBe(
      true
    );
  });

  it("matches paraphrased price", () => {
    expect(
      areSemanticallySimilar(
        "Supabase Pro costs $25/month.",
        "Supabase Pro is priced at $25 per month."
      )
    ).toBe(true);
  });

  it("does not match different prices", () => {
    expect(
      areSemanticallySimilar(
        "Supabase Pro costs $25/month.",
        "Supabase Pro costs $30/month."
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Comparator — value change detection
// ---------------------------------------------------------------------------

describe("isClearValueChange", () => {
  it("detects changed price", () => {
    expect(
      isClearValueChange(
        "Supabase Pro costs $25/month.",
        "Supabase Pro costs $30/month."
      )
    ).toBe(true);
  });

  it("does not trigger on same price", () => {
    expect(
      isClearValueChange(
        "Supabase Pro costs $25/month.",
        "Supabase Pro is priced at $25 per month."
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Comparator — claim status
// ---------------------------------------------------------------------------

describe("compareClaim", () => {
  it("returns 'uncertain' when no evidence", () => {
    const claim = makeHistoricalClaim({ claim: "Service costs $25/month." });
    const result = compareClaim(claim, []);
    expect(result.status).toBe("uncertain");
  });

  it("returns 'unchanged' when evidence agrees", () => {
    const claim = makeHistoricalClaim({
      claim: "Supabase Pro costs $25/month."
    });
    const evidence = [
      makeEvidence({
        snippet: "Supabase Pro is priced at $25 per month.",
        authorityScore: 0.9
      })
    ];
    const result = compareClaim(claim, evidence);
    expect(result.status).toBe("unchanged");
  });

  it("returns 'changed' when price clearly differs", () => {
    const claim = makeHistoricalClaim({
      claim: "Supabase Pro costs $25/month."
    });
    const evidence = [
      makeEvidence({
        snippet: "Supabase Pro costs $30/month.",
        authorityScore: 0.9
      })
    ];
    const result = compareClaim(claim, evidence);
    expect(result.status).toBe("changed");
  });

  it("returns 'conflicting' when credible sources disagree", () => {
    const claim = makeHistoricalClaim({
      claim: "Supabase Pro costs $25/month."
    });
    const evidence = [
      makeEvidence({
        id: "a",
        snippet: "Supabase Pro costs $25/month.",
        authorityScore: 0.9
      }),
      makeEvidence({
        id: "b",
        snippet: "Supabase Pro costs $30/month.",
        authorityScore: 0.7
      })
    ];
    const result = compareClaim(claim, evidence);
    expect(result.status).toBe("conflicting");
  });

  it("returns 'removed' when evidence contains removal language", () => {
    const claim = makeHistoricalClaim({
      claim: "Service X is available.",
      entity: "Service X"
    });
    const evidence = [
      makeEvidence({
        snippet: "Service X has been discontinued.",
        authorityScore: 0.9
      })
    ];
    const result = compareClaim(claim, evidence);
    expect(result.status).toBe("removed");
  });

  it("preserves claim text in output", () => {
    const claim = makeHistoricalClaim({ claim: "Some historical claim." });
    const result = compareClaim(claim, []);
    expect(result.claim).toBe("Some historical claim.");
  });

  it("includes current sources in output", () => {
    const claim = makeHistoricalClaim({ claim: "Costs $25." });
    const evidence = [
      makeEvidence({
        id: "ev1",
        url: "https://example.com/pricing",
        snippet: "Costs $25."
      })
    ];
    const result = compareClaim(claim, evidence);
    expect(result.current.sources.length).toBeGreaterThan(0);
    expect(result.current.sources[0]?.url).toBe(
      "https://example.com/pricing"
    );
  });
});

// ---------------------------------------------------------------------------
// Claims layer
// ---------------------------------------------------------------------------

describe("claims utilities", () => {
  it("buildClaimEvidence links claim to evidence IDs", () => {
    const e1 = makeEvidence({ id: "ev-1" });
    const e2 = makeEvidence({ id: "ev-2" });
    const result = buildClaimEvidence("Some claim", [e1, e2]);
    expect(result.claim).toBe("Some claim");
    expect(result.evidenceIds).toContain("ev-1");
    expect(result.evidenceIds).toContain("ev-2");
  });

  it("findRelevantEvidence returns evidence matching entity tokens", () => {
    const claim = makeHistoricalClaim({
      entity: "Supabase",
      topic: "pricing",
      claim: "Supabase Pro costs $25/month."
    });

    const relevant = makeEvidence({
      id: "r",
      title: "Supabase Pricing Plans",
      snippet: "Supabase Pro costs $25/month."
    });
    const irrelevant = makeEvidence({
      id: "x",
      title: "Unrelated Article About Cats",
      snippet: "Cats are fluffy."
    });

    const results = findRelevantEvidence(claim, [relevant, irrelevant]);
    expect(results[0]?.id).toBe("r");
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe("provenance utilities", () => {
  it("buildClaimProvenance includes all evidence", () => {
    const e1 = makeEvidence({ id: "a", url: "https://example.com/1" });
    const e2 = makeEvidence({ id: "b", url: "https://example.com/2" });
    const p = buildClaimProvenance("Test claim", [e1, e2]);
    expect(p.evidence).toHaveLength(2);
    expect(p.claim).toBe("Test claim");
  });

  it("buildCitations deduplicates by URL", () => {
    const e1 = makeEvidence({
      id: "a",
      url: "https://example.com/page",
      authorityScore: 0.9
    });
    const e2 = makeEvidence({
      id: "b",
      url: "https://example.com/page",
      authorityScore: 0.5
    });
    const citations = buildCitations([e1, e2]);
    expect(citations).toHaveLength(1);
  });

  it("buildCitations assigns sequential 1-based indexes", () => {
    const e1 = makeEvidence({ id: "a", url: "https://a.com", authorityScore: 0.9 });
    const e2 = makeEvidence({ id: "b", url: "https://b.com", authorityScore: 0.5 });
    const citations = buildCitations([e1, e2]);
    expect(citations[0]?.index).toBe(1);
    expect(citations[1]?.index).toBe(2);
  });

  it("lookupCitationIndex returns correct index", () => {
    const e = makeEvidence({ url: "https://example.com/page" });
    const citations = buildCitations([e]);
    const index = lookupCitationIndex(citations, e);
    expect(index).toBe(1);
  });

  it("lookupCitationIndex returns null for unknown evidence", () => {
    const e = makeEvidence({ url: "https://example.com/page" });
    const other = makeEvidence({ url: "https://other.com/page" });
    const citations = buildCitations([e]);
    const index = lookupCitationIndex(citations, other);
    expect(index).toBeNull();
  });

  it("citation URLs come only from Evidence.url", () => {
    const e = makeEvidence({ url: "https://real.example.com/page" });
    const citations = buildCitations([e]);
    expect(citations[0]?.url).toBe("https://real.example.com/page");
  });
});

// ---------------------------------------------------------------------------
// Selective Evidence Pruning
// ---------------------------------------------------------------------------

describe("pruneRedundantEvidence", () => {
  it("keeps array as-is when evidence count is <= 8", () => {
    const list = Array.from({ length: 6 }, (_, i) =>
      makeEvidence({ id: `e-${i}`, domain: "example.com", snippet: "$20/mo" })
    );
    const result = pruneRedundantEvidence(list);
    expect(result).toHaveLength(6);
  });

  it("prunes same-domain redundant pages with identical pricing values", () => {
    const list = [
      makeEvidence({ id: "sf-1", domain: "salesforce.com", snippet: "Sales Cloud is $25/mo" }),
      makeEvidence({ id: "sf-2", domain: "salesforce.com", snippet: "Pricing overview: $25/mo" }),
      makeEvidence({ id: "sf-3", domain: "salesforce.com", snippet: "Salesforce starter is $25/month" }),
      makeEvidence({ id: "sf-4", domain: "salesforce.com", snippet: "CRM editions start at $25/month" }),
      makeEvidence({ id: "hs-1", domain: "hubspot.com", snippet: "HubSpot Starter is $20/mo" }),
      makeEvidence({ id: "hs-2", domain: "hubspot.com", snippet: "HubSpot pricing: $20 per month" }),
      makeEvidence({ id: "hs-3", domain: "hubspot.com", snippet: "HubSpot CRM costs $20/month" }),
      makeEvidence({ id: "pd-1", domain: "pipedrive.com", snippet: "Pipedrive is $14/month" }),
      makeEvidence({ id: "pd-2", domain: "pipedrive.com", snippet: "Pipedrive pricing starts at $14/month" }),
      makeEvidence({ id: "news-1", domain: "techcrunch.com", snippet: "CRM pricing review 2026", sourceType: "news" })
    ];

    const pruned = pruneRedundantEvidence(list, { maxPerDomain: 2, maxTotal: 15 });
    // sf should have at most 2, hs at most 2, pd at most 2
    const sfCount = pruned.filter((e) => e.domain === "salesforce.com").length;
    expect(sfCount).toBeLessThanOrEqual(2);
    expect(pruned.length).toBeLessThan(list.length);
  });

  it("preserves genuinely conflicting or tiered credible sources from the same domain", () => {
    const list = [
      makeEvidence({ id: "hs-std", domain: "hubspot.com", snippet: "HubSpot Starter is $20/month", authorityScore: 1.0, sourceType: "official" }),
      makeEvidence({ id: "hs-dup", domain: "hubspot.com", snippet: "Pricing: $20/month", authorityScore: 0.9, sourceType: "official" }),
      makeEvidence({ id: "hs-startup", domain: "hubspot.com", snippet: "HubSpot for Startups is $0/month for eligible founders", authorityScore: 0.95, sourceType: "official" }),
      makeEvidence({ id: "hs-pro", domain: "hubspot.com", snippet: "HubSpot Professional costs $500/month", authorityScore: 0.9, sourceType: "official" }),
      makeEvidence({ id: "review", domain: "techcrunch.com", snippet: "HubSpot prices rising", authorityScore: 0.7, sourceType: "news" }),
      ...Array.from({ length: 6 }, (_, i) =>
        makeEvidence({ id: `other-${i}`, domain: `other${i}.com`, snippet: "General info" })
      )
    ];

    const pruned = pruneRedundantEvidence(list, { maxPerDomain: 2, maxTotal: 18 });
    const hsIds = pruned.filter((e) => e.domain === "hubspot.com").map((e) => e.id);

    // hs-std (standard pricing) and hs-startup / hs-pro (distinct pricing values) must be preserved
    expect(hsIds).toContain("hs-std");
    expect(hsIds.length).toBeGreaterThanOrEqual(2);
    // Duplicate identical price should be dropped
    expect(hsIds).not.toContain("hs-dup");
  });

  it("caps total results to maxTotal within the 8-20 range", () => {
    const list = Array.from({ length: 40 }, (_, i) =>
      makeEvidence({
        id: `ev-${i}`,
        domain: `domain${i % 15}.com`,
        snippet: `Tool ${i} is priced at $${(i + 1) * 5}/mo`
      })
    );

    const pruned = pruneRedundantEvidence(list, { maxTotal: 16 });
    expect(pruned.length).toBeLessThanOrEqual(16);
    expect(pruned.length).toBeGreaterThanOrEqual(8);
  });
});

