import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scramVerifier } from "./index.ts";

/**
 * The one SCRAM-SHA-256 verifier of the worker password, moved here from the Postgres install and
 * the CockroachDB dialect, which each had a copy. A verifier both servers reject is found only at a
 * secure login, so the move is pinned by the old output, byte for byte.
 */

/** The verifier of "pencil" with sixteen bytes of 7 as the salt, as the copies printed it before the move. */
const BEFORE_THE_MOVE =
  "SCRAM-SHA-256$4096:BwcHBwcHBwcHBwcHBwcHBw==$K97YndbwHX05fl7lN8Bcm3gG4nc43WvYj0OL1dbknsk=:tvU6S2vfOxKAzPZ5dC4h+cucyZ553rNC2MQ2ZJzmu3g=";

/** RFC 7677's example exchange (section 3): user "user", password "pencil". */
const RFC_SALT = "W22ZaJ0SNY7soEsUEjb6gQ==";
const RFC_AUTH_MESSAGE = [
  "n=user,r=rOprNGfwEbeRWgbNEkqO",
  "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096",
  "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0",
].join(",");
const RFC_CLIENT_PROOF = "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=";
const RFC_SERVER_SIGNATURE = "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=";

const VERIFIER = /^SCRAM-SHA-256\$4096:([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;

describe("scramVerifier", () => {
  it("gives the verifier the Postgres install and the CockroachDB dialect gave before the move, byte for byte", () => {
    expect(scramVerifier("pencil", Buffer.alloc(16, 7))).toBe(BEFORE_THE_MOVE);
  });

  it("stores the keys of RFC 7677's example: its server signature and its client proof check out", () => {
    const [, salt, stored = "", server = ""] =
      VERIFIER.exec(scramVerifier("pencil", Buffer.from(RFC_SALT, "base64"))) ?? [];
    expect(salt).toBe(RFC_SALT);
    const hmac = (key: string) =>
      createHmac("sha256", Buffer.from(key, "base64")).update(RFC_AUTH_MESSAGE).digest();
    expect(hmac(server).toString("base64")).toBe(RFC_SERVER_SIGNATURE);
    // The server's check of a login: the client key the proof carries hashes to the stored key.
    const signature = hmac(stored);
    const clientKey = Buffer.from(RFC_CLIENT_PROOF, "base64").map(
      (byte, index) => byte ^ (signature[index] ?? 0),
    );
    expect(createHash("sha256").update(clientKey).digest("base64")).toBe(stored);
  });

  it("salts each verifier afresh, and never holds the password", () => {
    const one = scramVerifier("a-long-random-password");
    const two = scramVerifier("a-long-random-password");
    expect(one).toMatch(VERIFIER);
    expect(Buffer.from(VERIFIER.exec(one)?.[1] ?? "", "base64")).toHaveLength(16);
    expect(one).not.toBe(two);
    expect(one).not.toContain("a-long-random-password");
  });
});
