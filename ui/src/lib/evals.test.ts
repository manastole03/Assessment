import { describe, expect, it } from "vitest";

import { percent, severityOf } from "./evals";
import { locatorText, text } from "./format";

describe("eval helpers", () => {
  it("grades a pass rate against its gate", () => {
    expect(severityOf(1, 1)).toBe("good");
    expect(severityOf(0.8, 0.8)).toBe("good");
    expect(severityOf(0.75, 1)).toBe("warning");
    expect(severityOf(0.2, 1)).toBe("critical");
  });

  it("formats percentages", () => {
    expect(percent(0)).toBe("0%");
    expect(percent(2 / 3)).toBe("67%");
  });
});

describe("format", () => {
  it("renders untyped JSON without [object Object]", () => {
    expect(text(null)).toBe("");
    expect(text(3)).toBe("3");
    expect(text({ a: 1 })).toBe('{"a":1}');
  });

  it("describes locators the way a reviewer reads them", () => {
    expect(locatorText({ by: "table_cell", row: "SHARE SAVINGS", column: "CURRENT BALANCE" })).toBe(
      "row “SHARE SAVINGS” × column “CURRENT BALANCE”",
    );
    expect(locatorText({ by: "attribute", tag: "input", attribute: "name", value: "MBRNO" })).toBe('input[name="MBRNO"]');
  });
});
