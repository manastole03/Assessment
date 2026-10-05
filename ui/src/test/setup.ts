import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom lacks the layout and media APIs that motion, Radix and the tour use; provide inert stand-ins.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn((query: string) => ({
    matches: query.includes("reduce"), // tests run with reduced motion, like a careful user would
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

class InertObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}
window.IntersectionObserver = InertObserver as unknown as typeof IntersectionObserver;
window.ResizeObserver = InertObserver;

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
