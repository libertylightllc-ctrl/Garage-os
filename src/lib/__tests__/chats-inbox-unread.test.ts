/**
 * Chat inbox unread badge + WhatsAppThread.lastReadAt semantics
 * (AR 2026-08-21 Batch 2).
 *
 * The inbox counts inbound messages with createdAt > lastReadAt
 * per thread. A null lastReadAt means "never opened" — every past
 * inbound reads as unread.
 *
 * Not testing the page render itself here (server component with
 * getT + AppNav needs a heavier harness); testing the DB shape
 * that the render depends on:
 *   A) A thread with lastReadAt=null: N inbound messages → count N.
 *   B) A thread with lastReadAt set to a past time: count only
 *      messages created after that time.
 *   C) Outbound (direction=OUT) messages never count.
 *   D) Multiple threads: per-thread count doesn't cross-contaminate.
 *
 * Also asserts the schema field exists (the migration landed on
 * this DB) — a bare `select: { lastReadAt: true }` would throw if
 * the column wasn't there.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";

const P = "chats-unread-test-";
const gid = P + "g1";

async function cleanup() {
  await prisma.whatsAppMessage.deleteMany({ where: { thread: { garageId: gid } } });
  await prisma.whatsAppThread.deleteMany({ where: { garageId: gid } });
  await prisma.customer.deleteMany({ where: { garageId: gid } });
  await prisma.garage.deleteMany({ where: { id: gid } });
}

beforeEach(async () => {
  await cleanup();
  await prisma.garage.create({ data: { id: gid, name: gid } });
});
afterAll(cleanup);

async function seedThread(opts: { lastReadAt: Date | null; waId: string }) {
  const customer = await prisma.customer.create({
    data: { garageId: gid, name: "C", phone: opts.waId, waId: opts.waId },
  });
  return prisma.whatsAppThread.create({
    data: {
      garageId: gid,
      customerId: customer.id,
      waId: opts.waId,
      lastReadAt: opts.lastReadAt,
    },
  });
}
async function seedMessage(threadId: string, direction: "IN" | "OUT", createdAt: Date, body: string) {
  return prisma.whatsAppMessage.create({
    data: {
      threadId, direction, body, createdAt,
      waMessageId: `wa-${direction}-${Math.random().toString(36).slice(2, 10)}`,
    },
  });
}

const t = (offsetMin: number) => new Date(Date.now() + offsetMin * 60_000);

describe("WhatsAppThread.lastReadAt — unread semantics", () => {
  it("A) null lastReadAt — every past inbound counts as unread", async () => {
    const th = await seedThread({ lastReadAt: null, waId: "971501111111" });
    await seedMessage(th.id, "IN", t(-30), "one");
    await seedMessage(th.id, "IN", t(-20), "two");
    await seedMessage(th.id, "IN", t(-10), "three");

    // Same query the inbox uses: count inbound messages that are
    // newer than lastReadAt (or all inbound if lastReadAt is null).
    const count = await prisma.whatsAppMessage.count({
      where: {
        threadId: th.id,
        direction: "IN",
        ...(th.lastReadAt ? { createdAt: { gt: th.lastReadAt } } : {}),
      },
    });
    expect(count).toBe(3);
  });

  it("B) lastReadAt in the past — only messages after count", async () => {
    const readAt = t(-15);
    const th = await seedThread({ lastReadAt: readAt, waId: "971501111112" });
    await seedMessage(th.id, "IN", t(-30), "before");
    await seedMessage(th.id, "IN", t(-20), "still before");
    await seedMessage(th.id, "IN", t(-10), "after — unread");
    await seedMessage(th.id, "IN", t(-5), "after — unread");

    const count = await prisma.whatsAppMessage.count({
      where: { threadId: th.id, direction: "IN", createdAt: { gt: readAt } },
    });
    expect(count).toBe(2);
  });

  it("C) outbound messages never count as unread", async () => {
    const th = await seedThread({ lastReadAt: null, waId: "971501111113" });
    await seedMessage(th.id, "OUT", t(-20), "advisor reply 1");
    await seedMessage(th.id, "OUT", t(-10), "advisor reply 2");
    await seedMessage(th.id, "IN", t(-5), "customer reply");

    const count = await prisma.whatsAppMessage.count({
      where: { threadId: th.id, direction: "IN" },
    });
    expect(count).toBe(1);
  });

  it("D) two threads — per-thread counts don't cross-contaminate", async () => {
    const a = await seedThread({ lastReadAt: null, waId: "971501111114" });
    const b = await seedThread({ lastReadAt: null, waId: "971501111115" });
    await seedMessage(a.id, "IN", t(-10), "for a");
    await seedMessage(a.id, "IN", t(-5), "for a");
    await seedMessage(b.id, "IN", t(-2), "for b");

    const aCount = await prisma.whatsAppMessage.count({
      where: { threadId: a.id, direction: "IN" },
    });
    const bCount = await prisma.whatsAppMessage.count({
      where: { threadId: b.id, direction: "IN" },
    });
    expect(aCount).toBe(2);
    expect(bCount).toBe(1);
  });

  it("stamping lastReadAt=now zeroes the unread count on next check", async () => {
    const th = await seedThread({ lastReadAt: null, waId: "971501111116" });
    await seedMessage(th.id, "IN", t(-30), "one");
    await seedMessage(th.id, "IN", t(-20), "two");

    // Advisor opens the thread → stamp.
    const now = new Date();
    await prisma.whatsAppThread.update({
      where: { id: th.id }, data: { lastReadAt: now },
    });

    const count = await prisma.whatsAppMessage.count({
      where: { threadId: th.id, direction: "IN", createdAt: { gt: now } },
    });
    expect(count).toBe(0);
  });
});
