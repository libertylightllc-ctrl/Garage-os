import { describe, it, expect } from "vitest";
import {
  mockMoulkia,
  parseMoulkiaJson,
  ocrCostUsd,
  extractMoulkia,
  isEmptyExtraction,
  OCR_PRIMARY,
  OCR_FALLBACK,
} from "./ocr";

describe("Moulkia OCR — pure helpers", () => {
  it("mock returns a complete UAE-style record", () => {
    const m = mockMoulkia();
    expect(m.ownerName.length).toBeGreaterThan(0);
    expect(m.plate.length).toBeGreaterThan(0);
    expect(m.make).toBe("Nissan");
    expect(m.year).toBe(2022);
  });

  it("parses a clean JSON reply", () => {
    const f = parseMoulkiaJson(
      '{"ownerName":"Ali Hassan","vin":"WDB1234567","plate":"A 55555","make":"Toyota","model":"Camry","year":2019}',
    );
    expect(f.ownerName).toBe("Ali Hassan");
    expect(f.plate).toBe("A 55555");
    expect(f.year).toBe(2019);
  });

  it("tolerates prose around the JSON", () => {
    const f = parseMoulkiaJson('Here you go:\n{"make":"Honda","model":"Accord","year":2020} — done');
    expect(f.make).toBe("Honda");
    expect(f.year).toBe(2020);
    expect(f.ownerName).toBe(""); // missing → empty
  });

  it("rejects an implausible year", () => {
    expect(parseMoulkiaJson('{"year":123}').year).toBeNull();
    expect(parseMoulkiaJson('{"year":0}').year).toBeNull();
    expect(parseMoulkiaJson("not json").year).toBeNull();
  });

  it("detects an empty extraction (every field blank)", () => {
    const empty = parseMoulkiaJson('{"ownerName":"","vin":"","plate":"","make":"","model":"","year":0}');
    expect(isEmptyExtraction(empty)).toBe(true);
    const partial = parseMoulkiaJson('{"make":"Toyota","year":0,"ownerName":"","vin":"","plate":"","model":""}');
    expect(isEmptyExtraction(partial)).toBe(false); // make populated → not empty
  });

  it("mock OCR is free; real models are metered with verified pricing", () => {
    expect(ocrCostUsd("mock-ocr", 0, 0)).toBe(0);
    // Haiku 4.5: $1/Mtok in + $5/Mtok out
    expect(ocrCostUsd("claude-haiku-4-5", 1_000_000, 0)).toBeCloseTo(1, 5);
    expect(ocrCostUsd("claude-haiku-4-5", 0, 1_000_000)).toBeCloseTo(5, 5);
    // Sonnet 4.6: $3/Mtok in + $15/Mtok out
    expect(ocrCostUsd("claude-sonnet-4-6", 1_000_000, 0)).toBeCloseTo(3, 5);
    expect(ocrCostUsd("claude-sonnet-4-6", 0, 1_000_000)).toBeCloseTo(15, 5);
  });
});

// ---- end-to-end: extractMoulkia with a stubbed fetch ----

interface FetchCall {
  model: string;
}

function makeAnthropicResponse(ok: boolean, body: object): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response;
}

/** Builds a fetch stub that returns the given results in order, and records the model used in each call. */
function stubFetch(results: ({ ok: boolean; body: object })[]): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const f = (async (_url: string, init?: RequestInit) => {
    const reqBody = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    calls.push({ model: reqBody.model ?? "" });
    const r = results[i] ?? results[results.length - 1];
    i++;
    return makeAnthropicResponse(r.ok, r.body);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const validPayload = {
  content: [
    {
      text:
        '{"ownerName":"Khalid","vin":"VIN123","plate":"A 1","make":"Toyota","model":"Camry","year":2020}',
    },
  ],
  usage: { input_tokens: 100, output_tokens: 50 },
};

const emptyPayload = {
  content: [{ text: '{"ownerName":"","vin":"","plate":"","make":"","model":"","year":0}' }],
  usage: { input_tokens: 100, output_tokens: 20 },
};

async function withMockedEnv(fn: () => Promise<void>) {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
}

describe("Moulkia OCR — primary + fallback chain", () => {
  it("no API key → mock prefill, one mock attempt logged, NOT marked failed", async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = await extractMoulkia("xxx", "image/jpeg");
      expect(r.failed).toBeUndefined();
      expect(r.fields.make).toBe("Nissan");
      expect(r.attempts).toHaveLength(1);
      expect(r.attempts[0].model).toBe("mock-ocr");
    } finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it("primary succeeds → ONE AiEvent row, no fallback called", async () => {
    await withMockedEnv(async () => {
      const { fetch: f, calls } = stubFetch([{ ok: true, body: validPayload }]);
      globalThis.fetch = f;
      const r = await extractMoulkia("xxx", "image/jpeg");
      expect(r.failed).toBeUndefined();
      expect(r.fields.make).toBe("Toyota");
      expect(r.attempts).toHaveLength(1);
      expect(r.attempts[0].model).toBe(OCR_PRIMARY);
      expect(calls).toHaveLength(1);
      expect(calls[0].model).toBe(OCR_PRIMARY);
    });
  });

  it("primary HTTP error → fallback fires → TWO AiEvent rows, second succeeds", async () => {
    await withMockedEnv(async () => {
      const { fetch: f, calls } = stubFetch([
        { ok: false, body: { error: { message: "Invalid image" } } },
        { ok: true, body: validPayload },
      ]);
      globalThis.fetch = f;
      const r = await extractMoulkia("xxx", "image/jpeg");
      expect(r.failed).toBeUndefined();
      expect(r.fields.make).toBe("Toyota");
      expect(r.attempts).toHaveLength(2);
      expect(r.attempts[0].model).toBe(OCR_PRIMARY);
      expect(r.attempts[0].error).toMatch(/Invalid image|500/);
      expect(r.attempts[1].model).toBe(OCR_FALLBACK);
      expect(r.attempts[1].error).toBeUndefined();
      expect(calls.map((c) => c.model)).toEqual([OCR_PRIMARY, OCR_FALLBACK]);
    });
  });

  it("primary returns ALL-EMPTY → soft-fail triggers fallback (real Moulkia photo case)", async () => {
    await withMockedEnv(async () => {
      const { fetch: f, calls } = stubFetch([
        { ok: true, body: emptyPayload }, // Haiku "I can't read this"
        { ok: true, body: validPayload }, // Sonnet recovers it
      ]);
      globalThis.fetch = f;
      const r = await extractMoulkia("xxx", "image/jpeg");
      expect(r.failed).toBeUndefined();
      expect(r.fields.make).toBe("Toyota");
      expect(r.attempts).toHaveLength(2);
      expect(r.attempts[0].error).toBe("empty-extraction");
      expect(calls.map((c) => c.model)).toEqual([OCR_PRIMARY, OCR_FALLBACK]);
    });
  });

  it("BOTH attempts fail → failed=true, blank fields (no fake data), TWO AiEvent rows", async () => {
    await withMockedEnv(async () => {
      const { fetch: f, calls } = stubFetch([
        { ok: false, body: { error: { message: "first failure" } } },
        { ok: false, body: { error: { message: "second failure" } } },
      ]);
      globalThis.fetch = f;
      const r = await extractMoulkia("xxx", "image/jpeg");
      expect(r.failed).toBe(true);
      expect(r.fields.make).toBe(""); // critically: NOT mock data, NOT stale data
      expect(r.attempts).toHaveLength(2);
      expect(r.attempts[0].error).toBeTruthy();
      expect(r.attempts[1].error).toBeTruthy();
      expect(calls.map((c) => c.model)).toEqual([OCR_PRIMARY, OCR_FALLBACK]);
    });
  });

  it("model identifiers match Anthropic's docs (verified 2026-06-05)", () => {
    // These must be valid against https://platform.claude.com/docs (Models overview).
    // If Anthropic deprecates one, update both this test AND the OCR constants together
    // so the fallback doesn't silently break on a wrong name.
    expect(OCR_PRIMARY).toBe("claude-haiku-4-5");
    expect(OCR_FALLBACK).toBe("claude-sonnet-4-6");
  });
});
