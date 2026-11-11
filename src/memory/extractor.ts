import type { HistoricalClaim } from "../types/index.js";
import { addClaim } from "./store.js";

export interface ClaimExtractionResult {
  claims: Array<{
    claim: string;
    entity?: string;
    topic?: string;
  }>;
}

export async function extractClaims(
  messageId: string,
  content: string,
  validAt: string
): Promise<HistoricalClaim[]> {
  /*
   * LLM-based extraction will be implemented later.
   *
   * This function intentionally remains asynchronous so
   * the caller can execute it in the background after
   * persisting the message.
   */

  void content;

  const result: ClaimExtractionResult = {
    claims: []
  };

  return result.claims.map((claim) =>
    addClaim({
      messageId,
      claim: claim.claim,
      validAt,
      entity: claim.entity,
      topic: claim.topic
    })
  );
}