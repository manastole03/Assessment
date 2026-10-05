import { describe, expect, it } from "vitest";

import { safeNext } from "./next";

describe("safeNext", () => {
  it.each([
    ["/runs/abc", "/runs/abc"],
    ["/capabilities?status=draft#top", "/capabilities?status=draft#top"],
    ["/runs/a%2Fb", "/runs/a%2Fb"],
  ])("keeps the in-app path %s", (next, expected) => {
    expect(safeNext(next)).toBe(expected);
  });

  it.each([
    null,
    "",
    "https://evil.example",
    "//evil.example",
    "/\\evil.example", // browsers read "\" as "/": //evil.example
    "/\t/evil.example", // URL parsing strips tabs and newlines: //evil.example
    "/\n/evil.example",
    "javascript:alert(1)",
    "runs/abc",
  ])("falls back to the overview for %j", (next) => {
    expect(safeNext(next)).toBe("/overview");
  });
});
