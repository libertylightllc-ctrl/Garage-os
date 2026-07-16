import { describe, it, expect } from "vitest";
import {
  parsePerPage,
  parsePage,
  pageCountOf,
  clampPage,
  computeWindow,
  DEFAULT_PER_PAGE,
} from "./pagination";

describe("parsePerPage", () => {
  it("accepts 10 / 20 / 30 / 40 exactly", () => {
    expect(parsePerPage("10")).toBe(10);
    expect(parsePerPage("20")).toBe(20);
    expect(parsePerPage("30")).toBe(30);
    expect(parsePerPage("40")).toBe(40);
  });

  it("default is 10", () => {
    expect(DEFAULT_PER_PAGE).toBe(10);
  });

  it("defaults on anything else — negative / non-string / off-menu / junk", () => {
    expect(parsePerPage("25")).toBe(DEFAULT_PER_PAGE);
    expect(parsePerPage("-1")).toBe(DEFAULT_PER_PAGE);
    expect(parsePerPage("")).toBe(DEFAULT_PER_PAGE);
    expect(parsePerPage(undefined)).toBe(DEFAULT_PER_PAGE);
    expect(parsePerPage(30 as unknown)).toBe(DEFAULT_PER_PAGE); // must be string
    expect(parsePerPage("abc")).toBe(DEFAULT_PER_PAGE);
  });
});

describe("parsePage", () => {
  it("parses 1-based page numbers", () => {
    expect(parsePage("1")).toBe(1);
    expect(parsePage("7")).toBe(7);
    expect(parsePage("123")).toBe(123);
  });

  it("defaults to 1 on missing / negative / junk", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("")).toBe(1);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-5")).toBe(1);
    expect(parsePage("abc")).toBe(1);
  });

  it("floors fractional pages", () => {
    expect(parsePage("3.7")).toBe(3);
  });
});

describe("pageCountOf", () => {
  it("empty result set still returns page 1 of 1", () => {
    expect(pageCountOf(0, 20)).toBe(1);
  });

  it("exact multiples", () => {
    expect(pageCountOf(40, 20)).toBe(2);
    expect(pageCountOf(60, 20)).toBe(3);
  });

  it("rounds up remainder", () => {
    expect(pageCountOf(41, 20)).toBe(3);
    expect(pageCountOf(1, 20)).toBe(1);
    expect(pageCountOf(247, 20)).toBe(13);
  });
});

describe("clampPage", () => {
  it("returns requested page when in range", () => {
    expect(clampPage(3, 5)).toBe(3);
    expect(clampPage(1, 1)).toBe(1);
  });

  it("clamps stale URLs to the last page — does not error", () => {
    expect(clampPage(99, 5)).toBe(5);
    expect(clampPage(6, 5)).toBe(5);
  });

  it("clamps low values to 1", () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(-3, 5)).toBe(1);
  });
});

describe("computeWindow", () => {
  it("first page, 247 total, per=20 -> Showing 1-20 of 247", () => {
    const w = computeWindow({ rawPage: "1", rawPer: "20", totalCount: 247 });
    expect(w.perPage).toBe(20);
    expect(w.page).toBe(1);
    expect(w.skip).toBe(0);
    expect(w.take).toBe(20);
    expect(w.pageCount).toBe(13);
    expect(w.from).toBe(1);
    expect(w.to).toBe(20);
  });

  it("middle page — 5 of 13, 247 total, per=20", () => {
    const w = computeWindow({ rawPage: "5", rawPer: "20", totalCount: 247 });
    expect(w.page).toBe(5);
    expect(w.skip).toBe(80);
    expect(w.from).toBe(81);
    expect(w.to).toBe(100);
  });

  it("last page fills partially — 13 of 13, 247 total, per=20", () => {
    const w = computeWindow({ rawPage: "13", rawPer: "20", totalCount: 247 });
    expect(w.page).toBe(13);
    expect(w.skip).toBe(240);
    expect(w.from).toBe(241);
    expect(w.to).toBe(247);
  });

  it("clamps stale ?page=99 down to the last real page", () => {
    const w = computeWindow({ rawPage: "99", rawPer: "20", totalCount: 247 });
    expect(w.page).toBe(13);
    expect(w.from).toBe(241);
    expect(w.to).toBe(247);
  });

  it("empty result set — from/to = 0, page 1 of 1", () => {
    const w = computeWindow({ rawPage: "1", rawPer: "20", totalCount: 0 });
    expect(w.page).toBe(1);
    expect(w.pageCount).toBe(1);
    expect(w.from).toBe(0);
    expect(w.to).toBe(0);
  });

  it("off-menu per=25 falls back to default 10", () => {
    const w = computeWindow({ rawPage: "1", rawPer: "25", totalCount: 100 });
    expect(w.perPage).toBe(10);
  });

  it("switching per=40 keeps the slice honest", () => {
    const w = computeWindow({ rawPage: "1", rawPer: "40", totalCount: 100 });
    expect(w.perPage).toBe(40);
    expect(w.take).toBe(40);
    expect(w.from).toBe(1);
    expect(w.to).toBe(40);
    expect(w.pageCount).toBe(3);
  });
});
