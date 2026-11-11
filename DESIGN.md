# Temporal Chatbot

## Core Idea

**Past conversation is historical evidence, not current truth.**

Traditional conversational agents either treat chat history as absolute current truth or ignore past discussions entirely. The Temporal Chatbot bridges conversational memory with current web verification: past statements stored in SQLite + FTS5 are treated as historical assertions whose validity must be verified against current web evidence before answering time-sensitive questions.

---

## Architecture

```text
User
 ↓
Temporal Resolver
 ↓
Query Router
 ↓
SQLite + FTS5
 ↓
NVIDIA Nemotron Planner — Hop #1
 ↓
Parallel Web Search (Tavily)
 ↓
Dedupe + Rank + Deep Read
 ↓
Evidence / Claim Comparison
 ↓
NVIDIA Nemotron Synthesizer — Hop #2
 ↓
Streaming Answer + Citations
```

*Note: Pure memory queries ("What did I ask you on November 3?") resolve deterministically and skip web search and planner hops entirely.*

---

## Temporal Memory

- **Source of Truth**: Raw conversation messages in SQLite (`messages` table indexed by `conversation_id` and `created_at`).
- **Semantic Retrieval**: SQLite FTS5 full-text search (`messages_fts`) indexed with `unicode61` tokenizer.
- **Deterministic Date Resolution**: Handled via `chrono-node` in UTC (`today`, `yesterday`, `November 3`, `last Tuesday`). The LLM never resolves dates.
- **Claims Index**: Historical claims stored in `claims` table serve as an index over past statements.

---

## Search & Evidence

- **Provider**: Tavily Search API (`POST https://api.tavily.com/search`) with moderate safe-search and domain filtering.
- **Parallel Concurrency**: Executed concurrently via `Promise.allSettled` to prevent one slow/failing query from failing the batch.
- **Normalization & Dedupe**: Strips tracking parameters (`utm_*`, `fbclid`), normalizes URLs, and merges duplicate evidence entries preserving richest metadata.
- **Ranking Strategy**: Deterministic composite scoring:
  $$\text{Score} = (\text{Authority} \times 0.45) + (\text{Freshness} \times 0.30) + (\text{Relevance} \times 0.20) + (\text{Completeness} \times 0.05)$$
  *(Authority: Official 1.0, Documentation 0.9, News 0.7, Community 0.45, Unknown 0.25)*
- **Selective Deep Reading**: Fetches full HTML only for high-value paths (`/pricing`, `/docs`, `/changelog`), capped at 80,000 characters with script/style stripping.

---

## Two-Hop LLM Design

- **Provider**: NVIDIA NIM (OpenAI-compatible API at `https://integrate.api.nvidia.com/v1`)
- **Model**: `nvidia/nemotron-3.5-super-vl-120b-a12b`
- **Architectural Invariant**: **Maximum two LLM calls per request**.

1. **Hop #1 — Planner (Structured Research Planning)**:
   - Receives: User query + resolved date + historical context from memory.
   - Invocation: Single NVIDIA Nemotron call (`enable_thinking = false`, JSON object mode, `temperature = 1.0`, `top_p = 0.95`).
   - Produces: Strictly typed JSON `SearchPlan` (search queries, targeted domains, claims to verify, deep-read flag).
   - Constraints: Never answers the user, never generates prose, never executes tools or web searches itself.
   - Fallback: On LLM failure or invalid JSON, falls back deterministically to keyword-derived queries.

2. **Hop #2 — Synthesizer (Evidence-Grounded Answer Synthesis)**:
   - Receives: Historical context + ranked current web evidence + claim comparisons + provenance map + current date.
   - Invocation: Single NVIDIA Nemotron streaming call (`temperature = 1.0`, `top_p = 0.95`).
   - Produces: User-facing final answer with inline citation tags (`[1]`, `[2]`).
   - Constraints: Streams `delta.content` via SSE; internal reasoning tokens are never exposed. Never calls tools, search, planner, or additional LLM hops.

**Important**: The LLM does NOT perform web search itself. Our application remains strictly and deterministically responsible for:
- Search execution & concurrency
- Deduplication & normalization
- Source ranking & authority heuristics
- Selective deep page reading
- Evidence structuring & claim comparison
- Citation & provenance mapping

**No autonomous ReAct loops. No recursive tool calling. No unbounded agent cycles.**

---

## Deterministic vs. LLM Responsibilities

| Responsibility | Handled By | Rationale |
| :--- | :--- | :--- |
| **Date & Time Resolution** | Deterministic (`chrono-node`) | Avoids hallucinated temporal offsets |
| **Routing Signals** | Deterministic Regex & Memory Check | Predictable transition between memory/web/verify |
| **Memory & FTS5 Retrieval** | Deterministic (SQLite) | Verifiable conversation retrieval |
| **Research Plan Generation** | LLM (Hop #1) | Semantic query generation & domain targeting |
| **Search Budget & Concurrency** | Deterministic (`Promise.allSettled`) | Guarantees bounded latency and costs |
| **URL Normalization & Dedupe** | Deterministic (URL & Set) | Prevents redundant search analysis |
| **Source Ranking** | Deterministic Heuristics | Transparent, reproducible source evaluation |
| **Claim Comparison** | Deterministic Comparator | Mathematical currency, number & status diffing |
| **Citation URL Resolution** | Deterministic Provenance Map | Prevents hallucinated citation links |
| **Metadata Calculation** | Deterministic Code | Verifiable latency, source counts, confidence |
| **Final Evidence Synthesis** | LLM (Hop #2) | Natural, coherent user-facing answer |

---

## Claim Verification

Claims are compared between historical state and current web evidence into six explicit states:

- `unchanged`: Current evidence strongly matches historical claims.
- `changed`: Current evidence clearly contradicts past values (e.g. price moved from \$20 to \$25).
- `new`: Statement introduced only in recent sources with no historical baseline.
- `removed`: Explicit evidence states item discontinued, deprecated, or removed.
- `uncertain`: Insufficient or ambiguous evidence. **Absence of evidence is never treated as removal.**
- `conflicting`: Multiple credible current sources disagree with each other.

---

## Performance / Budgets

- **Hard Search Timeout**: 4.5 seconds per query (enforced via `AbortController`).
- **Deep-Read Fetch Timeout**: 8.0 seconds per page (max 4 pages).
- **Frozen Search Query Budgets**:
  - `simple`: 4 queries
  - `comparison`: 8 queries
  - `temporalVerification`: 12 queries
  - `complexResearch`: 15 queries

---

## Failure Handling

- **Search Timeout / Failure**: Caught per-query; remaining settled queries proceed. If all fail, synthesizer explains lack of web evidence.
- **Missing Memory**: Transparent fallback informing the user that no historical record exists for that temporal range.
- **Invalid Planner JSON**: Safely falls back to deterministic keyword query generation without failing.
- **Missing Credentials**: Fails immediately with clear diagnostic guidance without leaking keys in error logs.

---

## Key Tradeoffs

1. **Two LLM Hops vs. Autonomous Loops**: Enforces predictable latency, zero runaway cost, and total unit testability at the cost of open-ended exploratory flexibility.
2. **SQLite + FTS5 vs. Vector DB**: Fully local, zero-dependency, deterministic indexing with no vector drift or cold-start indexing overhead, but lacks dense neural embeddings.
3. **Raw Messages as Source of Truth**: Ensures 100% conversational fidelity and reproducible debugging, while deferring complex real-time semantic entity extraction to background jobs.
4. **Bounded Search Budgets**: Protects external rate limits and bounding latency to ~4.5s, while intentionally trading off exhaustive web crawling.

