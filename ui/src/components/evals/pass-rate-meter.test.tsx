import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PassRateMeter } from "./pass-rate-meter";

describe("PassRateMeter", () => {
  it("states the numbers in text, not only in colour", () => {
    render(<PassRateMeter label="multi-tenant" passed={2} total={3} threshold={1} />);
    const meter = screen.getByRole("meter", { name: "multi-tenant" });
    expect(meter).toHaveAttribute("aria-valuenow", "2");
    expect(meter).toHaveAttribute("aria-valuetext", "2 of 3 passed (67%), below the gate");
    expect(screen.getByText("2/3 · 67%")).toBeInTheDocument();
  });

  it("handles an empty suite", () => {
    render(<PassRateMeter passed={0} total={0} />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "0 of 0 passed (0%), well below the gate");
  });
});
