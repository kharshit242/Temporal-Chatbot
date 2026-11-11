import { describe, expect, it } from "vitest";

import {
  createConversation,
  addMessage
} from "../src/memory/store.js";

import {
  getMessagesByDateRange,
  searchMessages
} from "../src/memory/retrieval.js";

describe("SQLite memory", () => {
  it("creates a conversation and stores messages", () => {
    const conversation =
      createConversation("Test conversation");

    const message = addMessage(
      conversation.id,
      "user",
      "We discussed Postgres hosting pricing."
    );

    expect(message.content).toContain(
      "Postgres"
    );
  });

  it("retrieves messages by date", () => {
    const conversation =
      createConversation("Date test");

    addMessage(
      conversation.id,
      "user",
      "We discussed CRM tools."
    );

    const messages =
      getMessagesByDateRange(
        "2020-01-01T00:00:00.000Z",
        "2030-01-01T00:00:00.000Z"
      );

    expect(messages.length).toBeGreaterThan(0);
  });

  it("supports FTS5 retrieval", () => {
    const conversation =
      createConversation("FTS test");

    addMessage(
      conversation.id,
      "user",
      "Supabase pricing is important."
    );

    const results =
      searchMessages("Supabase pricing");

    expect(results.length).toBeGreaterThan(0);
  });
});