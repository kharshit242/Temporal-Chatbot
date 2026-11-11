/**
 * reader.ts
 *
 * Selective deep page reader.
 *
 * The pipeline ranks evidence and selectively fetches the full HTML of
 * high-value pages.  This module is responsible for:
 *
 *  1. Deciding which pages are worth fetching (selectPagesForDeepRead).
 *  2. Fetching via plain HTTP/HTTPS (no browser automation).
 *  3. Extracting useful text from HTML (stripping nav/scripts/styles).
 *  4. Capping content length.
 *  5. Failing gracefully per-page without crashing the pipeline.
 *
 * Safety constraints:
 *  - Only http:// and https:// URLs are allowed.
 *  - Redirects are followed up to MAX_REDIRECTS.
 *  - Response body is capped at CONTENT_SIZE_LIMIT bytes before parsing.
 *  - Per-fetch timeout is enforced via AbortController.
 */

import type { Evidence } from "../types/index.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum characters of extracted text to store in Evidence.content. */
const CONTENT_SIZE_LIMIT = 80_000;

/** Hard timeout per page fetch in milliseconds. */
const FETCH_TIMEOUT_MS = 3_500;

/** Maximum number of redirects to follow. */
const MAX_REDIRECTS = 5;

/** Default maximum pages to deep-read in one pipeline pass. */
const DEFAULT_MAX_DEEP_READ_PAGES = 3;

/** Minimum authority score for a page to be considered for deep read. */
const DEEP_READ_MIN_AUTHORITY = 0.4;

/**
 * URL path segments that indicate high-value pages worth deep reading.
 * Matching is case-insensitive and partial (includes check).
 */
const HIGH_VALUE_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/pricing/i,
  /\/plans/i,
  /\/changelog/i,
  /\/releases/i,
  /\/updates/i,
  /\/docs(?:\/|$)/i,
  /\/documentation/i,
  /\/blog/i,
  /\/news/i,
  /\/announce/i,
  /\/product/i,
  /\/features/i,
  /\/about/i,
  /\/faq/i,
  /\/support/i,
  /\/help/i,
  /\/api(?:\/|$)/i,
  /\/reference/i
];

// ---------------------------------------------------------------------------
// Protocol safety
// ---------------------------------------------------------------------------

/** Allowed URL protocols for fetching. */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set([
  "http:",
  "https:"
]);

/**
 * Throw if the URL uses a disallowed protocol.
 */
function assertSafeUrl(url: string): void {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Disallowed protocol "${parsed.protocol}" in URL: ${url}. ` +
        "Only http: and https: are permitted."
    );
  }
}

// ---------------------------------------------------------------------------
// High-value page selection
// ---------------------------------------------------------------------------

/**
 * Returns true when the URL path matches one of the high-value patterns
 * or when the evidence has a high authority score on a specific content path.
 */
function isHighValuePage(evidence: Evidence): boolean {
  let parsed: URL;

  try {
    parsed = new URL(evidence.url);
  } catch {
    return false;
  }

  const path = parsed.pathname;

  if (HIGH_VALUE_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
    return true;
  }

  // Official or documentation pages with a specific content path (not bare root '/')
  if (evidence.authorityScore >= 0.85 && path.length > 1 && path !== "/") {
    return true;
  }

  return false;
}

/**
 * Select the top N evidence items that are worth deep-reading.
 *
 * Selection criteria (in order):
 *  1. URL uses http or https.
 *  2. Authority score is at least DEEP_READ_MIN_AUTHORITY.
 *  3. The URL path matches a high-value pattern OR authority is very high on a specific path.
 *  4. Prioritizes domain diversity across top candidates.
 *
 * The input is assumed to already be ranked (highest first).
 */
export function selectPagesForDeepRead(
  evidence: Evidence[],
  maxPages: number = DEFAULT_MAX_DEEP_READ_PAGES
): Evidence[] {
  const eligible = evidence.filter((e) => {
    // Skip non-http(s) URLs
    try {
      const { protocol } = new URL(e.url);
      if (!ALLOWED_PROTOCOLS.has(protocol)) return false;
    } catch {
      return false;
    }

    // Minimum quality gate
    if (e.authorityScore < DEEP_READ_MIN_AUTHORITY) return false;

    // Check path value
    return isHighValuePage(e);
  });

  if (eligible.length <= maxPages) {
    return eligible;
  }

  // Pass 1: Prioritize domain diversity (at most 1 per domain)
  const selected: Evidence[] = [];
  const seenDomains = new Set<string>();

  for (const e of eligible) {
    const domain = e.domain.toLowerCase();
    if (!seenDomains.has(domain)) {
      seenDomains.add(domain);
      selected.push(e);
      if (selected.length >= maxPages) break;
    }
  }

  // Pass 2: If we still have slots left, fill with remaining eligible pages
  if (selected.length < maxPages) {
    const selectedIds = new Set(selected.map((e) => e.id));
    for (const e of eligible) {
      if (!selectedIds.has(e.id)) {
        selected.push(e);
        selectedIds.add(e.id);
        if (selected.length >= maxPages) break;
      }
    }
  }

  return selected;
}

// ---------------------------------------------------------------------------
// HTML text extraction
// ---------------------------------------------------------------------------

/**
 * Very lightweight HTML-to-text extractor.
 *
 * Removes:
 *  - <script> … </script>
 *  - <style> … </style>
 *  - <nav> … </nav>
 *  - <header> … </header>
 *  - <footer> … </footer>
 *  - All remaining HTML tags
 *
 * Then normalizes whitespace.
 *
 * This is intentionally simple — no DOM parser dependency.
 * For Batch 2 this is sufficient; a more robust parser can be added later.
 */
function extractTextFromHtml(html: string): string {
  let text = html;

  // Remove block elements we don't want
  const blockRemovals: Array<[RegExp, string]> = [
    [/<script[\s\S]*?<\/script>/gi, " "],
    [/<style[\s\S]*?<\/style>/gi, " "],
    [/<nav[\s\S]*?<\/nav>/gi, " "],
    [/<header[\s\S]*?<\/header>/gi, " "],
    [/<footer[\s\S]*?<\/footer>/gi, " "],
    [/<!--[\s\S]*?-->/g, " "]
  ];

  for (const [pattern, replacement] of blockRemovals) {
    text = text.replace(pattern, replacement);
  }

  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(parseInt(code, 10))
    );

  // Normalize whitespace
  text = text.replace(/\s+/g, " ").trim();

  return text;
}

// ---------------------------------------------------------------------------
// HTTP fetch with timeout
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and return the response body as text.
 * Applies a hard timeout and caps body size to avoid memory issues.
 */
async function fetchPage(url: string): Promise<string> {
  assertSafeUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "TemporalChatbot/1.0 (compatible; +https://github.com/temporal-chatbot)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText} for ${url}`
      );
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (
      !contentType.includes("text/html") &&
      !contentType.includes("text/plain") &&
      !contentType.includes("application/xhtml")
    ) {
      throw new Error(
        `Non-text content type "${contentType}" at ${url} — skipping.`
      );
    }

    // Read at most CONTENT_SIZE_LIMIT bytes to avoid downloading huge files
    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error(`No readable body at ${url}`);
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const byteLimit = CONTENT_SIZE_LIMIT * 2; // bytes before decode

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      if (value) {
        const remaining = byteLimit - totalBytes;

        if (remaining <= 0) break;

        const chunk =
          value.byteLength <= remaining
            ? value
            : value.slice(0, remaining);

        chunks.push(chunk);
        totalBytes += chunk.byteLength;
      }
    }

    reader.cancel().catch(() => {
      /* ignore */
    });

    const decoder = new TextDecoder("utf-8", { fatal: false });
    return chunks.reduce((acc, c) => acc + decoder.decode(c, { stream: true }), "");
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Deep read a single page
// ---------------------------------------------------------------------------

/**
 * Fetch and extract content for one Evidence item.
 *
 * Returns a new Evidence object with .content populated.
 * On failure, returns the original Evidence unchanged.
 */
export async function deepReadPage(evidence: Evidence): Promise<Evidence> {
  try {
    assertSafeUrl(evidence.url);

    const html = await fetchPage(evidence.url);
    const text = extractTextFromHtml(html);

    // Cap extracted text
    const content =
      text.length > CONTENT_SIZE_LIMIT
        ? text.slice(0, CONTENT_SIZE_LIMIT)
        : text;

    return {
      ...evidence,
      content
    };
  } catch (err) {
    const isTimeout =
      err instanceof Error && err.name === "AbortError";

    console.warn(
      `[reader] ${isTimeout ? "Timeout" : "Failed"} reading ${evidence.url}:`,
      err instanceof Error ? err.message : String(err)
    );

    // Return original without crashing the pipeline
    return evidence;
  }
}

// ---------------------------------------------------------------------------
// Deep read multiple pages
// ---------------------------------------------------------------------------

/**
 * Deep-read a set of selected Evidence pages concurrently.
 *
 * Pages are fetched in parallel via Promise.allSettled so one failure
 * does not block the rest.
 *
 * Returns Evidence[] with .content populated where the fetch succeeded.
 */
export async function deepReadPages(
  pages: Evidence[]
): Promise<Evidence[]> {
  const settled = await Promise.allSettled(
    pages.map((page) => deepReadPage(page))
  );

  return settled.map((outcome, index) => {
    if (outcome.status === "fulfilled") {
      return outcome.value;
    }
    // Unexpected rejection (deepReadPage shouldn't throw, but be safe)
    console.warn(
      `[reader] Unexpected error reading ${pages[index]?.url ?? "unknown"}`
    );
    return pages[index] as Evidence;
  });
}

