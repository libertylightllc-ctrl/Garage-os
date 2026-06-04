import { describe, it, expect } from "vitest";
import { classifyConversation, holdingReply, autoReply } from "./receptionist";

describe("receptionist routing (propose / confirm / handoff)", () => {
  it("AUTO for routine: status, hours, booking, invoice", () => {
    expect(classifyConversation("is my car ready?")).toEqual({ route: "AUTO", intent: "STATUS" });
    expect(classifyConversation("what are your opening hours?").route).toBe("AUTO");
    expect(classifyConversation("I want to book a service").route).toBe("AUTO");
    expect(classifyConversation("can you send my invoice?").intent).toBe("INVOICE");
  });

  it("PROPOSE (never auto-commit) for price / quote / diagnosis / deadline", () => {
    expect(classifyConversation("how much will it cost?").route).toBe("PROPOSE");
    expect(classifyConversation("can I get a quote?").route).toBe("PROPOSE");
    expect(classifyConversation("when will it be ready?")).toEqual({
      route: "PROPOSE",
      intent: "DEADLINE",
    });
    expect(classifyConversation("what's wrong with my engine?").route).toBe("PROPOSE");
  });

  it("HANDOFF for frustration / out-of-scope", () => {
    expect(classifyConversation("this is terrible, I want a refund").route).toBe("HANDOFF");
    expect(classifyConversation("let me speak to a human").route).toBe("HANDOFF");
    expect(classifyConversation("do you sell ice cream?").route).toBe("HANDOFF");
  });

  it("handles Arabic", () => {
    expect(classifyConversation("هل سيارتي جاهزة؟").route).toBe("AUTO");
    expect(classifyConversation("كم سعر التصليح؟").route).toBe("PROPOSE");
    expect(classifyConversation("أريد التحدث مع مدير").route).toBe("HANDOFF");
  });

  it("replies in Hindi/Urdu, falling back to English", () => {
    expect(holdingReply("hi")).toMatch(/[ऀ-ॿ]/); // Devanagari
    expect(holdingReply("ur")).not.toBe(holdingReply("en"));
    expect(autoReply("HOURS", "hi", {})).toMatch(/[ऀ-ॿ]/);
    expect(autoReply("HOURS", "en", {})).toContain("Sat");
  });
});
