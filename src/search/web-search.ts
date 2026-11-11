/**
 * web-search.ts
 *
 * Parallel web search layer backed by the Tavily Search API.
 *
 * Responsibilities:
 *  1. Accept multiple SearchQuery objects.
 *  2. Execute all searches concurrently with Promise.allSettled.
 *  3. Apply a hard timeout per query via AbortController.
 *  4. Normalize Tavily responses into the project's Evidence type.
 *  5. Never expose API keys in logs or error messages.
 *  6. Never call the LLM.
 *
 * Required environment variable:
 *   SEARCH_API_KEY  — your Tavily API key (tvly-…)
 */

import { randomUUID } from "node:crypto";
import type { Evidence, SearchQuery } from "../types/index.js";
import { classifySourceType, computeAuthorityScore } from "./ranker.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WebSearchInput {
  queries: SearchQuery[];
  /** Hard cap on the number of results returned per query (default 10). */
  maxResults?: number;
}

/** Raw result as returned by the Tavily API before normalization. */
interface RawSearchResult {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Hard timeout per search request in milliseconds. */
const SEARCH_TIMEOUT_MS = 4_500;

/** Default maximum results per query (Tavily max is 20). */
const DEFAULT_MAX_RESULTS = 8;

/** Tavily Search API endpoint. */
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

// ---------------------------------------------------------------------------
// Provider: Tavily Search
// ---------------------------------------------------------------------------

/**
 * Tavily API request body shape.
 * Only the fields we actually send are typed here.
 */
interface TavilyRequest {
  query: string;
  max_results: number;
  search_depth: "basic" | "advanced";
  include_answer: boolean;
  include_domains?: string[];
}

/**
 * Tavily API response shape (partial — only fields we consume).
 */
interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
}

interface TavilyResponse {
  results: TavilyResult[];
  answer?: string;
}

/**
 * Execute a single query against the Tavily Search API.
 * Returns an array of raw results, or throws on failure.
 *
 * The API key is passed in the JSON body and is intentionally never logged.
 */
async function executeTavilySearch(
  query: SearchQuery,
  maxResults: number,
  apiKey: string,
  signal: AbortSignal
): Promise<RawSearchResult[]> {
  const body: TavilyRequest & { api_key: string } = {
    api_key: apiKey,
    query: query.query,
    max_results: Math.min(maxResults, 20),
    search_depth: "basic",
    include_answer: false
  };

  if (query.domains && query.domains.length > 0) {
    body.include_domains = query.domains;
  }

  const response = await fetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    // Do NOT include the API key in error messages
    throw new Error(
      `Tavily returned ${response.status}: ${response.statusText}`
    );
  }

  const data = (await response.json()) as TavilyResponse;
  const results: TavilyResult[] = data.results ?? [];

  return results.map((item) => ({
    title: item.title ?? "",
    url: item.url ?? "",
    // Tavily's `content` field is a rich snippet — use it as our snippet
    snippet: item.content ? String(item.content) : undefined,
    publishedAt: item.published_date
      ? tryParseDate(item.published_date)
      : undefined
  }));
}

/** Attempt to parse a date string into ISO 8601. Returns undefined on failure. */
function tryParseDate(raw: string): string | undefined {
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return undefined;
    return d.toISOString();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Derive the domain from a URL string.
 * Returns an empty string when the URL is malformed.
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Convert a raw provider result into the project's Evidence type.
 */
function normalizeResult(raw: RawSearchResult): Evidence {
  const domain = extractDomain(raw.url);
  const sourceType = classifySourceType(domain);
  const authorityScore = computeAuthorityScore(sourceType);

  return {
    id: randomUUID(),
    title: raw.title,
    url: raw.url,
    domain,
    snippet: raw.snippet,
    content: undefined,
    publishedAt: raw.publishedAt,
    retrievedAt: new Date().toISOString(),
    authorityScore,
    sourceType
  };
}

// ---------------------------------------------------------------------------
// Core search executor
// ---------------------------------------------------------------------------

/**
 * Execute one query with timeout handling.
 * Returns Evidence[] on success, or null on failure.
 */
async function executeQuery(
  query: SearchQuery,
  maxResults: number,
  apiKey: string
): Promise<Evidence[]> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    SEARCH_TIMEOUT_MS
  );

  try {
    const raw = await executeTavilySearch(
      query,
      maxResults,
      apiKey,
      controller.signal
    );
    return raw.map(normalizeResult);
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "AbortError" ||
        err.message.includes("abort"));

    if (isTimeout) {
      // Log without key details
      console.warn(
        `[web-search] Query timed out after ${SEARCH_TIMEOUT_MS}ms:`,
        query.query
      );
    } else {
      console.warn(
        "[web-search] Query failed:",
        query.query,
        (err instanceof Error ? err.message : String(err))
      );
    }
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute multiple search queries in parallel and return normalized Evidence.
 *
 * Provider: Tavily Search API (https://tavily.com)
 * - Queries run concurrently via Promise.allSettled.
 * - Each query has a hard timeout of ~4.5 s.
 * - A failed query does not affect other queries.
 * - Requires SEARCH_API_KEY environment variable (Tavily key: tvly-…).
 */
export async function webSearch(
  input: WebSearchInput
): Promise<Evidence[]> {
  const apiKey = process.env.SEARCH_API_KEY;

  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "SEARCH_API_KEY is missing. " +
        "Set the environment variable before running web search."
    );
  }

  const queries = input.queries;
  const defaultMax =
    queries.length >= 4 ? 5 : queries.length >= 2 ? 6 : DEFAULT_MAX_RESULTS;
  const maxResults = input.maxResults ?? defaultMax;

  if (queries.length === 0) {
    return [];
  }

  const settled = await Promise.allSettled(
    queries.map((q) => executeQuery(q, maxResults, apiKey))
  );

  const results: Evidence[] = [];

  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      results.push(...outcome.value);
    }
    // Rejected outcomes are already logged inside executeQuery.
  }

  return results;
}

