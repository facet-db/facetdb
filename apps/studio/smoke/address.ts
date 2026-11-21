/**
 * Where the smoke's `facetdb dev` serves: a port of its own, not the studio's 4040, so a `facetdb
 * dev` or `facetdb studio` the operator has running is no obstacle. Plain data, read by the
 * server's launcher (dev.ts, under Node) and by playwright.config.ts.
 */
export const SMOKE_PORT = 4140;
export const SMOKE_URL = `http://127.0.0.1:${String(SMOKE_PORT)}`;
