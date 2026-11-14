import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { temporaryDatabase } from "./index.ts";

describe("temporaryDatabase", () => {
  it("gives each test a file of its own, and removes it with its WAL files and open handles", () => {
    const file = temporaryDatabase();
    const other = temporaryDatabase();
    expect(file.path).not.toBe(other.path);
    other.remove();
    const handle = file.open();
    handle.exec("pragma journal_mode = wal; create table t (id integer primary key)");
    handle.exec("insert into t default values");
    expect(existsSync(`${file.path}-wal`)).toBe(true);
    file.remove();
    expect(handle.isOpen).toBe(false);
    expect(existsSync(dirname(file.path))).toBe(false);
  });
});
