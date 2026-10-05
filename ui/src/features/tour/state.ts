/** Persisted tour state. Pure functions over a Storage, so the first-visit rules are unit-testable. */

export const TOUR_STORAGE_KEY = "rote.tour.v1";

export type TourStatus = "completed" | "dismissed";

/** `window.localStorage` itself throws when site data is blocked. */
export function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Storage can be missing or throw (private windows, blocked site data); the tour must never break the page. */
export function readTourStatus(storage: Pick<Storage, "getItem"> | undefined): TourStatus | null {
  try {
    const value = storage?.getItem(TOUR_STORAGE_KEY);
    return value === "completed" || value === "dismissed" ? value : null;
  } catch {
    return null;
  }
}

export function writeTourStatus(storage: Pick<Storage, "setItem"> | undefined, status: TourStatus): void {
  try {
    storage?.setItem(TOUR_STORAGE_KEY, status);
  } catch {
    /* not persisted: the tour may be offered again next visit, which is harmless */
  }
}

/**
 * Offer the tour on a first visit that lands on the landing page. Deep links never get it: an operator
 * who follows an intervention link to /runs/<id> needs the live session, not a product tour.
 */
export function shouldOfferTour(pathname: string, status: TourStatus | null): boolean {
  return status === null && pathname === "/";
}

/** The first *visible* element marked `data-tour={id}` (desktop and mobile layouts may both carry one). */
export function findTourTarget(id: string, root: ParentNode = document): HTMLElement | null {
  const candidates = root.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(id)}"]`);
  for (const element of candidates) {
    if (element.getClientRects().length > 0) return element;
  }
  return null;
}

/** Resolve when the target exists (pages render after navigation and data loads), or after `timeoutMs`. */
export function waitForTourTarget(id: string | undefined, timeoutMs = 4000): Promise<HTMLElement | null> {
  if (!id) return Promise.resolve(null);
  const found = findTourTarget(id);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const element = findTourTarget(id);
      if (element) {
        cleanup();
        resolve(element);
      }
    });
    const timer = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    function cleanup() {
      observer.disconnect();
      window.clearTimeout(timer);
    }
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
}
