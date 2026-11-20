import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// The studio's test environment (vitest.config.ts setupFiles): Testing Library's matchers, a clean
// document after every test, and what happy-dom lacks of what Radix calls (pointer capture,
// scrollIntoView, ResizeObserver). The environment gets them here; the components never do.

function provide(target: object, name: string, value: unknown): void {
  if (!(name in target)) {
    Object.defineProperty(target, name, { value, configurable: true });
  }
}
provide(window.HTMLElement.prototype, "scrollIntoView", () => undefined);
provide(window.HTMLElement.prototype, "hasPointerCapture", () => false);
provide(window.HTMLElement.prototype, "setPointerCapture", () => undefined);
provide(window.HTMLElement.prototype, "releasePointerCapture", () => undefined);
provide(
  globalThis,
  "ResizeObserver",
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
  document.title = "";
});
