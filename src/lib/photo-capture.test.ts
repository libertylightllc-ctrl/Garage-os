import { describe, it, expect } from "vitest";
import {
  defaultAccept,
  defaultCapture,
  fileTooBig,
  fileTypeMatches,
  MAX_FILE_BYTES,
} from "./photo-capture";

describe("photo-capture defaults", () => {
  it("photo + voice both use capture=environment (React typing); audio is driven by accept", () => {
    expect(defaultAccept("photo")).toBe("image/*");
    expect(defaultAccept("voice")).toBe("audio/*");
    expect(defaultCapture("photo")).toBe("environment");
    expect(defaultCapture("voice")).toBe("environment");
  });
});

describe("fileTooBig", () => {
  it("at-limit OK, over-limit not OK", () => {
    expect(fileTooBig(MAX_FILE_BYTES)).toBe(false);
    expect(fileTooBig(MAX_FILE_BYTES + 1)).toBe(true);
    expect(fileTooBig(0)).toBe(false);
  });
  it("custom max", () => {
    expect(fileTooBig(2_000_000, 1_000_000)).toBe(true);
    expect(fileTooBig(500_000, 1_000_000)).toBe(false);
  });
});

describe("fileTypeMatches", () => {
  it("photo: accepts image MIME, accepts extensions, rejects audio", () => {
    expect(fileTypeMatches({ type: "image/jpeg", name: "a.jpg" }, "photo")).toBe(true);
    expect(fileTypeMatches({ type: "image/heic", name: "moulkia.HEIC" }, "photo")).toBe(true);
    // Some cameras leave MIME empty — fall back to extension
    expect(fileTypeMatches({ type: "", name: "photo.png" }, "photo")).toBe(true);
    // Audio shouldn't pass as a photo
    expect(fileTypeMatches({ type: "audio/mpeg", name: "x.mp3" }, "photo")).toBe(false);
    // Truly unknown
    expect(fileTypeMatches({ type: "", name: "doc.pdf" }, "photo")).toBe(false);
  });

  it("voice: accepts audio MIME, accepts extensions, rejects images", () => {
    expect(fileTypeMatches({ type: "audio/mpeg", name: "x.mp3" }, "voice")).toBe(true);
    expect(fileTypeMatches({ type: "audio/webm", name: "x" }, "voice")).toBe(true);
    expect(fileTypeMatches({ type: "", name: "note.m4a" }, "voice")).toBe(true);
    expect(fileTypeMatches({ type: "image/jpeg", name: "x.jpg" }, "voice")).toBe(false);
  });
});
