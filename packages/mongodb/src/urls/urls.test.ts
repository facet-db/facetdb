import { describe, expect, it } from "vitest";
import {
  adminUrlRefusal,
  databaseOf,
  parseConnectionString,
  plainMessage,
  subjectOf,
  tlsVerdict,
  urlProblem,
} from "./urls.ts";

/**
 * The MongoDB connection string as FacetDB reads it: the hosts the driver would reach, split as the
 * driver splits them, the database in the path, and TLS for every host but this machine: forced on
 * when the string says nothing, a `tls=false` refused unless the operator allows it,
 * `mongodb+srv://` encrypted by itself.
 */

describe("reading a connection string", () => {
  it("finds the hosts, the database, the password and what tls says", () => {
    expect(
      parseConnectionString(
        "mongodb://admin:p%40ss@db1.example.com:27017,db2.example.com/app%20one?replicaSet=rs0&TLS=true",
      ),
    ).toEqual({
      srv: false,
      hosts: ["db1.example.com:27017", "db2.example.com"],
      database: "app one",
      password: "p@ss",
      tls: true,
    });
    expect(parseConnectionString("mongodb+srv://cluster0.example.mongodb.net")).toEqual({
      srv: true,
      hosts: ["cluster0.example.mongodb.net"],
      database: undefined,
      password: undefined,
      tls: undefined,
    });
    expect(parseConnectionString("mongodb://%2Ftmp%2Fmongodb-27017.sock/app")?.hosts).toEqual([
      "/tmp/mongodb-27017.sock",
    ]);
    expect(databaseOf("mongodb://[::1]:27017/?replicaSet=rs0")).toBeUndefined();
    expect(databaseOf("mongodb://127.0.0.1:27017/shop?tls=false")).toBe("shop");
  });

  it("refuses what the driver refuses: another scheme, no host, a second @, unescaped characters", () => {
    for (const url of [
      "postgres://u:p@host/db",
      "mongodb://",
      "mongodb://a@evil.example.com@127.0.0.1/app",
      "mongodb://user:pa:ss@host/app",
      "mongodb://us/er:pass@host/app",
      "mongodb://user:%zz@host/app",
      "not a url",
    ]) {
      expect(parseConnectionString(url), url).toBeUndefined();
    }
  });
});

describe("the TLS rule", () => {
  it("leaves a string that stays on this machine as it is", () => {
    for (const url of [
      "mongodb://127.0.0.1:27017/app",
      "mongodb://localhost/app?tls=false",
      "mongodb://[::1]:27017,127.0.0.2:27018/app",
      "mongodb://%2Ftmp%2Fmongodb-27017.sock/app",
    ]) {
      expect(tlsVerdict(url, false), url).toEqual({ kind: "ok", forceTls: false });
    }
  });

  it("forces TLS on for another host when the string asks for nothing", () => {
    expect(tlsVerdict("mongodb://u:p@db.example.com/app", false)).toEqual({
      kind: "ok",
      forceTls: true,
    });
    // One remote host among loopback ones is enough: the driver uses one setting for all.
    expect(tlsVerdict("mongodb://127.0.0.1,db.example.com/app", false)).toEqual({
      kind: "ok",
      forceTls: true,
    });
    expect(tlsVerdict("mongodb://u:p@db.example.com/app?ssl=true", false)).toEqual({
      kind: "ok",
      forceTls: false,
    });
    expect(tlsVerdict("mongodb+srv://u:p@cluster0.example.mongodb.net/app", false)).toEqual({
      kind: "ok",
      forceTls: false,
    });
  });

  it("refuses tls=false to another host unless allowed, and a string it cannot read", () => {
    for (const url of [
      "mongodb://u:p@db.example.com/app?tls=false",
      "mongodb://u:p@db.example.com/app?ssl=true&tls=false",
      "mongodb+srv://u:p@cluster0.example.mongodb.net/app?ssl=false",
    ]) {
      expect(tlsVerdict(url, false).kind, url).toBe("plaintext");
      expect(tlsVerdict(url, true), url).toEqual({ kind: "ok", forceTls: false });
    }
    expect(tlsVerdict("mongodb://a@b@c/app", true)).toEqual({ kind: "invalid" });
  });

  it("words the admin's refusal and a worker string's problem", () => {
    expect(adminUrlRefusal("mongodb://u:p@db.example.com:27017/app?tls=false", false)).toEqual({
      code: "admin-url-tls",
      message:
        "the admin connection string reaches db.example.com with tls=false, so the admin password would travel in the clear; no connection was made",
      fix: "remove tls=false (and ssl=false) from the admin connection string: FacetDB connects with TLS to any host but this machine; or pass --allow-insecure if that network is trusted",
    });
    expect(adminUrlRefusal("mysql://u:p@host/app", false)?.code).toBe("admin-url");
    expect(adminUrlRefusal("mongodb://u:p@db.example.com/app", false)).toBeUndefined();
    const subject = subjectOf({ urlVariable: "LISTINGS_URL" });
    expect(urlProblem("mongodb://u:p@db.example.com/app?tls=false", subject, false)).toEqual({
      problem:
        "LISTINGS_URL reaches db.example.com with tls=false, so the password in it would travel in the clear",
      fix: "remove tls=false (and ssl=false) from LISTINGS_URL: FacetDB connects with TLS to any host but this machine; or pass --allow-insecure if that network is trusted",
    });
    expect(subjectOf({})).toBe("the source's connection string");
  });
});

describe("an error's words", () => {
  it("never carry the connection string, its password as written or as read, or the worker's", () => {
    const url = "mongodb://admin:p%40ss@db.example.com/app";
    const error = new Error(
      `auth failed for ${url}: password p%40ss (p@ss) rejected; worker hunter2 too`,
    );
    expect(plainMessage(error, [url, "hunter2", undefined])).toBe(
      "auth failed for ***: password *** (***) rejected; worker *** too",
    );
  });
});
