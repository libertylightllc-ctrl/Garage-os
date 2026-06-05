import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { storageMode, storageBucket, pickExtension, objectKey } from "./storage-config";

describe("storage strategy switch", () => {
  let prevUrl: string | undefined;
  let prevKey: string | undefined;
  let prevBucket: string | undefined;

  beforeEach(() => {
    prevUrl = process.env.SUPABASE_URL;
    prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    prevBucket = process.env.STORAGE_BUCKET;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.STORAGE_BUCKET;
  });

  afterEach(() => {
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    if (prevBucket !== undefined) process.env.STORAGE_BUCKET = prevBucket;
  });

  it("defaults to local when no env is set (demo / dev)", () => {
    expect(storageMode()).toBe("local");
  });

  it("switches to supabase only when BOTH url and key are set", () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    expect(storageMode()).toBe("local"); // key missing
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sk-test";
    expect(storageMode()).toBe("supabase");
    delete process.env.SUPABASE_URL;
    expect(storageMode()).toBe("local"); // url missing
  });

  it("storageBucket defaults to garage-uploads, env override wins", () => {
    expect(storageBucket()).toBe("garage-uploads");
    process.env.STORAGE_BUCKET = "staging-uploads";
    expect(storageBucket()).toBe("staging-uploads");
  });
});

describe("pickExtension", () => {
  it("prefers the filename extension when present", () => {
    expect(pickExtension("photo.JPG", "image/png")).toBe(".jpg"); // lowercased
    expect(pickExtension("clip.webm", "")).toBe(".webm");
  });

  it("falls back to the MIME subtype", () => {
    expect(pickExtension("noext", "image/jpeg")).toBe(".jpeg");
    expect(pickExtension("noext", "audio/mp4; codecs=opus")).toBe(".mp4"); // strips ;params
  });

  it("returns empty when neither has a usable hint", () => {
    expect(pickExtension("noext", "")).toBe("");
    expect(pickExtension("noext", "garbage")).toBe("");
  });
});

describe("objectKey (tenant scoping)", () => {
  it("namespaces under garages/{garageId}/", () => {
    const k = objectKey("demo-garage", "abc123", "photo.jpg", "image/jpeg");
    expect(k).toBe("garages/demo-garage/abc123.jpg");
  });

  it("sanitises a hostile garageId", () => {
    const k = objectKey("../etc/passwd", "abc123", "x", "image/jpeg");
    expect(k.startsWith("garages/")).toBe(true);
    expect(k).not.toContain("..");
    expect(k).not.toContain("/etc/");
  });

  it("falls back to underscore for an empty garageId", () => {
    const k = objectKey("", "abc123", "x", "image/jpeg");
    expect(k).toBe("garages/_/abc123.jpeg");
  });

  it("includes the picked extension", () => {
    expect(objectKey("g", "u", "voice.webm", "")).toBe("garages/g/u.webm");
    expect(objectKey("g", "u", "noext", "audio/mp4")).toBe("garages/g/u.mp4");
  });
});
