import { afterEach, describe, expect, it, vi } from "vitest";

import { findTourTarget, readTourStatus, shouldOfferTour, TOUR_STORAGE_KEY, waitForTourTarget, writeTourStatus } from "./state";

const visible = (el: HTMLElement) => {
  el.getClientRects = () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList;
  return el;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("tour state", () => {
  it("offers the tour only on a first visit to the landing page", () => {
    expect(shouldOfferTour("/", null)).toBe(true);
    expect(shouldOfferTour("/", "completed")).toBe(false);
    expect(shouldOfferTour("/", "dismissed")).toBe(false);
    // An operator following an intervention link must land on the live run, not a product tour.
    expect(shouldOfferTour("/runs/20261001T000000Z-replay-x", null)).toBe(false);
    expect(shouldOfferTour("/overview", null)).toBe(false);
  });

  it("round-trips the status and ignores unknown values", () => {
    writeTourStatus(localStorage, "dismissed");
    expect(readTourStatus(localStorage)).toBe("dismissed");
    localStorage.setItem(TOUR_STORAGE_KEY, "something-else");
    expect(readTourStatus(localStorage)).toBeNull();
  });

  it("never throws when storage is unavailable", () => {
    const broken = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    };
    expect(readTourStatus(broken)).toBeNull();
    expect(() => writeTourStatus(broken, "completed")).not.toThrow();
    expect(readTourStatus(undefined)).toBeNull();
  });
});

describe("tour targets", () => {
  it("picks the first visible element carrying the id", () => {
    document.body.innerHTML = `<nav data-tour="nav" id="hidden"></nav><button data-tour="nav" id="shown"></button>`;
    visible(document.getElementById("shown")!);
    expect(findTourTarget("nav")?.id).toBe("shown");
    expect(findTourTarget("missing")).toBeNull();
  });

  it("waits for a target that renders later", async () => {
    const pending = waitForTourTarget("late", 1000);
    const el = visible(document.createElement("section"));
    el.dataset.tour = "late";
    document.body.append(el);
    await expect(pending).resolves.toBe(el);
  });

  it("gives up after the timeout so the tour can centre the popover", async () => {
    vi.useFakeTimers();
    const pending = waitForTourTarget("never", 500);
    vi.advanceTimersByTime(600);
    await expect(pending).resolves.toBeNull();
    vi.useRealTimers();
  });
});
