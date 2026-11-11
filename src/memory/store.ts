import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import type {
  Conversation,
  HistoricalClaim,
  Message,
  MessageRole,
  Source
} from "../types/index.js";

export function createConversation(
  title?: string
): Conversation {
  const now = new Date().toISOString();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO conversations (
      id,
      created_at,
      updated_at,
      title
    )
    VALUES (?, ?, ?, ?)
  `).run(id, now, now, title ?? null);

  return {
    id,
    createdAt: now,
    updatedAt: now,
    title
  };
}

export function addMessage(
  conversationId: string,
  role: MessageRole,
  content: string
): Message {
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO messages (
      id,
      conversation_id,
      role,
      content,
      created_at
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    conversationId,
    role,
    content,
    now
  );

  db.prepare(`
    UPDATE conversations
    SET updated_at = ?
    WHERE id = ?
  `).run(now, conversationId);

  db.prepare(`
    INSERT INTO messages_fts (
      message_id,
      content
    )
    VALUES (?, ?)
  `).run(id, content);

  return {
    id,
    conversationId,
    role,
    content,
    createdAt: now
  };
}

export function addClaim(
  claim: Omit<HistoricalClaim, "id">
): HistoricalClaim {
  const id = randomUUID();

  db.prepare(`
    INSERT INTO claims (
      id,
      message_id,
      claim,
      valid_at,
      entity,
      topic
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    claim.messageId,
    claim.claim,
    claim.validAt,
    claim.entity ?? null,
    claim.topic ?? null
  );

  return {
    id,
    ...claim
  };
}

export function addSource(
  source: Omit<Source, "id">
): Source {
  const id = randomUUID();

  db.prepare(`
    INSERT INTO sources (
      id,
      message_id,
      url,
      title,
      domain,
      retrieved_at,
      published_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    source.messageId,
    source.url,
    source.title ?? null,
    source.domain ?? null,
    source.retrievedAt,
    source.publishedAt ?? null
  );

  return {
    id,
    ...source
  };
}