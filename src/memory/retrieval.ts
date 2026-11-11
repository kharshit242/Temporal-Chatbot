import { db } from "./db.js";
import type {
  HistoricalClaim,
  Message
} from "../types/index.js";

export interface MessageSearchResult {
  message: Message;
  rank: number;
}

export function searchMessages(
  query: string,
  limit = 10
): MessageSearchResult[] {
  const rows = db.prepare(`
    SELECT
      m.id,
      m.conversation_id,
      m.role,
      m.content,
      m.created_at,
      bm25(messages_fts) AS rank
    FROM messages_fts
    JOIN messages m
      ON m.id = messages_fts.message_id
    WHERE messages_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit) as Array<{
    id: string;
    conversation_id: string;
    role: Message["role"];
    content: string;
    created_at: string;
    rank: number;
  }>;

  return rows.map((row) => ({
    message: {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at
    },
    rank: row.rank
  }));
}

export function getMessagesByDateRange(
  start: string,
  end: string
): Message[] {
  const rows = db.prepare(`
    SELECT
      id,
      conversation_id,
      role,
      content,
      created_at
    FROM messages
    WHERE created_at >= ?
      AND created_at < ?
    ORDER BY created_at ASC
  `).all(start, end) as Array<{
    id: string;
    conversation_id: string;
    role: Message["role"];
    content: string;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at
  }));
}

export function getClaimsByDateRange(
  start: string,
  end: string
): HistoricalClaim[] {
  const rows = db.prepare(`
    SELECT
      id,
      message_id,
      claim,
      valid_at,
      entity,
      topic
    FROM claims
    WHERE valid_at >= ?
      AND valid_at < ?
    ORDER BY valid_at ASC
  `).all(start, end) as Array<{
    id: string;
    message_id: string;
    claim: string;
    valid_at: string;
    entity: string | null;
    topic: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    messageId: row.message_id,
    claim: row.claim,
    validAt: row.valid_at,
    entity: row.entity ?? undefined,
    topic: row.topic ?? undefined
  }));
}