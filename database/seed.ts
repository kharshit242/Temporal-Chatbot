/**
 * database/seed.ts
 *
 * Deterministic seed script for development and benchmark verification.
 * Run with: npm run seed
 *
 * Scenarios:
 *   A) 2026-11-03: CRM tools & pricing shortlist
 *   B) 2026-11-04: Postgres hosting comparison (Supabase Pro $20/mo, Railway $5/mo)
 *   C) 2026-11-03: General historical question about databases
 *
 * Properties:
 *   - 100% deterministic: fixed IDs, fixed ISO timestamps
 *   - Safe to run repeatedly (uses SQLite ON CONFLICT upsert)
 *   - Never leaks secrets or credentials
 */

import { db } from "../src/memory/db.js";

interface SeedConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface SeedMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface SeedClaim {
  id: string;
  messageId: string;
  claim: string;
  validAt: string;
  entity?: string;
  topic?: string;
}

const CONVERSATIONS: SeedConversation[] = [
  {
    id: "seed-conversation-crm",
    title: "CRM Shortlist & Pricing",
    createdAt: "2026-11-03T10:00:00.000Z",
    updatedAt: "2026-11-03T10:01:00.000Z"
  },
  {
    id: "seed-conversation-postgres",
    title: "Postgres Hosting Options",
    createdAt: "2026-11-04T14:00:00.000Z",
    updatedAt: "2026-11-04T14:01:00.000Z"
  },
  {
    id: "seed-conversation-general",
    title: "General Database Discussion",
    createdAt: "2026-11-03T16:00:00.000Z",
    updatedAt: "2026-11-03T16:01:00.000Z"
  }
];

const MESSAGES: SeedMessage[] = [
  // Scenario A: CRM Pricing (2026-11-03)
  {
    id: "seed-message-crm-user",
    conversationId: "seed-conversation-crm",
    role: "user",
    content: "On Monday we shortlisted HubSpot, Pipedrive, Zoho CRM, Salesforce and Freshsales for a 20-person sales team.",
    createdAt: "2026-11-03T10:00:00.000Z"
  },
  {
    id: "seed-message-crm-assistant",
    conversationId: "seed-conversation-crm",
    role: "assistant",
    content: "For a 20-person team, the shortlist is:\n- HubSpot\n- Pipedrive\n- Zoho CRM\n- Salesforce\n- Freshsales\n\nAt the time, the pricing information discussed was based on the sources available on November 3, 2026. HubSpot Starter was around $20/month per user.",
    createdAt: "2026-11-03T10:01:00.000Z"
  },

  // Scenario B: Postgres Hosting (2026-11-04)
  {
    id: "seed-message-postgres-user",
    conversationId: "seed-conversation-postgres",
    role: "user",
    content: "I was comparing Postgres hosting options yesterday.",
    createdAt: "2026-11-04T14:00:00.000Z"
  },
  {
    id: "seed-message-postgres-assistant",
    conversationId: "seed-conversation-postgres",
    role: "assistant",
    content: "We discussed Neon, Supabase and Railway. For pricing: Supabase Pro costs $20/month with 8 GB storage, Neon provides serverless compute with scaling to zero, and Railway starts at $5/month.",
    createdAt: "2026-11-04T14:01:00.000Z"
  },

  // Scenario C: General Historical (2026-11-03)
  {
    id: "seed-message-general-user",
    conversationId: "seed-conversation-general",
    role: "user",
    content: "What did I ask you about databases?",
    createdAt: "2026-11-03T16:00:00.000Z"
  },
  {
    id: "seed-message-general-assistant",
    conversationId: "seed-conversation-general",
    role: "assistant",
    content: "You asked about Postgres hosting and database pricing.",
    createdAt: "2026-11-03T16:01:00.000Z"
  }
];

const CLAIMS: SeedClaim[] = [
  {
    id: "seed-claim-crm-shortlist",
    messageId: "seed-message-crm-user",
    claim: "On Monday we shortlisted HubSpot, Pipedrive, Zoho CRM, Salesforce and Freshsales for a 20-person sales team.",
    validAt: "2026-11-03T00:00:00.000Z",
    entity: "CRM",
    topic: "shortlist"
  },
  {
    id: "seed-claim-hubspot-price",
    messageId: "seed-message-crm-assistant",
    claim: "HubSpot Starter costs $20/month.",
    validAt: "2026-11-03T00:00:00.000Z",
    entity: "HubSpot",
    topic: "pricing"
  },
  {
    id: "seed-claim-supabase-price",
    messageId: "seed-message-postgres-assistant",
    claim: "Supabase Pro costs $20/month.",
    validAt: "2026-11-04T00:00:00.000Z",
    entity: "Supabase",
    topic: "pricing"
  },
  {
    id: "seed-claim-railway-price",
    messageId: "seed-message-postgres-assistant",
    claim: "Railway starts at $5/month.",
    validAt: "2026-11-04T00:00:00.000Z",
    entity: "Railway",
    topic: "pricing"
  },
  {
    id: "seed-claim-db-inquiry",
    messageId: "seed-message-general-assistant",
    claim: "You asked about Postgres hosting and database pricing.",
    validAt: "2026-11-03T00:00:00.000Z",
    entity: "databases",
    topic: "inquiry"
  }
];

export function seedDatabase(): void {
  console.log("Seeding development database...\n");

  const upsertConvo = db.prepare(`
    INSERT INTO conversations (id, created_at, updated_at, title)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = excluded.updated_at,
      title = excluded.title
  `);

  const upsertMsg = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      created_at = excluded.created_at
  `);

  const deleteFts = db.prepare(`
    DELETE FROM messages_fts WHERE message_id = ?
  `);

  const insertFts = db.prepare(`
    INSERT INTO messages_fts (message_id, content)
    VALUES (?, ?)
  `);

  const upsertClaim = db.prepare(`
    INSERT INTO claims (id, message_id, claim, valid_at, entity, topic)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      claim = excluded.claim,
      valid_at = excluded.valid_at,
      entity = excluded.entity,
      topic = excluded.topic
  `);

  // Run in a transaction for atomicity and speed
  db.transaction(() => {
    for (const c of CONVERSATIONS) {
      upsertConvo.run(c.id, c.createdAt, c.updatedAt, c.title);
    }

    for (const m of MESSAGES) {
      upsertMsg.run(m.id, m.conversationId, m.role, m.content, m.createdAt);
      deleteFts.run(m.id);
      insertFts.run(m.id, m.content);
    }

    for (const cl of CLAIMS) {
      upsertClaim.run(cl.id, cl.messageId, cl.claim, cl.validAt, cl.entity ?? null, cl.topic ?? null);
    }
  })();

  console.log("✓ CRM pricing conversation (2026-11-03)");
  console.log("✓ Postgres hosting conversation (2026-11-04)");
  console.log("✓ Historical database conversation (2026-11-03)");
  console.log("\nSeed complete.");
}

// Auto-run when executed directly via CLI
if (process.argv[1]?.replace(/\\/g, "/").endsWith("database/seed.ts") || process.argv[1]?.replace(/\\/g, "/").endsWith("database/seed.js")) {
  seedDatabase();
}

