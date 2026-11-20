import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, SHELL_REFRESH_MS } from "../api/index.ts";
import { returnPath, STUDIO_ROUTES } from "../routes/index.ts";
import { createStudio } from "../studio.tsx";
import {
  fakeApi,
  fakeMedia,
  fakeScheduler,
  memoryStorage,
  renderStudio,
  SAMPLE_HOME,
  STUDIO_ORIGIN,
  signInRequired,
} from "../testing/index.ts";
import { PHONE_QUERY } from "./media.ts";
import { PROJECT_HINT } from "./Rail.tsx";
import { THEME_KEY } from "./theme.tsx";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The studio's shell on happy-dom with the fake API client: the rail with the eight pages in their
 * order and the current one marked, the review count, the project listbox, the instrument, the
 * theme switch remembered across a reload, the phone's top bar and drawer, and the sign-in page on
 * a `sign-in` answer.
 */

const SPEC_ORDER = [
  "Home",
  "Sources",
  "Questions",
  "Review",
  "Decisions",
  "Plugins",
  "Alerts",
  "Settings",
];

async function pages() {
  return within(await screen.findByRole("navigation", { name: "Pages" })).getAllByRole("link");
}

/** The link's own words, without the review count beside it. */
function pageName(link: HTMLElement): string {
  return link.querySelector("span")?.textContent ?? "";
}

describe("the rail", () => {
  it("lists the eight pages in their order and marks the one open", async () => {
    renderStudio({ path: "/review" });

    const links = await pages();
    expect(links.map(pageName)).toEqual(SPEC_ORDER);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/",
      "/sources",
      "/questions",
      "/review",
      "/decisions",
      "/plugins",
      "/alerts",
      "/settings",
    ]);
    const current = links.filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map(pageName)).toEqual(["Review"]);
    expect(await screen.findByRole("heading", { level: 1, name: "Review" })).toBeInTheDocument();
  });

  it("marks Home on its own path only, and a page on the paths under it", async () => {
    const cases = [
      ["/", "Home"],
      ["/sources/new", "Sources"],
      ["/decisions/listings/L-2207", "Decisions"],
    ] as const;
    for (const [path, page] of cases) {
      const view = renderStudio({ path });
      const current = (await pages()).filter(
        (link) => link.getAttribute("aria-current") === "page",
      );
      expect(current.map(pageName), path).toEqual([page]);
      view.unmount();
    }
  });

  it("opens each page with its title as the rail's links are followed", async () => {
    const { user } = renderStudio();
    for (const title of SPEC_ORDER) {
      const link = (await pages()).find((one) => pageName(one) === title);
      if (link === undefined) {
        throw new Error(`the rail has no link to ${title}`);
      }
      await user.click(link);
      expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
      expect(link).toHaveAttribute("aria-current", "page");
      expect(document.title).toBe(`${title} · FacetDB`);
    }
  });

  it("opens the setup flow and the why page inside the shell", async () => {
    renderStudio({ path: "/sources/new" });
    expect(await screen.findByRole("heading", { level: 1, name: "Add a source" })).toBeVisible();
    const why = renderStudio({ path: "/decisions/listings/maya%40example.com" });
    expect(
      await within(why.container).findByText(/The history of maya@example.com in listings/),
    ).toBeVisible();
  });

  it("shows the review count beside Review as words in the text color, after the review square", async () => {
    renderStudio();
    const review = await screen.findByRole("link", { name: "Review 37 waiting" });
    const count = within(review).getByText("37");
    // The number is never set in the status color (it passes 3:1 only on paper): the square is.
    expect(count.parentElement).toHaveClass("text-text");
    expect(count.parentElement?.querySelector(".bg-review")).not.toBeNull();
  });

  it("shows no count when nobody's cards wait", async () => {
    const api = fakeApi({
      reviewQueue: () =>
        Promise.resolve({ count: 0, oldestSince: null, oldestWaitMs: null, cards: [] }),
    });
    renderStudio({ api });
    await waitFor(() => {
      expect(api.calls).toContain("reviewQueue");
    });
    expect(await screen.findByRole("link", { name: "Review" })).toBeVisible();
  });

  it("names the one project in its listbox, with the line on how another opens", async () => {
    renderStudio();
    const project = await screen.findByRole("combobox", { name: "Project" });
    expect(project).toHaveTextContent("marketplace");
    expect(project).toHaveAccessibleDescription(PROJECT_HINT);
  });

  it("carries the worker's heartbeat and the month's spending at its foot", async () => {
    renderStudio();
    const foot = await screen.findByRole("region", { name: "Worker and spending" });
    expect(await within(foot).findByText("Worker beating, 2 s ago")).toBeVisible();
    expect(within(foot).getByText("$3.20 of $25")).toBeVisible();
    expect(
      within(foot).getByRole("img", {
        name: "13% of the $25 monthly cap. The project pauses at 100%.",
      }),
    ).toBeInTheDocument();
  });

  it("says when the worker could not be read, rather than showing nothing", async () => {
    // A refusal in the surface's words is not retried, so no timer runs.
    const failing = new ApiError(500, "internal_error", "Something went wrong.", "Try again.");
    renderStudio({ api: fakeApi({ home: () => Promise.reject(failing) }) });
    const foot = await screen.findByRole("region", { name: "Worker and spending" });
    expect(await within(foot).findByText("Not known: the worker cannot be reached")).toBeVisible();
  });

  it("does not call the worker beating once a refresh fails, even with an earlier answer in the cache", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let failing = false;
    const api = fakeApi({
      home: () =>
        failing
          ? Promise.reject(
              new ApiError(500, "internal_error", "Something went wrong.", "Try again."),
            )
          : Promise.resolve(SAMPLE_HOME),
    });
    renderStudio({ api });
    const foot = await screen.findByRole("region", { name: "Worker and spending" });
    expect(await within(foot).findByText("Worker beating, 2 s ago")).toBeVisible();

    failing = true;
    await vi.advanceTimersByTimeAsync(SHELL_REFRESH_MS);
    expect(await within(foot).findByText("Not known: the worker cannot be reached")).toBeVisible();
    expect(within(foot).queryByText("Worker beating, 2 s ago")).toBeNull();
    expect(within(foot).queryByText("$3.20 of $25")).toBeNull();
    expect(within(foot).getByText("Not known")).toBeVisible();

    failing = false;
    await vi.advanceTimersByTimeAsync(SHELL_REFRESH_MS);
    expect(await within(foot).findByText("Worker beating, 2 s ago")).toBeVisible();
  });
});

describe("the theme switch", () => {
  it("flips data-theme on the root and keeps the choice across a reload", async () => {
    const storage = memoryStorage();
    const first = renderStudio({ storage: () => storage });

    await first.user.click(
      await screen.findByRole("button", { name: "Switch to the light theme" }),
    );
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(storage.data.get(THEME_KEY)).toBe("light");
    expect(screen.getByRole("button", { name: "Switch to the dark theme" })).toHaveTextContent(
      "Dark theme",
    );

    // A reload: a new page over the same storage, the attribute gone with the old document.
    first.unmount();
    document.documentElement.removeAttribute("data-theme");
    renderStudio({ storage: () => storage });
    expect(await screen.findByRole("button", { name: "Switch to the dark theme" })).toBeVisible();
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    await first.user.click(screen.getByRole("button", { name: "Switch to the dark theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(storage.data.get(THEME_KEY)).toBe("dark");
  });

  it("starts from the system's preference and sets nothing until switched", async () => {
    renderStudio({ light: true });
    expect(await screen.findByRole("button", { name: "Switch to the dark theme" })).toBeVisible();
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });

  it("still switches where the browser refuses storage, as a private window does", async () => {
    const refusing = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    const { user } = renderStudio({ storage: refusing });
    await user.click(await screen.findByRole("button", { name: "Switch to the light theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});

describe("on a phone", () => {
  it("puts the brand, the project and a menu button in a top bar, and the pages behind the button", async () => {
    renderStudio({ phone: true, path: "/questions" });
    const menu = await screen.findByRole("button", { name: "Menu" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
    expect(await screen.findByRole("combobox", { name: "Project" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "Questions" })).toBeVisible();
  });

  it("opens the drawer with the pages, the instrument and the theme switch; Escape closes it", async () => {
    const { user } = renderStudio({ phone: true, path: "/questions" });
    const menu = await screen.findByRole("button", { name: "Menu" });

    await user.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(menu).toHaveAccessibleName("Close the menu");
    expect((await pages()).map(pageName)).toEqual(SPEC_ORDER);
    expect(screen.getByRole("region", { name: "Worker and spending" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Switch to the light theme" })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(menu).toHaveFocus();
  });

  it("closes the drawer when a page is chosen, and opens that page", async () => {
    const { user } = renderStudio({ phone: true });
    await user.click(await screen.findByRole("button", { name: "Menu" }));
    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("turns into the rail when the screen grows past a phone's", async () => {
    const view = renderStudio({ phone: true });
    expect(await screen.findByRole("button", { name: "Menu" })).toBeVisible();
    act(() => {
      view.media.set(PHONE_QUERY, false);
    });
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
    expect(await screen.findByRole("navigation", { name: "Pages" })).toBeVisible();
  });
});

describe("signing in", () => {
  it("shows the sign-in page when the API answers sign-in, and returns to the page once signed in", async () => {
    let signedIn = false;
    const guarded =
      <T,>(answer: () => Promise<T>) =>
      () =>
        signedIn ? answer() : Promise.reject(signInRequired());
    const base = fakeApi();
    const api = fakeApi({
      project: guarded(() => base.project()),
      reviewQueue: guarded(() => base.reviewQueue()),
      home: guarded(() => base.home()),
      signIn: (name) => {
        signedIn = true;
        return base.signIn(name, "");
      },
    });
    const { user, history } = renderStudio({ api, path: "/review" });

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    expect(history.location.pathname).toBe("/sign-in");
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();

    await user.type(screen.getByLabelText("Name"), "maya");
    await user.type(screen.getByLabelText("Password"), "a long enough password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Review" })).toBeVisible();
    expect(history.location.pathname).toBe("/review");
    expect(api.calls).toContain("signIn maya");
    expect(await screen.findByRole("link", { name: "Review 37 waiting" })).toBeVisible();
  });

  it("says what was wrong and what to do when the name and password do not match", async () => {
    const api = fakeApi({
      project: () => Promise.reject(signInRequired()),
      signIn: () =>
        Promise.reject(
          new ApiError(
            401,
            "invalid-credentials",
            "That name and password do not match a reviewer account.",
            "Check both, or ask whoever runs this studio to run `facetdb users add <name>` for you.",
          ),
        ),
    });
    const { user } = renderStudio({ api, path: "/sign-in" });
    await user.type(await screen.findByLabelText("Name"), "maya");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That name and password do not match a reviewer account.");
    expect(alert).toHaveTextContent("ask whoever runs this studio");
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  });

  it("keeps a return path of this studio, its query and hash included", () => {
    for (const path of ["/", "/review", "/decisions/listings/L-2207?from=search#history"]) {
      expect(returnPath(path, STUDIO_ORIGIN), path).toBe(path);
    }
  });

  it("refuses a return path a URL parser could turn into another site, or that is not a path", () => {
    for (const next of [
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "/ /evil.example",
      "/\u007f/evil.example",
      "/\\evil.example",
      "/\\/evil.example",
      "//evil.example",
      "https://evil.example/",
      "javascript:alert(1)",
      "review",
      "/sign-in?next=/review",
      42,
      undefined,
    ]) {
      expect(returnPath(next, STUDIO_ORIGIN), JSON.stringify(next)).toBeUndefined();
    }
  });

  it("refuses a path that resolves off the page's origin even when its text looks plain", () => {
    // The origin check stands on its own: a page with an opaque origin goes back nowhere.
    expect(returnPath("/review", "http://127.0.0.1:4040")).toBe("/review");
    expect(returnPath("/review", "null")).toBeUndefined();
  });

  it("goes back only to a path of this studio, never to another site", async () => {
    let signedIn = false;
    const api = fakeApi({
      project: () => (signedIn ? fakeApi().project() : Promise.reject(signInRequired())),
      signIn: (name) => {
        signedIn = true;
        return fakeApi().signIn(name, "");
      },
    });
    const { user, history } = renderStudio({
      api,
      path: "/sign-in?next=%2F%2Fevil.example%2Fsteal",
    });
    await user.type(await screen.findByLabelText("Name"), "maya");
    await user.type(screen.getByLabelText("Password"), "a long enough password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(history.location.pathname).toBe("/");
    });
  });
});

describe("the routes", () => {
  it("are exactly the paths the build lists in routes.json for the worker", () => {
    const { router } = createStudio({
      api: fakeApi(),
      storage: () => memoryStorage(),
      media: fakeMedia({}).media,
      schedule: fakeScheduler(),
      origin: STUDIO_ORIGIN,
      clipboard: () => Promise.resolve(),
    });
    const paths = Object.keys(router.routesByPath)
      .map((path) => (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path))
      .sort();
    expect(paths).toEqual([...STUDIO_ROUTES].sort());
  });
});
