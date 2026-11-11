/**
 * src/config.ts
 *
 * Central configuration loader.
 * Reads from process.env (dotenv is loaded by the server entry point before anything imports this).
 * All other modules read from this single source of truth.
 */

export const Config = {
  nvidia: {
    /** NVIDIA API key — required for planner and synthesizer. */
    get apiKey(): string {
      return process.env.NVIDIA_API_KEY ?? process.env.LLM_API_KEY ?? "";
    },
    /** NVIDIA NIM model identifier. */
    get model(): string {
      return (
        process.env.NVIDIA_MODEL ??
        process.env.LLM_MODEL ??
        "nvidia/nemotron-3.5-super-vl-120b-a12b"
      );
    },
    /** OpenAI-compatible NVIDIA NIM endpoint. */
    get baseUrl(): string {
      return (
        process.env.NVIDIA_BASE_URL ??
        process.env.LLM_BASE_URL ??
        "https://integrate.api.nvidia.com/v1"
      );
    },
    /** Max tokens for planner output (JSON only, stays small). */
    plannerMaxTokens: 2048,
    /** Max tokens for synthesizer answer. */
    synthesizerMaxTokens: 4096,
    /** Timeout for planner call in ms (10-15s). */
    plannerTimeoutMs: 15_000,
    /** Timeout for synthesizer call in ms (20-30s). */
    synthesizerTimeoutMs: 30_000
  },

  /** Legacy / alias accessor mapped directly to Config.nvidia */
  llm: {
    get apiKey(): string {
      return Config.nvidia.apiKey;
    },
    get model(): string {
      return Config.nvidia.model;
    },
    get baseUrl(): string {
      return Config.nvidia.baseUrl;
    },
    get plannerMaxTokens(): number {
      return Config.nvidia.plannerMaxTokens;
    },
    get synthesizerMaxTokens(): number {
      return Config.nvidia.synthesizerMaxTokens;
    },
    get timeoutMs(): number {
      return Config.nvidia.synthesizerTimeoutMs;
    }
  },

  search: {
    /** Tavily API key (tvly-…). */
    get apiKey(): string {
      return process.env.SEARCH_API_KEY ?? "";
    }
  },

  db: {
    get path(): string {
      return process.env.DATABASE_PATH ?? "./data/memory.db";
    }
  },

  server: {
    get port(): number {
      return Number(process.env.PORT ?? "3000");
    }
  },

  /**
   * Search budgets per routing complexity.
   * The controller caps planner queries to these limits.
   */
  searchBudgets: {
    simple: 4,
    comparison: 8,
    temporalVerification: 12,
    complexResearch: 15
  } as const
} as const;
