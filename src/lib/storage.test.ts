import { describe, it, expect } from "vitest";
import {
  LOGO_MAX_BYTES,
  LOGO_ALLOWED_MIME,
  LogoValidationError,
  parseLogoUrl,
  validateLogoFile,
} from "./storage";

// Magic byte prefixes — kept here so the test asserts on the same
// values an attacker would have to forge to bypass sniffImageType().
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const WEBP_HEAD = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0x00, 0x00, 0x00, 0x00, // size placeholder
  0x57, 0x45, 0x42, 0x50, // "WEBP"
]);
// SVG starts with "<svg" — explicitly REJECTED for stored-XSS safety.
const SVG_HEAD = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
// Plain text — used to prove a forged Content-Type doesn't bypass the
// magic-byte sniff.
const TXT_HEAD = new TextEncoder().encode("hello world this is not an image");

function makeFile(bytes: ArrayBuffer | Uint8Array, name: string, type: string, padTo?: number): File {
  let buf: ArrayBuffer;
  if (bytes instanceof Uint8Array) {
    // Pad up to a target size by appending zeros — used to test the size
    // cap without authoring a fully-formed 500KB+1 PNG.
    const target = padTo ?? bytes.length;
    const out = new Uint8Array(target);
    out.set(bytes);
    // ArrayBuffer typing varies between SharedArrayBuffer and ArrayBuffer
    // depending on the runtime; cast to ArrayBuffer for File() ctor.
    buf = out.buffer as ArrayBuffer;
  } else {
    buf = bytes;
  }
  return new File([buf], name, { type });
}

describe("validateLogoFile — size cap", () => {
  it("rejects an empty file", async () => {
    await expect(validateLogoFile(makeFile(new Uint8Array(0), "x.png", "image/png"))).rejects.toMatchObject(
      { name: "LogoValidationError", code: "EMPTY" },
    );
  });

  it("rejects a file larger than the 500 KB cap", async () => {
    // PNG header + zero padding so the magic-byte check would pass —
    // it's the SIZE check that should fire first.
    const file = makeFile(PNG_HEAD, "big.png", "image/png", LOGO_MAX_BYTES + 1);
    await expect(validateLogoFile(file)).rejects.toMatchObject({
      name: "LogoValidationError",
      code: "TOO_LARGE",
    });
  });

  it("accepts a file exactly at the size cap", async () => {
    const file = makeFile(PNG_HEAD, "exact.png", "image/png", LOGO_MAX_BYTES);
    await expect(validateLogoFile(file)).resolves.toBeUndefined();
  });
});

describe("validateLogoFile — MIME allowlist", () => {
  it("rejects SVG (stored-XSS risk — must be impossible)", async () => {
    // Even with the correct MIME header for SVG, validation must say no.
    const file = makeFile(SVG_HEAD, "evil.svg", "image/svg+xml");
    await expect(validateLogoFile(file)).rejects.toMatchObject({ code: "BAD_MIME" });
  });

  it("rejects a PDF", async () => {
    const file = makeFile(new TextEncoder().encode("%PDF-1.7"), "x.pdf", "application/pdf");
    await expect(validateLogoFile(file)).rejects.toMatchObject({ code: "BAD_MIME" });
  });

  it("rejects an unknown / missing type", async () => {
    const file = makeFile(PNG_HEAD, "no-type", "");
    await expect(validateLogoFile(file)).rejects.toMatchObject({ code: "BAD_MIME" });
  });

  it("accepts PNG, JPEG, and WEBP", async () => {
    await expect(validateLogoFile(makeFile(PNG_HEAD, "x.png", "image/png"))).resolves.toBeUndefined();
    await expect(validateLogoFile(makeFile(JPEG_HEAD, "x.jpg", "image/jpeg"))).resolves.toBeUndefined();
    await expect(validateLogoFile(makeFile(WEBP_HEAD, "x.webp", "image/webp"))).resolves.toBeUndefined();
  });

  it("exposes the allowlist as a readonly tuple", () => {
    expect([...LOGO_ALLOWED_MIME].sort()).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });
});

describe("validateLogoFile — magic-byte sniff (the real security boundary)", () => {
  it("rejects plain text masquerading as a PNG", async () => {
    // Attack: Content-Type: image/png + filename: logo.png + body is a
    // text file. The MIME check passes, then the sniff catches it.
    const file = makeFile(TXT_HEAD, "logo.png", "image/png");
    await expect(validateLogoFile(file)).rejects.toMatchObject({ code: "BAD_MAGIC" });
  });

  it("rejects a JPEG whose declared type is PNG (MIME mismatch)", async () => {
    const file = makeFile(JPEG_HEAD, "logo.png", "image/png");
    await expect(validateLogoFile(file)).rejects.toMatchObject({ code: "MIME_MISMATCH" });
  });

  it("rejects a PNG whose declared type is JPEG (MIME mismatch)", async () => {
    const file = makeFile(PNG_HEAD, "logo.jpg", "image/jpeg");
    await expect(validateLogoFile(file)).rejects.toMatchObject({ code: "MIME_MISMATCH" });
  });

  it("accepts a real WEBP with matching MIME", async () => {
    await expect(validateLogoFile(makeFile(WEBP_HEAD, "x.webp", "image/webp"))).resolves.toBeUndefined();
  });
});

describe("LogoValidationError", () => {
  it("carries a stable error code for action-layer mapping", async () => {
    try {
      await validateLogoFile(makeFile(SVG_HEAD, "x.svg", "image/svg+xml"));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LogoValidationError);
      expect((e as LogoValidationError).code).toBe("BAD_MIME");
    }
  });
});

describe("parseLogoUrl", () => {
  it("parses a local /api/files/logo-<uuid> URL", () => {
    expect(parseLogoUrl("/api/files/logo-abc-123.png")).toEqual({
      backend: "local",
      filename: "logo-abc-123.png",
    });
  });

  it("parses a Supabase public URL", () => {
    expect(
      parseLogoUrl(
        "https://yxcbucjqpkrqrfkkhssh.supabase.co/storage/v1/object/public/garage-logos/garages/cmqwg2ekw00003guwz34j9o56/abc.png",
      ),
    ).toEqual({
      backend: "supabase",
      bucket: "garage-logos",
      key: "garages/cmqwg2ekw00003guwz34j9o56/abc.png",
    });
  });

  it("returns null for an unrecognised URL so callers can no-op safely", () => {
    expect(parseLogoUrl("https://cdn.example.com/logo.png")).toBeNull();
    expect(parseLogoUrl("not a url")).toBeNull();
    expect(parseLogoUrl("")).toBeNull();
  });

  it("does NOT match a local URL without the `logo-` prefix (so a deleteLogoUpload call cannot wipe tech photos)", () => {
    expect(parseLogoUrl("/api/files/abc-123.png")).toBeNull();
    expect(parseLogoUrl("/api/files/9d8bdfe4-tech-photo.png")).toBeNull();
  });
});
