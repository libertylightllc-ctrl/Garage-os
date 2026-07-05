import { describe, it, expect, vi } from "vitest";
import {
  parseMoulkiaFrontJson,
  parseMoulkiaBackJson,
  mergeMoulkiaFields,
  isEmptyFront,
  isEmptyBack,
  ocrCostUsd,
  extractMoulkiaFront,
  extractMoulkiaBack,
  extractPartsInvoice,
  OcrDisabledError,
  OCR_PRIMARY,
  OCR_FALLBACK,
  type MoulkiaFront,
  type MoulkiaBack,
} from "./ocr";

describe("Moulkia OCR — pure helpers", () => {
  it("parses front JSON — owner + plate only (vehicle fields blank)", () => {
    const f = parseMoulkiaFrontJson('{"ownerName":"Ali Hassan","plate":"A 55555"}');
    expect(f).toEqual({
      ownerName: "Ali Hassan",
      plate: "A 55555",
      vin: "",
      make: "",
      model: "",
      year: null,
    });
  });

  it("parses front JSON — owner + plate + vehicle specs (the new prompt)", () => {
    const f = parseMoulkiaFrontJson(
      '{"ownerName":"Ali Hassan","plate":"A 55555","make":"Toyota","model":"Camry","year":2020,"vin":"JT123"}',
    );
    expect(f).toEqual({
      ownerName: "Ali Hassan",
      plate: "A 55555",
      vin: "JT123",
      make: "Toyota",
      model: "Camry",
      year: 2020,
    });
  });

  it("parses back-only JSON (VIN + make + model + year)", () => {
    const b = parseMoulkiaBackJson(
      '{"vin":"VIN123","make":"Toyota","model":"Camry","year":2020}',
    );
    expect(b).toEqual({
      vin: "VIN123",
      make: "Toyota",
      model: "Camry",
      year: 2020,
    });
  });

  it("ignores extra fields like engineNumber if the model returns them (defensive)", () => {
    // Older prompts asked for engineNumber; if a cached response includes it
    // we just drop it on the floor. The field is no longer captured anywhere.
    const b = parseMoulkiaBackJson(
      '{"vin":"VIN123","make":"Toyota","model":"Camry","year":2020,"engineNumber":"VQ40"}',
    );
    expect(b).toEqual({ vin: "VIN123", make: "Toyota", model: "Camry", year: 2020 });
    expect("engineNumber" in b).toBe(false);
  });

  it("tolerates prose around the JSON on either side", () => {
    expect(parseMoulkiaFrontJson('hello {"ownerName":"Ali","plate":""} bye').ownerName).toBe("Ali");
    expect(parseMoulkiaBackJson("nope { not json").make).toBe("");
  });

  it("rejects implausible year on the back", () => {
    expect(parseMoulkiaBackJson('{"year":1900}').year).toBeNull();
    expect(parseMoulkiaBackJson('{"year":0}').year).toBeNull();
    expect(parseMoulkiaBackJson('{"year":"2023"}').year).toBe(2023); // string ok
  });

  it("isEmptyFront/Back detect blank extractions", () => {
    expect(
      isEmptyFront({ ownerName: "", plate: "", vin: "", make: "", model: "", year: null }),
    ).toBe(true);
    expect(
      isEmptyFront({ ownerName: "Ali", plate: "", vin: "", make: "", model: "", year: null }),
    ).toBe(false);
    expect(isEmptyBack({ vin: "", make: "", model: "", year: 0 })).toBe(true);
    expect(isEmptyBack({ vin: "VIN", make: "", model: "", year: null })).toBe(false);
  });

  it("verified pricing for the two OCR models", () => {
    expect(ocrCostUsd("mock-ocr", 0, 0)).toBe(0);
    expect(ocrCostUsd("claude-haiku-4-5", 1_000_000, 0)).toBeCloseTo(1, 5);
    expect(ocrCostUsd("claude-sonnet-4-6", 1_000_000, 1_000_000)).toBeCloseTo(18, 5); // 3 + 15
  });
});

describe("mergeMoulkiaFields — back wins year, no empty overwrites", () => {
  it("happy path — front identity + back specs", () => {
    const front: MoulkiaFront = {
      ownerName: "Khalid",
      plate: "A 1",
      vin: "",
      make: "",
      model: "",
      year: null,
    };
    const back: MoulkiaBack = { vin: "VIN", make: "Toyota", model: "Camry", year: 2020 };
    expect(mergeMoulkiaFields(front, back)).toEqual({
      ownerName: "Khalid",
      plate: "A 1",
      vin: "VIN",
      make: "Toyota",
      model: "Camry",
      year: 2020,
    });
  });

  it("trims whitespace on every string field", () => {
    expect(
      mergeMoulkiaFields({ ownerName: "  Khalid  ", plate: " A 1 " }, { make: "  Toyota  " }),
    ).toMatchObject({ ownerName: "Khalid", plate: "A 1", make: "Toyota" });
  });

  it("year: back wins on overlap (decision A)", () => {
    const back: MoulkiaBack = { vin: "", make: "", model: "", year: 2022 };
    // Even if a front sneaks a year in (shouldn't, but defensive), back's year is the answer.
    const result = mergeMoulkiaFields({ ownerName: "", plate: "", year: 2018 }, back);
    expect(result.year).toBe(2022);
  });

  it("missing back → front's vehicle specs survive (new behaviour)", () => {
    // Before the front prompt expansion, missing-back meant blank vehicle
    // specs. Now the front captures them too — they ride through the merge.
    const result = mergeMoulkiaFields(
      { ownerName: "Khalid", plate: "A 1", vin: "FRONT-VIN", make: "Toyota", year: 2019 },
      {},
    );
    expect(result.vin).toBe("FRONT-VIN");
    expect(result.make).toBe("Toyota");
    expect(result.year).toBe(2019);
  });

  it("back wins on overlap — front specs fall away when back has them", () => {
    const result = mergeMoulkiaFields(
      { ownerName: "K", plate: "A 1", vin: "WRONG", make: "Toyot", model: "Camrey", year: 2018 },
      { vin: "RIGHT", make: "Toyota", model: "Camry", year: 2020 },
    );
    expect(result.vin).toBe("RIGHT");
    expect(result.make).toBe("Toyota");
    expect(result.model).toBe("Camry");
    expect(result.year).toBe(2020);
  });

  it("back EMPTY for a single field → front fills the gap (no overwrite-with-blank)", () => {
    const result = mergeMoulkiaFields(
      { vin: "FRONT-VIN", make: "Toyota" },
      { vin: "", make: "Honda" }, // back's VIN is blank, but make is set
    );
    expect(result.vin).toBe("FRONT-VIN"); // front fills the gap
    expect(result.make).toBe("Honda"); // back overrides when it has a value
  });

  it("missing front → vehicle-only, no fake identity", () => {
    const result = mergeMoulkiaFields({}, { make: "Toyota", year: 2020 } as MoulkiaBack);
    expect(result.ownerName).toBe("");
    expect(result.plate).toBe("");
    expect(result.make).toBe("Toyota");
  });
});

// ---- end-to-end: extractMoulkiaFront / Back with stubbed fetch ----

function makeResp(ok: boolean, body: object): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function stubFetch(results: { ok: boolean; body: object }[]): {
  fetch: typeof fetch;
  calls: { model: string }[];
} {
  const calls: { model: string }[] = [];
  let i = 0;
  const f = (async (_url: string, init?: RequestInit) => {
    const reqBody = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    calls.push({ model: reqBody.model ?? "" });
    const r = results[i] ?? results[results.length - 1];
    i++;
    return makeResp(r.ok, r.body);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

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

const frontPayload = {
  // New prompt asks for owner + plate + make + model + year + VIN.
  content: [
    {
      text:
        '{"ownerName":"Khalid","plate":"A 1","make":"Toyota","model":"Camry","year":2019,"vin":"FRONTVIN"}',
    },
  ],
  usage: { input_tokens: 50, output_tokens: 30 },
};
const emptyFrontPayload = {
  content: [{ text: '{"ownerName":"","plate":"","make":"","model":"","year":0,"vin":""}' }],
  usage: { input_tokens: 50, output_tokens: 10 },
};
const backPayload = {
  content: [
    {
      text:
        '{"vin":"VIN1","make":"Toyota","model":"Camry","year":2020}',
    },
  ],
  usage: { input_tokens: 80, output_tokens: 40 },
};
const emptyBackPayload = {
  content: [{ text: '{"vin":"","make":"","model":"","year":0}' }],
  usage: { input_tokens: 80, output_tokens: 12 },
};

// Production hardening — mock OCR is a DEV-ONLY convenience. In production a
// missing ANTHROPIC_API_KEY must fail LOUDLY (OcrDisabledError), never silently
// hand a real user fabricated invoice/registration reads. One shared gate in
// extractWithFallback covers BOTH surfaces, so we assert both.
describe("production hardening — no key must ERROR, never mock", () => {
  async function withProdNoKey(fn: () => Promise<void>) {
    // vi.stubEnv handles NODE_ENV's readonly typing + auto-restores on unstub.
    // "" is falsy → ocrEnabled() returns false, same as an unset key.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    try {
      await fn();
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it("invoice OCR throws OcrDisabledError in production with no key (no mock)", async () => {
    await withProdNoKey(async () => {
      await expect(extractPartsInvoice("xxx", "image/jpeg")).rejects.toBeInstanceOf(
        OcrDisabledError,
      );
    });
  });

  it("Moulkia OCR throws OcrDisabledError in production with no key (no mock)", async () => {
    await withProdNoKey(async () => {
      await expect(extractMoulkiaFront("xxx", "image/jpeg")).rejects.toBeInstanceOf(
        OcrDisabledError,
      );
    });
  });

  it("outside production, no key still returns mock (dev convenience preserved)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", ""); // NODE_ENV stays 'test'
    try {
      const r = await extractPartsInvoice("xxx", "image/jpeg");
      expect(r.attempts[0].model).toBe("mock-ocr");
      expect(r.fields.lines.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("extractMoulkiaFront — primary + fallback chain", () => {
  it("no API key → mock prefill, one mock attempt logged", async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = await extractMoulkiaFront("xxx", "image/jpeg");
      expect(r.failed).toBeUndefined();
      expect(r.fields.ownerName.length).toBeGreaterThan(0);
      expect(r.attempts).toHaveLength(1);
      expect(r.attempts[0].model).toBe("mock-ocr");
    } finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it("primary succeeds → 1 attempt, returns ALL six front fields (the new prompt)", async () => {
    await withMockedEnv(async () => {
      const { fetch: f, calls } = stubFetch([{ ok: true, body: frontPayload }]);
      globalThis.fetch = f;
      const r = await extractMoulkiaFront("xxx", "image/jpeg");
      expect(r.failed).toBeUndefined();
      // Owner name + plate + vehicle specs must ALL come through.
      expect(r.fields).toEqual({
        ownerName: "Khalid",
        plate: "A 1",
        vin: "FRONTVIN",
        make: "Toyota",
        model: "Camry",
        year: 2019,
      });
      expect(r.attempts).toHaveLength(1);
      expect(calls.map((c) => c.model)).toEqual([OCR_PRIMARY]);
    });
  });

  it("system prompt instructs the model to extract from the middle section + all four vehicle fields", async () => {
    // Captures the exact instruction the user asked us to add. If somebody
    // weakens the prompt later, this test surfaces it before the deploy.
    await withMockedEnv(async () => {
      let bodySeen = "";
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        bodySeen = String(init?.body ?? "");
        return { ok: true, status: 200, json: async () => frontPayload } as unknown as Response;
      }) as unknown as typeof fetch;
      await extractMoulkiaFront("xxx", "image/jpeg");
      expect(bodySeen).toContain("middle section of the front of the Moulkia");
      expect(bodySeen).toContain("Also extract vehicle make, model, year, and VIN");
      expect(bodySeen).toContain("Return all four fields");
      // Sharper-prompt cues from the iPhone-testing pass — pin them too.
      expect(bodySeen).toContain("Read the Latin/English transcription, never the Arabic");
      expect(bodySeen).toContain("Chassis No");
    });
  });

  it("primary HTTP error → 2 attempts, fallback succeeds", async () => {
    await withMockedEnv(async () => {
      const { fetch: f, calls } = stubFetch([
        { ok: false, body: { error: { message: "Bad image" } } },
        { ok: true, body: frontPayload },
      ]);
      globalThis.fetch = f;
      const r = await extractMoulkiaFront("xxx", "image/jpeg");
      expect(r.fields.ownerName).toBe("Khalid");
      expect(r.attempts).toHaveLength(2);
      expect(r.attempts[0].error).toBeTruthy();
      expect(calls.map((c) => c.model)).toEqual([OCR_PRIMARY, OCR_FALLBACK]);
    });
  });

  it("primary all-empty → soft-fail triggers fallback", async () => {
    await withMockedEnv(async () => {
      const { fetch: f, calls } = stubFetch([
        { ok: true, body: emptyFrontPayload },
        { ok: true, body: frontPayload },
      ]);
      globalThis.fetch = f;
      const r = await extractMoulkiaFront("xxx", "image/jpeg");
      expect(r.fields.ownerName).toBe("Khalid");
      expect(r.attempts).toHaveLength(2);
      expect(r.attempts[0].error).toBe("empty-extraction");
      expect(calls.map((c) => c.model)).toEqual([OCR_PRIMARY, OCR_FALLBACK]);
    });
  });

  it("BOTH fail → failed=true, empty fields, 2 attempts", async () => {
    await withMockedEnv(async () => {
      const { fetch: f, calls } = stubFetch([
        { ok: false, body: { error: { message: "first" } } },
        { ok: false, body: { error: { message: "second" } } },
      ]);
      globalThis.fetch = f;
      const r = await extractMoulkiaFront("xxx", "image/jpeg");
      expect(r.failed).toBe(true);
      expect(r.fields).toEqual({
        ownerName: "",
        plate: "",
        vin: "",
        make: "",
        model: "",
        year: null,
      });
      expect(r.attempts).toHaveLength(2);
      expect(calls.map((c) => c.model)).toEqual([OCR_PRIMARY, OCR_FALLBACK]);
    });
  });
});

describe("extractMoulkiaBack — same chain, different fields", () => {
  it("primary succeeds → 1 attempt", async () => {
    await withMockedEnv(async () => {
      const { fetch: f, calls } = stubFetch([{ ok: true, body: backPayload }]);
      globalThis.fetch = f;
      const r = await extractMoulkiaBack("xxx", "image/jpeg");
      expect(r.fields.vin).toBe("VIN1");
      expect(r.fields.year).toBe(2020);
      expect(r.attempts).toHaveLength(1);
      expect(calls.map((c) => c.model)).toEqual([OCR_PRIMARY]);
    });
  });

  it("empty back triggers fallback (real-world case for the cheaper model to rescue)", async () => {
    await withMockedEnv(async () => {
      const { fetch: f, calls } = stubFetch([
        { ok: true, body: emptyBackPayload },
        { ok: true, body: backPayload },
      ]);
      globalThis.fetch = f;
      const r = await extractMoulkiaBack("xxx", "image/jpeg");
      expect(r.fields.vin).toBe("VIN1");
      expect(r.attempts).toHaveLength(2);
      expect(calls.map((c) => c.model)).toEqual([OCR_PRIMARY, OCR_FALLBACK]);
    });
  });

  it("BOTH fail → failed=true, empty fields, 2 attempts", async () => {
    await withMockedEnv(async () => {
      const { fetch: f } = stubFetch([
        { ok: false, body: { error: { message: "first" } } },
        { ok: false, body: { error: { message: "second" } } },
      ]);
      globalThis.fetch = f;
      const r = await extractMoulkiaBack("xxx", "image/jpeg");
      expect(r.failed).toBe(true);
      expect(r.fields).toEqual({ vin: "", make: "", model: "", year: null });
    });
  });

  it("model identifiers are still the verified Anthropic strings", () => {
    // Sonnet-primary (accuracy first) after real iPhone testing showed
    // Haiku misreads. Haiku stays as the cheaper/faster safety net.
    expect(OCR_PRIMARY).toBe("claude-sonnet-4-6");
    expect(OCR_FALLBACK).toBe("claude-haiku-4-5");
  });
});
