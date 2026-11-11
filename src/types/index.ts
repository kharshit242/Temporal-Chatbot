export type MessageRole = "user" | "assistant" | "system";

export type ClaimStatus =
  | "unchanged"
  | "changed"
  | "new"
  | "removed"
  | "uncertain"
  | "conflicting";

export type AgentMode =
  | "memory"
  | "web"
  | "verify";

export interface SearchQuery {
  query: string;
  domains?: string[];
}

export interface ClaimToVerify {
  entity: string;
  claim: string;
}

export interface SearchPlan {
  mode: AgentMode;
  searchQueries: SearchQuery[];
  claimsToVerify: ClaimToVerify[];
  needsDeepRead: boolean;
}

export interface Evidence {
  id: string;
  title: string;
  url: string;
  domain: string;
  snippet?: string;
  content?: string;
  publishedAt?: string;
  retrievedAt: string;
  authorityScore: number;
  sourceType:
    | "official"
    | "documentation"
    | "news"
    | "community"
    | "unknown";
}

export interface Conversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface HistoricalClaim {
  id: string;
  messageId: string;
  claim: string;
  validAt: string;
  entity?: string;
  topic?: string;
}

export interface Source {
  id: string;
  messageId: string;
  url: string;
  title?: string;
  domain?: string;
  retrievedAt: string;
  publishedAt?: string;
}

export interface ClaimComparison {
  claim: string;

  historical: {
    value: string;
    date: string;
    sources: Source[];
  };

  current: {
    value: string;
    date: string;
    sources: Evidence[];
  };

  status: ClaimStatus;
}

export interface AnswerMetadata {
  usedMemory: boolean;
  historicalDate?: string;
  claimsRetrieved: number;
  claimsVerified: number;
  sourcesUsed: number;
  officialSources: number;
  conflicts: number;
  confidence: "high" | "medium" | "low";
  latencyMs: number;
}