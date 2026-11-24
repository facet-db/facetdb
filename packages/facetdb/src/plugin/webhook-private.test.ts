import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPrivateAddress, isPrivateHost, type NewAction, type NewWebhook } from "@facetdb/server";
import { afterAll, describe, expect, it } from "vitest";
import {
  configFileSource,
  env,
  facetdb,
  fromProjectJson,
  loadConfig,
  noul,
  type ProjectConfig,
  planApply,
  toProjectJson,
  webhook,
} from "../config/index.ts";
import { VERSION } from "../index.ts";
import {
  actionSteps,
  BUILTIN_PLUGINS,
  bindChannels,
  checkActions,
  checkChannels,
  checkSourceActions,
  createPluginHost,
  draftPlugins,
  endpointProblem,
  PluginHostError,
  WEBHOOK_PLUGIN,
  webhookAllowsPrivate,
  webhookRefusal,
  withOutbox,
} from "./index.ts";

/**
 * A webhook to a private address is refused at load unless the config allows it: an endpoint in
 * `plugins.webhook.endpoints`, a `webhook({ url })` and its `else`, whose host is an address on
 * this machine or a private network in any spelling the URL parser reads, or `localhost`, a name
 * under it or under another private suffix, or a name of one label, is refused in words naming the
 * host and the fix, `allowPrivate: true` beside the url.
 *
 * The main path is a config file written as users write it, read by `loadConfig`, then the plugin
 * host and the action and channel checks `facetdb worker`, `studio`, `dev` and doctor run on it
 * (`loadWorkerConfig`). A webhook's address is always written in the file (a variable there is
 * refused), so the address is known once the file is read. What load cannot see, a public name that
 * resolves to a private address or a receiver that redirects to one, is judged at the send; the
 * last tests here pin that a name is not judged by what it resolves to.
 */

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV = { FACETDB_WEBHOOK_SECRET: "whsec_webhook-private-test" };
/** The path and query every address carries: no refusal may quote either. */
const TAIL = "/hook/s3cret-path?token=s3cret-token";
const SECRET_PARTS = ["s3cret", "/hook", "token="];

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The words a private address is refused in, naming its host as the URL parser reads it. */
function privateWords(host: string, written: "endpoint" | "action"): string {
  const fix =
    written === "action"
      ? 'webhook({ url: "…", allowPrivate: true })'
      : '{ url: "…", allowPrivate: true }';
  return `${host} is on this machine or a private network: if the receiver is yours, write ${fix}`;
}

/** What a written address is, after `https://` and before the path: the forms a reviewer tries. */
const PRIVATE: readonly (readonly [written: string, host: string, form: string])[] = [
  ["127.0.0.1", "127.0.0.1", "loopback"],
  ["127.1", "127.0.0.1", "short IPv4"],
  ["2130706433", "127.0.0.1", "decimal IPv4"],
  ["0177.0.0.1", "127.0.0.1", "octal IPv4"],
  ["0x7f.0.0.1", "127.0.0.1", "hex IPv4"],
  ["0x7f000001", "127.0.0.1", "one hex number"],
  ["127.0.0.1.", "127.0.0.1", "trailing dot"],
  ["%31%32%37.0.0.1", "127.0.0.1", "percent-encoded"],
  ["１２７.０.０.１", "127.0.0.1", "full-width digits"],
  ["127.255.255.254", "127.255.255.254", "loopback, top of 127/8"],
  ["0.0.0.0", "0.0.0.0", "this host"],
  ["0", "0.0.0.0", "0 as a number"],
  ["10.0.0.5", "10.0.0.5", "private 10/8"],
  ["100.64.0.1", "100.64.0.1", "carrier-grade NAT"],
  ["169.254.169.254", "169.254.169.254", "cloud metadata"],
  ["169.254.169.254.", "169.254.169.254", "cloud metadata, trailing dot"],
  ["172.16.0.1", "172.16.0.1", "private 172.16/12"],
  ["172.31.255.255", "172.31.255.255", "private 172.16/12, top"],
  ["192.0.0.8", "192.0.0.8", "IETF 192.0.0/24"],
  ["192.168.1.10", "192.168.1.10", "private 192.168/16"],
  ["198.18.0.1", "198.18.0.1", "benchmarking"],
  ["224.0.0.1", "224.0.0.1", "multicast"],
  ["240.0.0.1", "240.0.0.1", "reserved"],
  ["255.255.255.255", "255.255.255.255", "broadcast"],
  ["[::]", "[::]", "IPv6 unspecified"],
  ["[::1]", "[::1]", "IPv6 loopback"],
  ["[0:0:0:0:0:0:0:1]", "[::1]", "IPv6 loopback, long form"],
  ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "IPv4-mapped loopback"],
  ["[::ffff:169.254.169.254]", "[::ffff:a9fe:a9fe]", "IPv4-mapped metadata"],
  ["[::FFFF:A00:5]", "[::ffff:a00:5]", "IPv4-mapped, hex, upper case"],
  ["[::127.0.0.1]", "[::7f00:1]", "IPv4-compatible"],
  ["[::ffff:0:a00:5]", "[::ffff:0:a00:5]", "IPv4-translated"],
  ["[64:ff9b::a9fe:a9fe]", "[64:ff9b::a9fe:a9fe]", "NAT64 of the metadata address"],
  ["[64:ff9b:1::1]", "[64:ff9b:1::1]", "NAT64 for local use"],
  ["[2002:a9fe:a9fe::1]", "[2002:a9fe:a9fe::1]", "6to4 of the metadata address"],
  ["[2001:0:4136:e378:8000:63bf:80ff:fffe]", "[2001:0:4136:e378:8000:63bf:80ff:fffe]", "Teredo"],
  ["[fc00::1]", "[fc00::1]", "unique local"],
  ["[fd12:3456:789a::1]", "[fd12:3456:789a::1]", "unique local fd"],
  ["[fe80::1]", "[fe80::1]", "link-local"],
  ["[fec0::1]", "[fec0::1]", "site-local"],
  ["[ff02::1]", "[ff02::1]", "multicast"],
  ["localhost", "localhost", "localhost"],
  ["LOCALHOST", "localhost", "localhost, upper case"],
  ["localhost.", "localhost.", "localhost, trailing dot"],
  ["%6c%6f%63%61%6c%68%6f%73%74", "localhost", "localhost, percent-encoded"],
  ["api.localhost", "api.localhost", "a name under localhost"],
  ["Api.LocalHost.", "api.localhost.", "a name under localhost, mixed case and a dot"],
  ["metadata.google.internal", "metadata.google.internal", "the metadata service's name"],
  ["printer.local", "printer.local", "an mDNS name"],
  ["router.home.arpa", "router.home.arpa", "a home network name"],
  ["kubernetes.default.svc", "kubernetes.default.svc", "a Kubernetes service name"],
  ["nas.lan", "nas.lan", "a .lan name"],
  ["printer.home", "printer.home", "a .home name"],
  ["wiki.corp", "wiki.corp", "a .corp name"],
  ["hr.intranet", "hr.intranet", "an .intranet name"],
  ["metadata", "metadata", "a name of one label"],
];

/** Addresses and names load lets through: public, or just outside a private range. */
const PUBLIC: readonly string[] = [
  "https://hooks.example.com/facetdb",
  "https://HOOKS.Example.com./facetdb",
  "https://8.8.8.8/hook",
  "https://172.32.0.1/hook",
  "https://100.128.0.1/hook",
  "https://169.255.0.1/hook",
  "https://192.0.1.1/hook",
  "https://192.169.0.1/hook",
  "https://[2606:4700::1111]/hook",
  "https://[::ffff:8.8.8.8]/hook",
  "https://[64:ff9b::808:808]/hook",
  "https://localhost.example.com/hook",
  "https://internal.example.com/hook",
  "https://svc.example.com/hook",
  "https://lan.example.com/hook",
  "https://home.example.com/hook",
  "https://corp.example.com/hook",
  "https://intranet.example.com/hook",
  "https://hooks.example.svc.example.com/hook",
];

/**
 * A config file as users write it: the webhook's settings with `endpoints` (when given), the
 * alert channels, and one source per action (one source with none when no action is given).
 */
function configText(
  endpoints: string,
  actions: readonly string[],
  channels: readonly string[] = [],
): string {
  const source = (index: number, call: string | undefined) => `    {
      name: "s${index}",
      api: true,
      read: ["subject"],
      questions: { urgent: noul("Is this ticket urgent?") },
      actions: [${call ?? ""}],
    },`;
  const sources =
    actions.length === 0 ? [source(0, undefined)] : actions.map((call, at) => source(at, call));
  const settings = endpoints === "" ? "" : `, endpoints: { ${endpoints} }`;
  const alerts =
    channels.length === 0 ? "" : `\n  alerts: { channels: ${JSON.stringify(channels)} },`;
  return `import { actionCall, env, facetdb, noul, webhook } from "facetdb";

export default facetdb({
  model: "jev-1.14.0",${alerts}
  plugins: { webhook: { secret: env("FACETDB_WEBHOOK_SECRET")${settings} } },
  sources: [
${sources.join("\n")}
  ],
});
`;
}

/** An outbox that records where each webhook it is handed would go. */
function recordingOutbox(queued: string[]) {
  return {
    enqueue: (entry: NewWebhook | NewAction) => {
      queued.push("endpoint" in entry ? entry.endpoint : "an action row");
      return Promise.resolve("1");
    },
  };
}

/** Writes `text` as facetdb.config.ts in a fresh project and reads it with the real loader. */
async function loaded(text: string): Promise<ProjectConfig> {
  const dir = await mkdtemp(join(tmpdir(), "facetdb-webhook-private-"));
  scratch.push(dir);
  await mkdir(join(dir, "node_modules"));
  await symlink(packageDir, join(dir, "node_modules", "facetdb"));
  await writeFile(join(dir, "facetdb.config.ts"), text);
  const { config } = await loadConfig("facetdb.config.ts", {
    projectDir: dir,
    env: ENV,
    stderr: { write: () => true },
    quiet: true,
  });
  return config;
}

function hostFor(config: ProjectConfig) {
  return createPluginHost({
    config,
    env: ENV,
    projectDir: "/work/app",
    coreVersion: VERSION,
    importModule: (specifier) =>
      Promise.reject(
        Object.assign(new Error(`Cannot find package '${specifier}'`), {
          code: "ERR_MODULE_NOT_FOUND",
        }),
      ),
    builtins: BUILTIN_PLUGINS,
  });
}

/** What `loadWorkerConfig` runs after the loader: the host, then every action and channel. */
async function workerLoad(config: ProjectConfig): Promise<void> {
  const host = await hostFor(config);
  checkActions(config, host, ENV);
  checkChannels(config, host, ENV);
}

async function refusalOf(run: Promise<unknown>): Promise<PluginHostError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof PluginHostError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the config to be refused at load");
}

function quotesNoPath(...texts: readonly string[]): void {
  for (const text of texts) {
    for (const part of SECRET_PARTS) {
      expect(text).not.toContain(part);
    }
  }
}

const text = (value: string): string => JSON.stringify(value);

describe("a webhook action whose url is a private address", () => {
  it("is refused at load in every spelling, naming the host and the fix", async () => {
    const config = await loaded(
      configText(
        "",
        PRIVATE.map(([written]) => `webhook({ url: ${text(`https://${written}${TAIL}`)} })`),
      ),
    );
    const host = await hostFor(config);
    for (const [index, [, shown, form]] of PRIVATE.entries()) {
      const source = config.sources[index];
      if (source === undefined) {
        throw new Error("each form has its source");
      }
      const error = await refusalOf(
        Promise.resolve().then(() => checkSourceActions(config, source, host, ENV)),
      );
      expect(error.code, form).toBe("action-settings");
      expect(error.message, form).toBe(
        `the settings of sources[${index}].actions[0] (@facetdb/webhook send) are refused by the action's schema:\n  - sources[${index}].actions[0].url: ${privateWords(shown, "action")}`,
      );
      quotesNoPath(error.message, error.fix);
    }
  });

  it("over http to this machine is refused too, until the config allows it", async () => {
    for (const url of ["http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080"]) {
      const refused = await refusalOf(
        loaded(configText("", [`webhook({ url: ${text(`${url}${TAIL}`)} })`])).then(workerLoad),
      );
      expect(refused.message).toContain(
        `  - sources[0].actions[0].url: ${privateWords(new URL(url).hostname, "action")}`,
      );
      quotesNoPath(refused.message);
      await expect(
        loaded(
          configText("", [`webhook({ url: ${text(`${url}${TAIL}`)}, allowPrivate: true })`]),
        ).then(workerLoad),
      ).resolves.toBeUndefined();
    }
  });

  it("loads with allowPrivate: true, the flag kept in the action's settings", async () => {
    const urls = [
      "https://10.0.0.5",
      "https://169.254.169.254",
      "https://[fd00::1]",
      "https://hooks.internal",
      "http://127.0.0.1:4040",
    ];
    const config = await loaded(
      configText(
        "",
        urls.map((url) => `webhook({ url: ${text(`${url}${TAIL}`)}, allowPrivate: true })`),
      ),
    );
    await expect(workerLoad(config)).resolves.toBeUndefined();
    expect(config.sources[0]?.actions[0]?.config).toEqual({
      url: `https://10.0.0.5${TAIL}`,
      allowPrivate: true,
    });
  });

  it("does not let allowPrivate lift any other rule", async () => {
    const cases: readonly (readonly [string, string])[] = [
      [
        "http://10.0.0.5",
        'an endpoint is sent signed decisions and alerts over HTTPS: write it as "https://hooks.example.com/facetdb"; http:// is for a receiver on this machine only (localhost, 127.0.0.1 or [::1])',
      ],
      [
        "https://[fe80::1%25eth0]",
        'an endpoint is a full address written as plain text, such as "https://hooks.example.com/facetdb": remove any space, backslash, control or invisible character',
      ],
    ];
    for (const [url, words] of cases) {
      for (const flag of ["", ", allowPrivate: true"]) {
        const refused = await refusalOf(
          loaded(configText("", [`webhook({ url: ${text(`${url}${TAIL}`)}${flag} })`])).then(
            workerLoad,
          ),
        );
        expect(refused.message).toContain(`  - sources[0].actions[0].url: ${words}`);
      }
    }
    // The userinfo trick, `public.example@` before a private host, is a login in the address: the
    // config file's own rule refuses it before any plugin loads, flag or none; the plugin's rule
    // refuses it too, for `facetdb review`, which loads no plugin.
    for (const flag of ["", ", allowPrivate: true"]) {
      const url = `https://public.example@127.0.0.1${TAIL}`;
      await expect(
        loaded(configText("", [`webhook({ url: ${text(url)}${flag} })`])),
      ).rejects.toThrow('"url" is a URL with a username or password in it');
      expect(endpointProblem(url, true)).toBe(
        'an endpoint never carries a username or password, which this file and its JSON export never hold: remove the "user:password@" part; the receiver checks the facetdb-signature header instead',
      );
    }
  });

  it("an else to a private address needs its own allowPrivate: the action's does not carry over", async () => {
    const when = '{ status: "done" }';
    const refused = await refusalOf(
      loaded(
        configText("", [
          `webhook({ url: ${text(`http://127.0.0.1:4040${TAIL}`)}, allowPrivate: true, when: ${when}, else: { url: ${text(`https://10.0.0.5${TAIL}`)} } })`,
        ]),
      ).then(workerLoad),
    );
    expect(refused.message).toBe(
      `the settings of sources[0].actions[0] (@facetdb/webhook send) are refused by the action's schema:\n  - sources[0].actions[0].else.url: ${privateWords("10.0.0.5", "action")}`,
    );
    // Nor does an else that sets only the flag lift it for the action's own url.
    const flagOnly = await refusalOf(
      loaded(
        configText("", [
          `actionCall("@facetdb/webhook", "send", { url: ${text(`https://10.0.0.5${TAIL}`)}, when: ${when}, else: { allowPrivate: true } })`,
        ]),
      ).then(workerLoad),
    );
    expect(flagOnly.message).toContain(
      `sources[0].actions[0].url: ${privateWords("10.0.0.5", "action")}`,
    );

    await expect(
      loaded(
        configText("", [
          `webhook({ url: ${text(`https://hooks.example.com${TAIL}`)}, when: ${when}, else: { url: ${text(`https://10.0.0.5${TAIL}`)}, allowPrivate: true } })`,
        ]),
      ).then(workerLoad),
    ).resolves.toBeUndefined();
  });

  it("accepts a public name or address at load, and judges no name by what it resolves to", async () => {
    // A public name that resolves to 127.0.0.1 is not visible at load: the send judges it.
    const config = await loaded(
      configText(
        "",
        [...PUBLIC, "https://127.0.0.1.nip.io/hook"].map((url) => `webhook({ url: ${text(url)} })`),
      ),
    );
    await expect(workerLoad(config)).resolves.toBeUndefined();
  });
});

describe("an endpoint in plugins.webhook.endpoints whose url is a private address", () => {
  it("is refused at load in every spelling, written as a string or as { url }", async () => {
    const strings = PRIVATE.map(
      ([written], index) => `e${index}: ${text(`https://${written}${TAIL}`)}`,
    );
    const objects = PRIVATE.map(
      ([written], index) => `o${index}: { url: ${text(`https://${written}${TAIL}`)} }`,
    );
    const config = await loaded(configText([...strings, ...objects].join(", "), []));
    const error = await refusalOf(hostFor(config));

    expect(error.code).toBe("plugin-settings");
    expect(error.message).toBe(
      [
        'the settings of the plugin "@facetdb/webhook" are refused by its schema:',
        ...PRIVATE.map(
          ([, shown], index) =>
            `  - plugins.webhook.endpoints.e${index}: ${privateWords(shown, "endpoint")}`,
        ),
        ...PRIVATE.map(
          ([, shown], index) =>
            `  - plugins.webhook.endpoints.o${index}.url: ${privateWords(shown, "endpoint")}`,
        ),
      ].join("\n"),
    );
    quotesNoPath(error.message, error.fix);
  });

  it("loads with { url, allowPrivate: true }, and an alert through it is queued to its url", async () => {
    const url = `http://127.0.0.1:4040${TAIL}`;
    const config = await loaded(
      configText(
        `ops: { url: ${text(url)}, allowPrivate: true }, public: ${text(`https://hooks.example.com${TAIL}`)}`,
        [],
        ["webhook:ops"],
      ),
    );
    await expect(workerLoad(config)).resolves.toBeUndefined();

    const host = await hostFor(config);
    const queued: string[] = [];
    const [ops] = bindChannels({
      config,
      host: withOutbox(host, { projectId: "project-1", outbox: recordingOutbox(queued) }),
      env: ENV,
      // The channel host's 20 seconds never pass: the queueing answers first.
      clock: { now: () => 0, sleep: () => new Promise<void>(() => undefined) },
      stop: () => new AbortController().signal,
    });
    await ops?.deliver({ kind: "system-alert", severity: "critical", text: "Down." });
    expect(queued).toEqual([url]);
    // The outbox sends a row whose address the config in force names, in either form.
    expect(webhookRefusal(config, host, { plugin: WEBHOOK_PLUGIN, endpoint: url })).toBeUndefined();
  });

  it("is never refused when a { url } names a public address", async () => {
    const config = await loaded(
      configText(PUBLIC.map((url, index) => `p${index}: { url: ${text(url)} }`).join(", "), []),
    );
    await expect(workerLoad(config)).resolves.toBeUndefined();
  });
});

describe("what reads an endpoint reads either form", () => {
  const OPS = `http://127.0.0.1:4040${TAIL}`;
  const FILE = facetdb({
    model: "jev-1.14.0",
    plugins: {
      webhook: {
        secret: env("FACETDB_WEBHOOK_SECRET"),
        endpoints: { ops: { url: OPS, allowPrivate: true } },
      },
    },
    sources: [
      {
        name: "tickets",
        api: true,
        read: ["subject"],
        questions: { urgent: noul("Is this ticket urgent?") },
        actions: [
          webhook({
            url: `https://10.0.0.5${TAIL}`,
            allowPrivate: true,
            when: { status: "done" },
            else: { url: `https://192.168.1.10${TAIL}`, allowPrivate: true },
          }),
        ],
      },
    ],
  });

  it("the project JSON keeps allowPrivate and reads back the same, and the exported file loads and is judged again", async () => {
    const json = toProjectJson(FILE);
    expect(json.plugins?.["webhook"]?.["endpoints"]).toEqual({
      ops: { url: OPS, allowPrivate: true },
    });
    expect(json.sources[0]?.actions[0]?.config).toEqual({
      url: `https://10.0.0.5${TAIL}`,
      allowPrivate: true,
      when: { status: "done" },
      else: { url: `https://192.168.1.10${TAIL}`, allowPrivate: true },
    });
    expect(fromProjectJson(JSON.parse(JSON.stringify(json)), ENV)).toEqual(FILE);

    const exported = configFileSource(FILE);
    await expect(loaded(exported).then(workerLoad)).resolves.toBeUndefined();
    // The flags taken out of the same text, the loader refuses what they allowed.
    const without = exported
      .replaceAll(', "allowPrivate": true', "")
      .replaceAll(',"allowPrivate":true', "");
    expect(without).not.toContain("allowPrivate");
    const refused = await refusalOf(loaded(without).then(workerLoad));
    expect(refused.message).toContain(
      `plugins.webhook.endpoints.ops.url: ${privateWords("127.0.0.1", "endpoint")}`,
    );
  });

  // GET /v1/plugins cutting `{ url, allowPrivate }` to its host is plugins-door.test.ts's ("shows
  // the built-in webhook's endpoints by their hosts alone"): the door is the CLI's, and a plugin
  // test reaches no command module but through a barrel.

  it("facetdb review's step queues the else to its own url under its own flag, and refuses one without it", async () => {
    const record = {
      key: "T-1",
      state: {},
      status: "needs_review" as const,
      stateHash: "h1",
      decidedAt: new Date(0),
    };
    const queued: string[] = [];
    const webhooks = {
      projectId: "project-1",
      sourceId: "source-1",
      outbox: recordingOutbox(queued),
    };
    const noAction = () => Promise.reject(new Error("no plugin action"));
    const [source] = FILE.sources;
    if (source === undefined) {
      throw new Error("the file has a source");
    }
    await actionSteps(source, noAction, webhooks)[0]?.run(record, {});
    expect(queued).toEqual([`https://192.168.1.10${TAIL}`]);

    // The same file with the else's flag gone, as `facetdb review` reads it with no plugin loaded.
    const [call] = source.actions;
    if (call === undefined) {
      throw new Error("the source has its webhook");
    }
    const bare = {
      ...source,
      actions: [
        { ...call, config: { ...call.config, else: { url: `https://192.168.1.10${TAIL}` } } },
      ],
    };
    const run = actionSteps(bare, noAction, webhooks)[0]?.run(record, {});
    await expect(run).rejects.toThrow(
      `the webhook was not queued, as its url is refused: ${privateWords("192.168.1.10", "action")}`,
    );
    expect(queued).toHaveLength(1);
  });

  it("a studio draft cannot set allowPrivate: neither on an endpoint nor on an action", async () => {
    const host = await hostFor(FILE);
    const current = { path: "facetdb.config.ts", text: configFileSource(FILE), config: FILE };
    const plugins = draftPlugins({
      host: () => host,
      env: ENV,
      coreVersion: VERSION,
      projectDir: "/work/app",
      machineZone: () => "UTC",
    });
    const endpoint = planApply(
      current,
      {
        project: {
          plugins: {
            webhook: {
              secret: env("FACETDB_WEBHOOK_SECRET"),
              endpoints: {
                ops: { url: OPS, allowPrivate: true },
                lan: { url: "https://10.0.0.9/in", allowPrivate: true },
              },
            },
          },
        },
      },
      ENV,
      undefined,
      plugins,
    );
    expect(endpoint).toEqual({
      ok: false,
      issues: [
        {
          path: "plugins.webhook.endpoints.lan.url",
          message: expect.stringContaining(
            "a draft cannot change plugins.webhook.endpoints.lan.url",
          ) as string,
        },
        {
          path: "plugins.webhook.endpoints.lan.allowPrivate",
          message: expect.stringContaining(
            "a draft cannot change plugins.webhook.endpoints.lan.allowPrivate",
          ) as string,
        },
      ],
    });

    const action = planApply(
      current,
      {
        source: {
          name: "tickets",
          actions: [webhook({ url: "https://10.0.0.9/in", allowPrivate: true })],
        },
      },
      ENV,
    );
    expect(action).toMatchObject({
      ok: false,
      issues: [
        { path: "sources[0].actions", message: expect.stringContaining("by hand") as string },
      ],
    });
  });
});

describe("the classifier the send reuses", () => {
  it("judges an address as a resolver answers it, IPv4 inside IPv6 by the IPv4", () => {
    const privateOnes = [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "::1",
      "::",
      "::ffff:10.0.0.1",
      "::ffff:a00:1",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
      "fe80::1%eth0",
      "fd00::1",
      // Teredo, its client 127.0.0.1 obfuscated in the last 32 bits: the whole of 2001::/32.
      "2001:0:4136:e378:8000:63bf:80ff:fffe",
      "2001::1",
      "not an address",
    ];
    for (const address of privateOnes) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of [
      "8.8.8.8",
      "2606:4700::1111",
      "::ffff:8.8.8.8",
      "2002:808:808::",
      "2001:4860:4860::8888",
    ]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("judges a host as a URL leaves it, a name by its suffix only", () => {
    expect(isPrivateHost("[::1]")).toBe(true);
    expect(isPrivateHost("Metadata.Google.Internal.")).toBe(true);
    expect(isPrivateHost("hooks.example.com")).toBe(false);
    expect(isPrivateHost("127.0.0.1.nip.io")).toBe(false);
  });

  it("allows a private address at the send only for an address the config in force writes with allowPrivate: true", async () => {
    const when = '{ status: "done" }';
    const opsUrl = `http://127.0.0.1:4040${TAIL}`;
    const actionUrl = `https://10.0.0.5${TAIL}`;
    const elseUrl = `https://10.0.0.6${TAIL}`;
    const publicUrl = `https://hooks.example.com${TAIL}`;
    const rebinding = `https://127.0.0.1.nip.io${TAIL}`;
    const config = await loaded(
      configText(`ops: { url: ${text(opsUrl)}, allowPrivate: true }, plain: ${text(publicUrl)}`, [
        `webhook({ url: ${text(actionUrl)}, allowPrivate: true })`,
        `webhook({ url: ${text(publicUrl)}, when: ${when}, else: { url: ${text(elseUrl)}, allowPrivate: true } })`,
        `webhook({ url: ${text(rebinding)} })`,
      ]),
    );
    const host = await hostFor(config);

    for (const allowed of [opsUrl, actionUrl, elseUrl]) {
      expect(webhookAllowsPrivate(config, host, allowed), allowed).toBe(true);
    }
    // Named with no flag, named only in another spelling, or not named at all: not allowed.
    for (const barred of [publicUrl, rebinding, `https://10.0.0.5${TAIL}#x`, "https://10.0.0.7/"]) {
      expect(webhookAllowsPrivate(config, host, barred), barred).toBe(false);
    }
  });
});
