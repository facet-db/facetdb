import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import {
  addressKeyOf,
  createHookLimiter,
  HOOK_ADDRESS_BURST,
  HOOK_ADDRESS_PER_SECOND,
  HOOK_BODIES_AT_ONCE,
  HOOK_BODY_DEADLINE_MS,
  HOOK_READING_PER_ADDRESS,
  HOOK_SOURCE_BURST,
  HOOK_SOURCE_PER_SECOND,
  HOOK_TRACKED_ADDRESSES,
  HOOK_TRACKED_SOURCES,
  type HookAdmission,
  type HookLimiter,
  hookBodyTooSlow,
} from "./limits.ts";

/**
 * The hook route's limits on a clock that moves only when told: a burst taken whole and the rate
 * after it, per address (an IPv6 one by its /64) and per source; a proxy on this machine skipping
 * the address's limit and keeping the source's; the bodies read at once; and the bound on what is
 * remembered, whatever addresses or names a sender uses.
 */

const hookUrl = (source = "issues", plugin = "github"): string =>
  `http://127.0.0.1/v1/hooks/${plugin}/${source}`;

type Ask = {
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

function ask(limiter: HookLimiter, remoteAddress: string, options: Ask = {}): HookAdmission {
  return limiter.admit({
    url: options.url ?? hookUrl(),
    remoteAddress,
    headers: options.headers ?? {},
  });
}

/** One delivery whose body is whole at once: its slot is freed as soon as it is admitted. */
function deliver(limiter: HookLimiter, remoteAddress: string, options: Ask = {}): HookAdmission {
  const admission = ask(limiter, remoteAddress, options);
  if (admission.kind === "admitted") {
    admission.release();
  }
  return admission;
}

/** `count` deliveries in one instant: how many were admitted. */
function burst(
  limiter: HookLimiter,
  remoteAddress: string,
  count: number,
  options: Ask = {},
): number {
  let admitted = 0;
  for (let at = 0; at < count; at += 1) {
    if (deliver(limiter, remoteAddress, options).kind === "admitted") {
      admitted += 1;
    }
  }
  return admitted;
}

function refusal(admission: HookAdmission): {
  status: number;
  code: string;
  message: string;
  retryAfter: string | undefined;
} {
  if (admission.kind !== "refused") {
    throw new Error("the delivery was admitted, not refused");
  }
  return {
    status: admission.error.status,
    code: admission.error.code,
    message: admission.error.message,
    retryAfter: admission.error.headers["retry-after"],
  };
}

describe("the hook route's limits (hook-limits)", () => {
  it("names every figure", () => {
    expect([HOOK_ADDRESS_PER_SECOND, HOOK_ADDRESS_BURST]).toEqual([10, 100]);
    expect([HOOK_SOURCE_PER_SECOND, HOOK_SOURCE_BURST]).toEqual([20, 200]);
    expect([HOOK_BODIES_AT_ONCE, HOOK_READING_PER_ADDRESS]).toEqual([8, 2]);
    expect(HOOK_BODY_DEADLINE_MS).toBe(10_000);
    const slow = hookBodyTooSlow();
    expect([slow.status, slow.code]).toEqual([408, "body_too_slow"]);
    expect(slow.toBody().error.message).toContain("10 seconds");
  });

  it("@timing takes an address's burst whole, then its rate, a token back after its time, on the fake clock", () => {
    const clock = new FakeClock(1_000_000);
    const limiter = createHookLimiter({ clock });

    expect(burst(limiter, "203.0.113.5", HOOK_ADDRESS_BURST)).toBe(HOOK_ADDRESS_BURST);
    const refused = refusal(ask(limiter, "203.0.113.5"));
    expect(refused).toMatchObject({ status: 429, code: "too_many_deliveries", retryAfter: "1" });
    expect(refused.message).toContain("This address");

    // A refusal takes no token: five more change nothing about when the next one is back.
    expect(burst(limiter, "203.0.113.5", 5)).toBe(0);
    // One token every 100 ms: not at 99, at 100, and only one.
    clock.advance(99);
    expect(ask(limiter, "203.0.113.5").kind).toBe("refused");
    clock.advance(1);
    expect(burst(limiter, "203.0.113.5", 3)).toBe(1);
    // A second's worth is ten; the burst comes back whole after ten seconds, and no more than it.
    clock.advance(1000);
    expect(burst(limiter, "203.0.113.5", 20)).toBe(HOOK_ADDRESS_PER_SECOND);
    clock.advance(60_000);
    expect(burst(limiter, "203.0.113.5", 2 * HOOK_ADDRESS_BURST)).toBe(HOOK_ADDRESS_BURST);
    // Another address had its own bucket all along.
    expect(deliver(limiter, "203.0.113.6").kind).toBe("admitted");
  });

  it("@timing takes a source's burst whole from every address together, then its rate, on the fake clock; another source still answers", () => {
    const clock = new FakeClock(1_000_000);
    const limiter = createHookLimiter({ clock });

    expect(burst(limiter, "198.51.100.1", HOOK_ADDRESS_BURST)).toBe(HOOK_ADDRESS_BURST);
    expect(burst(limiter, "198.51.100.2", HOOK_ADDRESS_BURST)).toBe(HOOK_ADDRESS_BURST);
    // The 201st to this source, from an address that has sent nothing.
    const refused = refusal(ask(limiter, "198.51.100.3"));
    expect(refused).toMatchObject({ status: 429, code: "too_many_deliveries", retryAfter: "1" });
    expect(refused.message).toContain("This source");
    expect(deliver(limiter, "198.51.100.3", { url: hookUrl("pulls") }).kind).toBe("admitted");

    // One token every 50 ms.
    clock.advance(49);
    expect(ask(limiter, "198.51.100.3").kind).toBe("refused");
    clock.advance(1);
    expect(burst(limiter, "198.51.100.3", 3)).toBe(1);
  });

  it("counts every spelling of one source's address as that source", () => {
    const limiter = createHookLimiter({ clock: new FakeClock() });
    const spellings = [
      hookUrl(),
      "http://127.0.0.1/v1/hooks/GitHub/Issues",
      "http://127.0.0.1/v1/%68ooks/github/iss%75es",
      "http://127.0.0.1/V1/HOOKS/github/issues/",
      "http://127.0.0.1/v1/hooks//github//issues?x=1",
      "http://127.0.0.1/v1/hooks/github/issues/more",
    ];
    let sent = 0;
    for (let address = 0; sent < HOOK_SOURCE_BURST; address += 1) {
      for (let at = 0; at < HOOK_ADDRESS_BURST && sent < HOOK_SOURCE_BURST; at += 1) {
        const url = spellings[sent % spellings.length] ?? hookUrl();
        expect(deliver(limiter, `192.0.2.${address}`, { url }).kind).toBe("admitted");
        sent += 1;
      }
    }
    for (const url of spellings) {
      expect(ask(limiter, "192.0.2.200", { url }).kind, url).toBe("refused");
    }
  });

  it("keys an IPv6 address by its /64, and an IPv4-mapped address as its IPv4 one", () => {
    expect(addressKeyOf("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(addressKeyOf("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(addressKeyOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKeyOf("::1")).toBe("0:0:0:0::/64");
    expect(addressKeyOf("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(addressKeyOf("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
    expect(addressKeyOf("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(addressKeyOf("203.0.113.5")).toBe("203.0.113.5");

    const limiter = createHookLimiter({ clock: new FakeClock() });
    expect(burst(limiter, "2001:db8:1:2::1", HOOK_ADDRESS_BURST)).toBe(HOOK_ADDRESS_BURST);
    // Another address of the same /64 shares the spent bucket; the next /64 has its own.
    expect(ask(limiter, "2001:db8:1:2:ffff:ffff:ffff:ffff").kind).toBe("refused");
    expect(ask(limiter, "2001:db8:1:2:0:0:0:9").kind).toBe("refused");
    expect(deliver(limiter, "2001:db8:1:3::1", { url: hookUrl("pulls") }).kind).toBe("admitted");

    expect(burst(limiter, "::ffff:203.0.113.5", HOOK_ADDRESS_BURST, { url: hookUrl("a") })).toBe(
      HOOK_ADDRESS_BURST,
    );
    expect(ask(limiter, "203.0.113.5", { url: hookUrl("b") }).kind).toBe("refused");
  });

  it("skips the address's limit behind a proxy on this machine and keeps the source's", () => {
    for (const header of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"]) {
      const limiter = createHookLimiter({ clock: new FakeClock() });
      const headers = { [header]: "203.0.113.9" };
      expect(burst(limiter, "127.0.0.1", HOOK_SOURCE_BURST, { headers }), header).toBe(
        HOOK_SOURCE_BURST,
      );
      const refused = refusal(ask(limiter, "::ffff:127.0.0.1", { headers }));
      expect(refused.message, header).toContain("This source");
      expect(deliver(limiter, "127.0.0.1", { headers, url: hookUrl("pulls") }).kind).toBe(
        "admitted",
      );
      // A proxy's requests take no address's tokens: the loopback address itself is untouched.
      expect(limiter.tracked().addresses, header).toBe(0);
    }

    // Not loopback: a forwarding header is the sender's own text, and its address is limited.
    const limiter = createHookLimiter({ clock: new FakeClock() });
    const forged = { "x-forwarded-for": "198.51.100.77" };
    expect(burst(limiter, "203.0.113.5", HOOK_ADDRESS_BURST + 1, { headers: forged })).toBe(
      HOOK_ADDRESS_BURST,
    );
    // Loopback with no forwarding header: a local sender, limited by its address.
    expect(burst(limiter, "127.0.0.1", HOOK_ADDRESS_BURST + 1, { url: hookUrl("pulls") })).toBe(
      HOOK_ADDRESS_BURST,
    );
  });

  it("refuses a 9th body read at once until one of the eight is released, once each", () => {
    const limiter = createHookLimiter({ clock: new FakeClock() });
    const reading: (() => void)[] = [];
    for (let at = 0; at < HOOK_BODIES_AT_ONCE; at += 1) {
      const admission = ask(limiter, `198.51.100.${at}`);
      if (admission.kind !== "admitted") {
        throw new Error(`body ${at + 1} was refused`);
      }
      reading.push(admission.release);
    }
    expect(limiter.tracked().reading).toBe(HOOK_BODIES_AT_ONCE);

    const ninth = refusal(ask(limiter, "198.51.100.200"));
    expect(ninth).toMatchObject({ status: 429, code: "too_many_deliveries", retryAfter: "1" });
    expect(ninth.message).toContain(`${HOOK_BODIES_AT_ONCE} deliveries at once`);

    // A body released twice (its end, then its socket closing) frees one slot, not two.
    reading[0]?.();
    reading[0]?.();
    expect(limiter.tracked().reading).toBe(HOOK_BODIES_AT_ONCE - 1);
    expect(ask(limiter, "198.51.100.200").kind).toBe("admitted");
    expect(ask(limiter, "198.51.100.201").kind).toBe("refused");
  });

  it("lets one address hold at most 2 of the bodies read at once, refused past it with no token taken, others still admitted", () => {
    const limiter = createHookLimiter({ clock: new FakeClock() });
    const first = ask(limiter, "203.0.113.5");
    const second = ask(limiter, "203.0.113.5");
    if (first.kind !== "admitted" || second.kind !== "admitted") {
      throw new Error("the first two bodies of one address were refused");
    }
    const third = refusal(ask(limiter, "203.0.113.5", { url: hookUrl("pulls") }));
    expect(third).toMatchObject({ status: 429, code: "too_many_deliveries", retryAfter: "1" });
    expect(third.message).toContain(`already has ${HOOK_READING_PER_ADDRESS} deliveries`);
    expect(limiter.tracked()).toMatchObject({ reading: 2, readingAddresses: 1 });

    // Meanwhile another address, and another address of no /64 of the first, are admitted.
    expect(deliver(limiter, "203.0.113.6").kind).toBe("admitted");
    const v6 = [ask(limiter, "2001:db8:1:2::1"), ask(limiter, "2001:db8:1:2::2")];
    expect(ask(limiter, "2001:db8:1:2:ffff::3").kind).toBe("refused");

    // A body released twice frees one of the address's places, not two.
    first.release();
    first.release();
    expect(limiter.tracked().readingAddresses).toBe(2);
    const again = ask(limiter, "203.0.113.5");
    expect(again.kind).toBe("admitted");
    expect(ask(limiter, "203.0.113.5").kind).toBe("refused");

    // Every body released: no address's key is held, and the refusals took no token (2 + 1 taken).
    second.release();
    if (again.kind === "admitted") {
      again.release();
    }
    for (const one of v6) {
      if (one.kind === "admitted") {
        one.release();
      }
    }
    expect(limiter.tracked()).toMatchObject({ reading: 0, readingAddresses: 0 });
    expect(burst(limiter, "203.0.113.5", HOOK_ADDRESS_BURST, { url: hookUrl("other") })).toBe(
      HOOK_ADDRESS_BURST - 3,
    );
  });

  it("holds no address's key past its bodies, and behind a proxy on this machine only the 8 bodies apply", () => {
    const limiter = createHookLimiter({ clock: new FakeClock() });
    for (let round = 0; round < 1000; round += 1) {
      const held = [0, 1, 2, 3].flatMap((at) => {
        const address = `10.${round >> 8}.${round & 255}.${at}`;
        return [ask(limiter, address, { url: hookUrl(`s${at}`) }), ask(limiter, address)];
      });
      expect(limiter.tracked().readingAddresses).toBeLessThanOrEqual(HOOK_BODIES_AT_ONCE);
      for (const one of held) {
        if (one.kind === "admitted") {
          one.release();
        }
      }
    }
    expect(limiter.tracked()).toMatchObject({ reading: 0, readingAddresses: 0 });

    const proxied = createHookLimiter({ clock: new FakeClock() });
    const headers = { "x-forwarded-for": "203.0.113.9" };
    const held: HookAdmission[] = [];
    for (let at = 0; at < HOOK_BODIES_AT_ONCE; at += 1) {
      held.push(ask(proxied, "127.0.0.1", { headers }));
    }
    expect(held.map((one) => one.kind)).toEqual(Array(HOOK_BODIES_AT_ONCE).fill("admitted"));
    expect(proxied.tracked().readingAddresses).toBe(0);
    expect(refusal(ask(proxied, "127.0.0.1", { headers })).message).toContain(
      `reading ${HOOK_BODIES_AT_ONCE} deliveries at once`,
    );
  });

  it("remembers no more addresses than its bound, forgetting the least recently admitted, and nothing for a refusal", () => {
    const limiter = createHookLimiter({ clock: new FakeClock() });
    expect(burst(limiter, "198.51.100.1", HOOK_ADDRESS_BURST + 1)).toBe(HOOK_ADDRESS_BURST);

    // As many other addresses (spread over sources so no source runs dry), each admitted once.
    let most = 0;
    for (let at = 0; at < HOOK_TRACKED_ADDRESSES; at += 1) {
      const address = `10.${(at >> 16) & 255}.${(at >> 8) & 255}.${at & 255}`;
      const url = hookUrl(`s${at % 100}`);
      expect(deliver(limiter, address, { url }).kind).toBe("admitted");
      most = Math.max(most, limiter.tracked().addresses);
    }
    expect(most).toBe(HOOK_TRACKED_ADDRESSES);

    // The spent address was the least recently admitted: forgotten, its burst is whole again.
    expect(deliver(limiter, "198.51.100.1", { url: hookUrl("pulls") }).kind).toBe("admitted");
    expect(limiter.tracked().addresses).toBe(HOOK_TRACKED_ADDRESSES);

    // Refused deliveries, from addresses never seen, remember nothing.
    const sources = limiter.tracked().sources;
    for (let at = 0; at < HOOK_BODIES_AT_ONCE; at += 1) {
      ask(limiter, `172.16.0.${at}`, { url: hookUrl("held") });
    }
    for (let at = 0; at < 1000; at += 1) {
      expect(ask(limiter, `172.17.${at >> 8}.${at & 255}`, { url: hookUrl(`n${at}`) }).kind).toBe(
        "refused",
      );
    }
    expect(limiter.tracked().addresses).toBe(HOOK_TRACKED_ADDRESSES);
    expect(limiter.tracked().sources).toBe(sources + 1);
  });

  it("remembers no more sources than its bound, whatever names and lengths a sender puts in a path", () => {
    const limiter = createHookLimiter({ clock: new FakeClock() });
    expect(burst(limiter, "198.51.100.1", HOOK_ADDRESS_BURST)).toBe(HOOK_ADDRESS_BURST);
    expect(burst(limiter, "198.51.100.2", HOOK_ADDRESS_BURST + 1)).toBe(HOOK_ADDRESS_BURST);
    expect(ask(limiter, "198.51.100.3").kind).toBe("refused");

    let most = 0;
    for (let at = 0; at < HOOK_TRACKED_SOURCES; at += 1) {
      // Fresh addresses, so no address runs dry; long names, which are remembered by a short key.
      const address = `10.0.${at >> 6}.${at & 63}`;
      const url = hookUrl(`${"x".repeat(4000)}${at}`);
      expect(deliver(limiter, address, { url }).kind).toBe("admitted");
      most = Math.max(most, limiter.tracked().sources);
    }
    expect(most).toBe(HOOK_TRACKED_SOURCES);

    // The spent source was the least recently admitted: forgotten, its burst is whole again.
    expect(deliver(limiter, "198.51.100.3").kind).toBe("admitted");
    expect(limiter.tracked().sources).toBe(HOOK_TRACKED_SOURCES);
  });
});
