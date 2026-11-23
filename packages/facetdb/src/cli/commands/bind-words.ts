import { isLoopbackHost, operatorKnownByAddress, studioUrlHost } from "@facetdb/server";

/**
 * What a studio reached from other machines needs, printed once it listens: by `facetdb worker` and
 * `facetdb studio`, when the bind is beyond loopback (`--host`) or the config's `studioUrl` names
 * another host. Each line is said only when it applies; a loopback bind with no such `studioUrl`
 * prints none.
 */
export function bindWords(host: string, studioUrl: string | undefined): readonly string[] {
  const noOperator = !operatorKnownByAddress(studioUrl);
  if (isLoopbackHost(host) && !noOperator) {
    return [];
  }
  const lines: string[] = [];
  if (noOperator && studioUrl !== undefined) {
    lines.push(
      `studioUrl is ${studioUrlHost(studioUrl)}, so everyone signs in, on this machine too. Add sources and questions with facetdb migrate; the studio cannot.`,
    );
  }
  // An https studioUrl on another host is TLS already in front; anything else is reached over http.
  const https =
    noOperator &&
    studioUrl !== undefined &&
    URL.canParse(studioUrl) &&
    new URL(studioUrl).protocol === "https:";
  if (!https) {
    lines.push(
      `Sign-in needs https: put TLS in front of the studio (Caddy or nginx)${noOperator ? ", then set studioUrl to its https:// address" : ""}.`,
    );
  }
  if (!noOperator) {
    lines.push(
      studioUrl === undefined
        ? "Behind a proxy, set studioUrl in facetdb.config.ts to the address people open, or every visitor gets in as you. A proxy on this machine must also set X-Forwarded-For."
        : "A proxy on this machine must set X-Forwarded-For, or every visitor gets in as you without signing in.",
    );
  }
  return lines;
}
