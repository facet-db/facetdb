import { describe, expect, it } from "vitest";
import {
  type AlertChannel,
  configFileSource,
  facetdb,
  fromProjectJson,
  noul,
  type ProjectConfig,
  parseProjectConfig,
  toProjectJson,
} from "./index.ts";

/**
 * `alerts.channels`: a channel is an address, or `{ to, sends?, quiet? }`; `sends` is one of three
 * words, `quiet` two times of day and a time zone, parsed and carried (156 acts on them). The JSON
 * export and the config file the exporter writes keep the form the file used, and a config of plain
 * addresses exports byte for byte as it did before the object form existed.
 */

function project(channels: readonly AlertChannel[]): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    alerts: { channels },
    sources: [
      {
        name: "tickets",
        api: true,
        read: ["body"],
        questions: { urgent: noul("Does the customer need an answer today?") },
      },
    ],
  });
}

function parsed(channels: readonly unknown[]): ProjectConfig {
  const result = parseProjectConfig(project(channels as readonly AlertChannel[]));
  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }
  return result.config;
}

function issuesOf(channels: readonly unknown[]): readonly { path: string; message: string }[] {
  const result = parseProjectConfig(project(channels as readonly AlertChannel[]));
  if (result.ok) {
    throw new Error("expected the config to be refused");
  }
  return result.issues;
}

describe("a plain-address config", () => {
  it("exports byte for byte as before the object form existed", () => {
    const config = parsed(["slack:#ops", "email:ops@example.com"]);
    // Pinned: the JSON export and the config file as the exporter wrote them.
    expect(JSON.stringify(toProjectJson(config))).toBe(
      '{"model":"jev-1.14.0","alerts":{"channels":["slack:#ops","email:ops@example.com"]},"onCapReached":"pause","sources":[{"name":"tickets","api":true,"read":["body"],"storage":"inline","onChange":"reset","onOutage":"hold","questions":{"urgent":{"type":"noul","instructions":"Does the customer need an answer today?","stakes":"low"}},"thresholds":{},"actions":[]}]}',
    );
    expect(configFileSource(config)).toBe(
      [
        'import { facetdb, noul } from "facetdb";',
        "",
        "export default facetdb({",
        '  model: "jev-1.14.0",',
        '  alerts: {"channels":["slack:#ops","email:ops@example.com"]},',
        "  sources: [",
        "    {",
        '      name: "tickets",',
        "      api: true,",
        '      read: ["body"],',
        "      questions: {",
        '        "urgent": noul("Does the customer need an answer today?"),',
        "      },",
        "    },",
        "  ],",
        "});",
        "",
      ].join("\n"),
    );
  });
});

describe("the object form", () => {
  const channels = [
    "telegram:-100123",
    { to: "slack:#ops", sends: "warnings", quiet: { from: "22:00", to: "07:00" } },
    { to: "email:ops@example.com", sends: "critical" },
    { to: "slack:#all", quiet: { from: "23:30", to: "06:15", zone: "Europe/Berlin" } },
    { to: "slack:#plain" },
  ] as const;

  it("is carried as the file wrote it, with no default filled in", () => {
    expect(parsed(channels).alerts?.channels).toEqual(channels);
  });

  it("keeps its form through the JSON export and the config file", () => {
    const config = parsed(channels);
    const json = toProjectJson(config);
    expect(json.alerts?.channels).toEqual(channels);
    expect(toProjectJson(fromProjectJson(json))).toEqual(json);
    expect(configFileSource(config)).toContain(
      'alerts: {"channels":["telegram:-100123",{"to":"slack:#ops","sends":"warnings","quiet":{"from":"22:00","to":"07:00"}},{"to":"email:ops@example.com","sends":"critical"},{"to":"slack:#all","quiet":{"from":"23:30","to":"06:15","zone":"Europe/Berlin"}},{"to":"slack:#plain"}]}',
    );
  });

  it("writes only the keys it names, whatever the config object carries beside them", () => {
    const config = parsed(channels);
    const extra = {
      ...config,
      alerts: {
        channels: [{ to: "slack:#ops", sends: "critical", token: "xoxb-not-for-export" }],
      },
    } as unknown as ProjectConfig;
    expect(JSON.stringify(toProjectJson(extra))).not.toContain("xoxb");
    expect(configFileSource(extra)).not.toContain("xoxb");
  });

  it("takes each of the three words for sends and refuses another", () => {
    for (const sends of ["critical", "warnings", "everything"]) {
      expect(parsed([{ to: "slack:#ops", sends }]).alerts?.channels).toEqual([
        { to: "slack:#ops", sends },
      ]);
    }
    const [issue] = issuesOf([{ to: "slack:#ops", sends: "warning" }]);
    expect(issue?.path).toBe("alerts.channels[0].sends");
    expect(issue?.message).toContain('"warnings" (critical alerts and warnings)');
  });

  it("refuses quiet hours that are not two different HH:MM times in a real time zone", () => {
    const refused = (quiet: unknown) =>
      issuesOf([{ to: "slack:#ops", quiet }]).map((issue) => `${issue.path}: ${issue.message}`);
    expect(refused({ from: "7:00", to: "22:00" })[0]).toContain(
      'alerts.channels[0].quiet.from: quiet.from is a time of day as "HH:MM"',
    );
    expect(refused({ from: "22:00", to: "24:00" })[0]).toContain("alerts.channels[0].quiet.to");
    expect(refused({ from: "22:00", to: "07:60" })[0]).toContain("alerts.channels[0].quiet.to");
    expect(refused({ from: "22:00", to: "22:00" })[0]).toContain("of no length");
    expect(refused({ from: "22:00", to: "07:00", zone: "Mars/Olympus" })[0]).toContain(
      "alerts.channels[0].quiet.zone: quiet.zone is not a time zone this machine knows",
    );
    expect(refused({ from: "22:00", to: "07:00", zone: "../etc/passwd" })[0]).toContain(
      "quiet.zone",
    );
    expect(refused({ from: "22:00" })[0]).toContain("alerts.channels[0].quiet.to");
    expect(refused({ from: "22:00", to: "07:00", days: "weekdays" })[0]).toContain(
      'unknown setting "days"',
    );
  });

  it("holds `to` to the address rules, a URL or a credential refused", () => {
    const [issue] = issuesOf([{ to: "slack:https://hooks.slack.com/services/T0/B0/x" }]);
    expect(issue?.path).toBe("alerts.channels[0].to");
    expect(issue?.message).toContain("never a webhook URL");
    expect(issuesOf([{ to: "ops" }])[0]?.message).toContain('"<channel>:<where>"');
  });

  it("refuses a key it does not know and a channel that is neither an address nor an object", () => {
    expect(issuesOf([{ to: "slack:#ops", where: "#ops" }])[0]?.message).toContain(
      'unknown setting "where"',
    );
    expect(issuesOf([42])[0]?.message).toContain(
      'an alert channel is an address such as "slack:#ops", or { to: "slack:#ops"',
    );
  });

  it("refuses an address named twice, in either form, since it would be sent each alert twice", () => {
    const [issue] = issuesOf(["slack:#ops", { to: "slack:#ops", sends: "critical" }]);
    expect(issue?.path).toBe("alerts.channels[1]");
    expect(issue?.message).toBe(
      "slack:#ops is named twice: name each channel once, so it is sent each alert once",
    );
  });
});
