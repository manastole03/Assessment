import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TourProvider } from "./tour-provider";
import { TOUR_STORAGE_KEY } from "./state";

function renderAt(path: string, page: ReactNode = <h1>Landing</h1>) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <TourProvider>
          <Routes>
            <Route path="/" element={page} />
            <Route path="/runs/:id" element={<h1>Live run</h1>} />
          </Routes>
        </TourProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("first visit", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("[]", { status: 200 }))),
    );
  });

  it("offers the tour on the landing page and remembers a dismissal", async () => {
    const user = userEvent.setup();
    const { unmount } = renderAt("/");
    expect(await screen.findByRole("dialog", { name: "Welcome to rote" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start the tour" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(localStorage.getItem(TOUR_STORAGE_KEY)).toBe("dismissed");

    unmount();
    renderAt("/");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("never interrupts a deep link", () => {
    renderAt("/runs/abc");
    expect(screen.getByRole("heading", { name: "Live run" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
