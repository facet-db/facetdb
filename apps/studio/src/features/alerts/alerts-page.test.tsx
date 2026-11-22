import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type Alerts, ApiError, type ApplyWritten } from "../../api/index.ts";
import {
  fakeApi,
  renderStudio,
  SAMPLE_ALERT_CHANNELS_IN_FILE,
  SAMPLE_ALERTS,
  SAMPLE_ALERTS_DIFF,
  SAMPLE_GALLERY,
  SAMPLE_PLUGINS,
} from "../../testing/index.ts";

/**
 * The Alerts page's channels on happy-dom with the fake API client: each channel's state, what it
 * sends, its quiet hours in its zone and the newest thing it was sent; a test send and its answer;
 * Add a channel, Edit and Remove through Apply, the diff first, the change in force with no
 * restart; a kind not installed offered as its command; the states the mockup's strip switches (no
 * channel yet, loading, worker not answering, the worker's zone unreadable). Times are the
 * machine's own; "now" is a local afternoon.
 */

/** The afternoon the page is opened in: Friday 6 November 2026, 3 pm on this machine. */
const NOW = new Date(2026, 10, 6, 15, 0);

/** The page with the mockup's channels, ready: the rows are drawn. */
async function opened(api = fakeApi()) {
  const rendered = renderStudio({ path: "/alerts", api, now: NOW });
  await screen.findByRole("article", { name: "Slack #ops" });
  return rendered;
}

/** The dialog the page has open. */
function dialog() {
  return within(screen.getByRole("dialog"));
}

describe("the channel rows (alerts-page)", () => {
  it("draw each channel's state, what it sends, its quiet hours in their zone, and its last delivery", async () => {
    await opened();

    const ops = within(screen.getByRole("article", { name: "Slack #ops" }));
    expect(ops.getByText("Delivering").closest("[data-status]")).toHaveAttribute(
      "data-status",
      "done",
    );
    expect(ops.getByText("Critical and warnings")).toBeInTheDocument();
    expect(
      ops.getByText("22:00 to 07:00, the worker's zone (Africa/Addis_Ababa)"),
    ).toBeInTheDocument();
    // The summary of its quiet hours is newer than its last alert: it is the last thing it was sent.
    expect(ops.getByText("Quiet-hours summary, 7:00 am, delivered")).toBeInTheDocument();

    const email = within(screen.getByRole("article", { name: "Email ops@example.com" }));
    expect(email.getByText("Everything")).toBeInTheDocument();
    expect(email.queryByText("Quiet hours")).toBeNull();
    expect(email.getByText("Backfill finished, 2:10 pm, delivered")).toBeInTheDocument();

    const oncall = within(screen.getByRole("article", { name: "Slack #oncall" }));
    expect(oncall.getByText("Failing").closest("[data-status]")).toHaveAttribute(
      "data-status",
      "error",
    );
    expect(oncall.getByText("Critical only")).toBeInTheDocument();
    // The channel's own words, without the address the row already names.
    expect(
      oncall.getByText(
        "Worker not running, Nov 2, 8:15 am: the app is not in #oncall. Invite it with /invite @your-app.",
      ),
    ).toBeInTheDocument();

    const hook = within(screen.getByRole("article", { name: "Webhook ops" }));
    expect(hook.getByText("Nothing sent yet")).toBeInTheDocument();
    expect(hook.getByText("23:00 to 08:00, Europe/Berlin")).toBeInTheDocument();
    expect(hook.queryByText("Last")).toBeNull();
  });

  it("says a summary tried and not taken yet without calling the channel failing", async () => {
    const [ops, ...rest] = SAMPLE_ALERTS.channels;
    if (ops === undefined) {
      throw new Error("the sample has a first channel");
    }
    const trying: Alerts = {
      ...SAMPLE_ALERTS,
      channels: [
        { ...ops, summary: { at: ops.summary?.at ?? "", sent: false, failing: false } },
        ...rest,
      ],
    };
    await opened(fakeApi({ alerts: () => Promise.resolve(trying) }));
    const row = within(screen.getByRole("article", { name: "Slack #ops" }));
    expect(row.getByText("Quiet-hours summary, 7:00 am, not delivered yet")).toBeInTheDocument();
    expect(row.getByText("Delivering")).toBeInTheDocument();
  });

  it("calls a channel failing once its summary was not taken on the try again past its retry", async () => {
    const [ops, ...rest] = SAMPLE_ALERTS.channels;
    if (ops === undefined) {
      throw new Error("the sample has a first channel");
    }
    const failing: Alerts = {
      ...SAMPLE_ALERTS,
      channels: [
        { ...ops, summary: { at: ops.summary?.at ?? "", sent: false, failing: true } },
        ...rest,
      ],
    };
    await opened(fakeApi({ alerts: () => Promise.resolve(failing) }));
    const row = within(screen.getByRole("article", { name: "Slack #ops" }));
    expect(row.getByText("Quiet-hours summary, 7:00 am, not delivered")).toBeInTheDocument();
    expect(row.getByText("Failing").closest("[data-status]")).toHaveAttribute(
      "data-status",
      "error",
    );
  });

  it("names the channels whose quiet hours held an event in its state", async () => {
    const [first, ...rest] = SAMPLE_ALERTS.events;
    if (first === undefined) {
      throw new Error("the sample has an event");
    }
    const held: Alerts = {
      ...SAMPLE_ALERTS,
      events: [
        { ...first, held: [{ kind: "slack", name: "#ops", address: "slack:#ops" }] },
        ...rest,
      ],
    };
    await opened(fakeApi({ alerts: () => Promise.resolve(held) }));
    const table = screen.getByRole("table", { name: "Alerts, newest first" });
    expect(within(table).getByText("held for Slack #ops (quiet hours)")).toBeInTheDocument();
  });
});

describe("Send a test (alerts-page)", () => {
  it("sends one through the row's channel, says Sending while it is out, then Test sent with the time", async () => {
    let answer: () => void = () => undefined;
    const api = fakeApi({
      testAlertChannel: () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    });
    const { user } = await opened(api);
    const email = within(screen.getByRole("article", { name: "Email ops@example.com" }));

    await user.click(
      email.getByRole("button", { name: "Send a test through Email ops@example.com" }),
    );
    const sending = email.getByRole("button", { name: /^Sending/ });
    expect(sending).toBeDisabled();
    expect(api.calls).toContain("testAlertChannel email:ops@example.com");

    answer();
    expect(await email.findByText("Test sent")).toBeInTheDocument();
    expect(email.getByRole("status")).toHaveTextContent("Test sent3:00 pm");
    expect(email.getByRole("button", { name: /^Send a test/ })).toBeEnabled();
  });

  it("shows the channel's own answer when it refused the test, and never adds the test to the events", async () => {
    const api = fakeApi({
      testAlertChannel: () =>
        Promise.reject(
          new ApiError(
            502,
            "channel_failed",
            "The channel did not take the test message: slack:#oncall was not delivered: the app is not in #oncall; invite it with /invite @your-app.",
            "Check the channel's settings.",
          ),
        ),
    });
    const { user } = await opened(api);
    const table = screen.getByRole("table", { name: "Alerts, newest first" });
    const rowsBefore = within(table).getAllByRole("row").length;
    const oncall = within(screen.getByRole("article", { name: "Slack #oncall" }));

    await user.click(oncall.getByRole("button", { name: /^Send a test/ }));

    expect(await oncall.findByText("Test failed")).toBeInTheDocument();
    expect(oncall.getByRole("status")).toHaveTextContent(
      "3:00 pm: the app is not in #oncall. Invite it with /invite @your-app.",
    );
    expect(within(table).getAllByRole("row")).toHaveLength(rowsBefore);
    expect(document.body.textContent).not.toMatch(/test message/i);
  });

  it("says why nothing was sent when the worker sends no test", async () => {
    const api = fakeApi({
      testAlertChannel: () =>
        Promise.reject(
          new ApiError(
            409,
            "alert_test_unavailable",
            "This worker sends no test message: facetdb worker --once answers what is queued and exits.",
            "Run facetdb worker, then send the test from the Alerts page.",
          ),
        ),
    });
    const { user } = await opened(api);
    const ops = within(screen.getByRole("article", { name: "Slack #ops" }));
    await user.click(ops.getByRole("button", { name: /^Send a test/ }));
    expect(await ops.findByText("Not sent")).toBeInTheDocument();
    expect(ops.getByRole("status")).toHaveTextContent(
      "Run facetdb worker, then send the test from the Alerts page.",
    );
  });
});

describe("Add a channel (alerts-page)", () => {
  it("adds a Slack channel through Apply, the diff first, and says it is in force with no restart", async () => {
    const api = fakeApi();
    const { user } = await opened(api);

    await user.click(screen.getByRole("button", { name: "Add a channel" }));
    expect(screen.getByRole("dialog", { name: "Add a channel" })).toBeInTheDocument();
    expect(await dialog().findByRole("combobox", { name: "Kind" })).toHaveTextContent("Slack");
    // Critical and warnings, as the mockup chooses; the worker's zone by default.
    expect(dialog().getByRole("radio", { name: "Critical and warnings" })).toBeChecked();
    expect(dialog().getByRole("combobox", { name: "Time zone" })).toHaveTextContent(
      "The worker's (Africa/Addis_Ababa)",
    );

    await user.type(dialog().getByRole("textbox", { name: "Channel" }), "#trust-and-safety");
    await user.click(dialog().getByRole("button", { name: "Apply" }));

    expect(
      await screen.findByRole("dialog", { name: "Add Slack #trust-and-safety" }),
    ).toBeInTheDocument();
    expect(
      await dialog().findByText("Writes facetdb.config.ts. In force at once, with no restart."),
    ).toBeInTheDocument();
    // Every channel of the file goes back as the file writes it, the new one at the end.
    expect(api.calls).toContain(
      `applyAlertsDiff ${JSON.stringify({
        channels: [
          ...SAMPLE_ALERT_CHANNELS_IN_FILE,
          { to: "slack:#trust-and-safety", sends: "warnings" },
        ],
      })}`,
    );
    expect(api.calls.some((call) => call.startsWith("applyAlertsWrite"))).toBe(false);

    await user.click(dialog().getByRole("button", { name: "Write facetdb.config.ts" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByText("Written. Slack #trust-and-safety is in force.")).toBeInTheDocument();
    expect(api.calls.find((call) => call.startsWith("applyAlertsWrite"))).toContain(
      '"plan":"plan-alerts","force":false',
    );
    expect(document.body.textContent).not.toMatch(/[Rr]estart the worker/);
  });

  it("goes back from the diff to the form as it was left", async () => {
    const { user } = await opened();
    await user.click(screen.getByRole("button", { name: "Add a channel" }));
    await user.type(await dialog().findByRole("textbox", { name: "Channel" }), "#data");
    await user.click(dialog().getByRole("button", { name: "Apply" }));
    await screen.findByRole("dialog", { name: "Add Slack #data" });
    await user.click(await dialog().findByRole("button", { name: "Back" }));
    expect(dialog().getByRole("textbox", { name: "Channel" })).toHaveValue("#data");
  });

  it("says what is wrong with the form before anything is sent", async () => {
    const api = fakeApi();
    const { user } = await opened(api);
    await user.click(screen.getByRole("button", { name: "Add a channel" }));
    await user.type(await dialog().findByRole("textbox", { name: "From" }), "22:00");
    await user.click(dialog().getByRole("button", { name: "Apply" }));

    expect(dialog().getByText("Channel is needed.")).toBeInTheDocument();
    expect(dialog().getByText("Give both times, or neither.")).toBeInTheDocument();
    // The focus goes to the first field with a problem.
    expect(dialog().getByRole("textbox", { name: "Channel" })).toHaveFocus();
    await user.type(dialog().getByRole("textbox", { name: "Channel" }), "#ops2");
    await user.type(dialog().getByRole("textbox", { name: "To" }), "25:00");
    await user.click(dialog().getByRole("button", { name: "Apply" }));
    expect(dialog().getByText("Write a time as HH:MM, such as 22:00.")).toBeInTheDocument();
    expect(api.calls.some((call) => call.startsWith("applyAlertsDiff"))).toBe(false);
  });

  it("offers a kind whose plugin is not installed as its facetdb add command, not a form", async () => {
    const { user, copied } = await opened();
    await user.click(screen.getByRole("button", { name: "Add a channel" }));
    await user.click(await dialog().findByRole("combobox", { name: "Kind" }));
    await user.click(await screen.findByRole("option", { name: "Telegram (not installed)" }));

    expect(
      dialog().getByText("Telegram is not installed. Run this in the project's folder:"),
    ).toBeInTheDocument();
    expect(dialog().getByText("facetdb add telegram")).toBeInTheDocument();
    expect(dialog().queryByRole("button", { name: "Apply" })).toBeNull();
    expect(dialog().queryByRole("radio")).toBeNull();
    await user.click(dialog().getByRole("button", { name: "Copy facetdb add telegram" }));
    expect(copied).toEqual(["facetdb add telegram"]);
  });

  it("offers only a registry channel whose range holds, with a command built from a short name alone", async () => {
    const [telegram] = SAMPLE_GALLERY.reachable
      ? SAMPLE_GALLERY.plugins.filter((entry) => entry.name === "telegram")
      : [];
    if (telegram === undefined) {
      throw new Error("the sample gallery has telegram");
    }
    const api = fakeApi({
      gallery: () =>
        Promise.resolve({
          reachable: true,
          address: "https://registry.facetdb.dev/index.json",
          plugins: [
            telegram,
            // Made for another FacetDB: `facetdb add` would refuse it.
            { ...telegram, name: "matrix", holds: false },
            // Not a short name: no command is built from it, so it is not offered.
            { ...telegram, name: "pager duty; rm -rf ~" },
          ],
        }),
    });
    const { user } = await opened(api);
    await user.click(screen.getByRole("button", { name: "Add a channel" }));
    await user.click(await dialog().findByRole("combobox", { name: "Kind" }));
    const offered = screen.getAllByRole("option").map((option) => option.textContent);
    expect(offered).toContain("Telegram (not installed)");
    expect(offered.some((words) => words.includes("Matrix"))).toBe(false);
    expect(offered.some((words) => words.includes("rm -rf"))).toBe(false);
  });

  it("asks a webhook for one of the endpoints its settings name", async () => {
    // The built-in webhook with a second endpoint, named and never shown by its address.
    const api = fakeApi({
      plugins: () =>
        Promise.resolve({
          ...SAMPLE_PLUGINS,
          plugins: SAMPLE_PLUGINS.plugins.map((plugin) =>
            plugin.name === "webhook"
              ? {
                  ...plugin,
                  settings: {
                    ...plugin.settings,
                    values: {
                      ...plugin.settings.values,
                      endpoints: { ops: "hooks.example.com", billing: "billing.example.com" },
                    },
                  },
                }
              : plugin,
          ),
        }),
    });
    const { user } = await opened(api);
    await user.click(screen.getByRole("button", { name: "Add a channel" }));
    await user.click(await dialog().findByRole("combobox", { name: "Kind" }));
    await user.click(await screen.findByRole("option", { name: "Webhook" }));

    expect(dialog().getByText("Endpoints are set in facetdb.config.ts.")).toBeInTheDocument();
    // Applied with none chosen: the endpoint is refused, and the focus goes to it.
    await user.click(dialog().getByRole("button", { name: "Apply" }));
    const endpoint = dialog().getByRole("combobox", { name: "Endpoint" });
    expect(endpoint).toHaveFocus();
    expect(endpoint).toHaveAttribute("aria-invalid", "true");
    expect(endpoint).toHaveAccessibleDescription(
      "Endpoints are set in facetdb.config.ts. Endpoint is needed.",
    );
    await user.click(dialog().getByRole("combobox", { name: "Endpoint" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "ops",
      "billing",
    ]);
    // A name of the settings, never the address it holds.
    expect(document.body.textContent).not.toContain("hooks.example.com");
    expect(document.body.textContent).not.toContain("billing.example.com");
    await user.click(screen.getByRole("option", { name: "billing" }));
    await user.click(dialog().getByRole("radio", { name: "Everything" }));
    await user.click(dialog().getByRole("button", { name: "Apply" }));
    await screen.findByRole("dialog", { name: "Add Webhook billing" });
    expect(api.calls).toContain(
      `applyAlertsDiff ${JSON.stringify({
        channels: [...SAMPLE_ALERT_CHANNELS_IN_FILE, "webhook:billing"],
      })}`,
    );
  });

  it("shows the loader's refusal of the draft, with Back to the form", async () => {
    const api = fakeApi({
      applyAlertsDiff: () =>
        Promise.reject(
          new ApiError(
            400,
            "invalid_draft",
            "The draft has problems: alerts.channels[4]: slack:#nowhere has no way to reach Slack. Nothing was written.",
            "Fix each field named, then apply again.",
          ),
        ),
    });
    const { user } = await opened(api);
    await user.click(screen.getByRole("button", { name: "Add a channel" }));
    await user.type(await dialog().findByRole("textbox", { name: "Channel" }), "#nowhere");
    await user.click(dialog().getByRole("button", { name: "Apply" }));
    expect(await dialog().findByRole("alert")).toHaveTextContent(
      "slack:#nowhere has no way to reach Slack",
    );
    expect(dialog().queryByRole("button", { name: /^Write/ })).toBeNull();
    expect(dialog().getByRole("button", { name: "Back" })).toBeEnabled();
  });

  it("says in the reload's words when the written channels could not be put in force", async () => {
    const kept: ApplyWritten = {
      written: true,
      path: "facetdb.config.ts",
      diff: SAMPLE_ALERTS_DIFF.diff,
      reload: {
        loaded: false,
        message:
          "facetdb.config.ts loads, but the alert channels it names cannot be put in force: the plugin slack is not installed, so the worker keeps running on the config it had.",
        fix: "Run facetdb add slack; then apply again, or Check again.",
      },
    };
    const api = fakeApi({ applyAlertsWrite: () => Promise.resolve(kept) });
    const { user } = await opened(api);
    await user.click(screen.getByRole("button", { name: "Add a channel" }));
    await user.type(await dialog().findByRole("textbox", { name: "Channel" }), "#x");
    await user.click(dialog().getByRole("button", { name: "Apply" }));
    await user.click(await dialog().findByRole("button", { name: "Write facetdb.config.ts" }));

    const alert = await dialog().findByRole("alert");
    expect(alert).toHaveTextContent("the worker keeps the channels it had");
    expect(alert).toHaveTextContent("Run facetdb add slack; then apply again, or Check again.");
    expect(screen.queryByText(/is in force/)).toBeNull();
  });

  it("is complete by keyboard: open, fill, apply and write without a pointer", async () => {
    const api = fakeApi();
    const { user } = await opened(api);
    screen.getByRole("button", { name: "Add a channel" }).focus();
    await user.keyboard("{Enter}");
    const where = await dialog().findByRole("textbox", { name: "Channel" });
    where.focus();
    await user.keyboard("#night");
    // Enter in a field applies the form.
    await user.keyboard("{Enter}");
    const write = await dialog().findByRole("button", { name: "Write facetdb.config.ts" });
    write.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Written. Slack #night is in force.")).toBeInTheDocument();
  });
});

describe("Edit and Remove (alerts-page)", () => {
  it("opens a channel's form with its settings and writes only what changed", async () => {
    const api = fakeApi();
    const { user } = await opened(api);
    const ops = within(screen.getByRole("article", { name: "Slack #ops" }));
    await user.click(ops.getByRole("button", { name: "Edit Slack #ops" }));

    expect(screen.getByRole("dialog", { name: "Edit Slack #ops" })).toBeInTheDocument();
    // The kind is fixed: no choice of it.
    expect(dialog().queryByRole("combobox", { name: "Kind" })).toBeNull();
    expect(await dialog().findByRole("textbox", { name: "Channel" })).toHaveValue("#ops");
    expect(dialog().getByRole("radio", { name: "Critical and warnings" })).toBeChecked();
    expect(dialog().getByRole("textbox", { name: "From" })).toHaveValue("22:00");
    expect(dialog().getByRole("textbox", { name: "To" })).toHaveValue("07:00");

    await user.clear(dialog().getByRole("textbox", { name: "From" }));
    await user.type(dialog().getByRole("textbox", { name: "From" }), "23:00");
    await user.click(dialog().getByRole("button", { name: "Apply" }));

    expect(await screen.findByRole("dialog", { name: "Change Slack #ops" })).toBeInTheDocument();
    const [, ...others] = SAMPLE_ALERT_CHANNELS_IN_FILE;
    expect(api.calls).toContain(
      `applyAlertsDiff ${JSON.stringify({
        channels: [
          { to: "slack:#ops", sends: "warnings", quiet: { from: "23:00", to: "07:00" } },
          ...others,
        ],
      })}`,
    );
    await user.click(await dialog().findByRole("button", { name: "Write facetdb.config.ts" }));
    expect(
      await screen.findByText("Written. Slack #ops's changes are in force."),
    ).toBeInTheDocument();
  });

  it("keeps a channel's quiet hours in its own zone, and takes them out when both times are cleared", async () => {
    const api = fakeApi();
    const { user } = await opened(api);
    const hook = within(screen.getByRole("article", { name: "Webhook ops" }));
    await user.click(hook.getByRole("button", { name: "Edit Webhook ops" }));
    expect(await dialog().findByRole("combobox", { name: "Time zone" })).toHaveTextContent(
      "Europe/Berlin",
    );
    await user.clear(dialog().getByRole("textbox", { name: "From" }));
    await user.clear(dialog().getByRole("textbox", { name: "To" }));
    await user.click(dialog().getByRole("button", { name: "Apply" }));
    await screen.findByRole("dialog", { name: "Change Webhook ops" });
    const call = api.calls.find((each) => each.startsWith("applyAlertsDiff")) ?? "";
    expect(call).toContain('{"to":"webhook:ops","sends":"warnings"}');
  });

  it("removes a channel from Edit, the diff first", async () => {
    const api = fakeApi();
    const { user } = await opened(api);
    const ops = within(screen.getByRole("article", { name: "Slack #ops" }));
    await user.click(ops.getByRole("button", { name: "Edit Slack #ops" }));
    await user.click(await dialog().findByRole("button", { name: "Remove" }));

    expect(await screen.findByRole("dialog", { name: "Remove Slack #ops" })).toBeInTheDocument();
    const [, ...others] = SAMPLE_ALERT_CHANNELS_IN_FILE;
    expect(api.calls).toContain(`applyAlertsDiff ${JSON.stringify({ channels: others })}`);
    await user.click(await dialog().findByRole("button", { name: "Write facetdb.config.ts" }));
    expect(await screen.findByText("Written. Slack #ops is removed.")).toBeInTheDocument();
  });

  it("takes alerts out of the file when the last channel is removed", async () => {
    const [ops] = SAMPLE_ALERTS.channels;
    const [entry] = SAMPLE_ALERT_CHANNELS_IN_FILE;
    if (ops === undefined || entry === undefined) {
      throw new Error("the samples have a first channel");
    }
    const api = fakeApi({
      alerts: () => Promise.resolve({ ...SAMPLE_ALERTS, channels: [ops] }),
      alertChannelsInFile: () => Promise.resolve([entry]),
    });
    const { user } = await opened(api);
    await user.click(screen.getByRole("button", { name: "Edit Slack #ops" }));
    await user.click(await dialog().findByRole("button", { name: "Remove" }));
    await screen.findByRole("dialog", { name: "Remove Slack #ops" });
    expect(api.calls).toContain("applyAlertsDiff null");
  });
});

describe("the page's states (alerts-page)", () => {
  it("reads the channels and the history, with Add a channel at hand", async () => {
    const api = fakeApi({ alerts: () => new Promise<Alerts>(() => undefined) });
    renderStudio({ path: "/alerts", api, now: NOW });
    expect(await screen.findByText("Reading the channels.")).toBeInTheDocument();
    expect(screen.getByText("Reading the alert history.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a channel" })).toBeInTheDocument();
  });

  it("says the worker is not answering, with no action on what it cannot read", async () => {
    const api = fakeApi({ alerts: () => Promise.reject(new TypeError("Failed to fetch")) });
    renderStudio({ path: "/alerts", api, now: NOW });
    // Network trouble is asked twice more first (studio.tsx), a second and two apart.
    const notice = await screen.findByRole("alert", {}, { timeout: 10_000 });
    expect(notice).toHaveTextContent("The channels and the alert history could not be read.");
    expect(notice).toHaveTextContent("The studio cannot reach the worker.");
    expect(screen.queryByRole("button", { name: "Add a channel" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Channels" })).toBeNull();
  }, 15_000);

  it("asks for a zone when the worker's cannot be read", async () => {
    const api = fakeApi({
      alerts: () =>
        Promise.resolve({
          ...SAMPLE_ALERTS,
          workerZone: null,
          channels: SAMPLE_ALERTS.channels.filter((channel) => channel.quiet?.zone !== null),
        }),
    });
    const { user } = renderStudio({ path: "/alerts", api, now: NOW });
    await screen.findByRole("article", { name: "Webhook ops" });
    await user.click(screen.getByRole("button", { name: "Add a channel" }));

    expect(
      await dialog().findByText(
        "The worker's time zone cannot be read, so quiet hours need a zone chosen here.",
      ),
    ).toBeInTheDocument();
    expect(dialog().getByRole("combobox", { name: "Time zone" })).toHaveTextContent(
      "Choose a zone",
    );
    await user.type(dialog().getByRole("textbox", { name: "Channel" }), "#night");
    await user.type(dialog().getByRole("textbox", { name: "From" }), "22:00");
    await user.type(dialog().getByRole("textbox", { name: "To" }), "07:00");
    await user.click(dialog().getByRole("button", { name: "Apply" }));
    expect(dialog().getByText("Choose a zone: the worker's cannot be read.")).toBeInTheDocument();
    // The zone is the only field refused: the focus goes to it, marked and described by why.
    const zone = dialog().getByRole("combobox", { name: "Time zone" });
    expect(zone).toHaveFocus();
    expect(zone).toHaveAttribute("aria-invalid", "true");
    expect(zone).toHaveAccessibleDescription("Choose a zone: the worker's cannot be read.");
    expect(api.calls.some((call) => call.startsWith("applyAlertsDiff"))).toBe(false);
  });

  it("asks for Check again first, and drafts nothing, while the file names other channels", async () => {
    const api = fakeApi({
      alerts: () => Promise.resolve({ ...SAMPLE_ALERTS, fileChannelsDiffer: true }),
    });
    const { user } = await opened(api);
    for (const open of ["Add a channel", "Edit Slack #ops"]) {
      await user.click(screen.getByRole("button", { name: open }));
      expect(
        await dialog().findByText(
          "facetdb.config.ts names other channels than the ones in force: press Check again first.",
        ),
      ).toBeInTheDocument();
      expect(dialog().queryByRole("button", { name: "Apply" })).toBeNull();
      expect(dialog().queryByRole("button", { name: "Remove" })).toBeNull();
      await user.click(dialog().getByRole("button", { name: "Close" }));
    }
    expect(api.calls.some((call) => call.startsWith("applyAlerts"))).toBe(false);
  });
});
