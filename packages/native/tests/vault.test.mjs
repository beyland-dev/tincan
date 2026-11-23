// The encrypted Vault without the real keyring: the session bus is pointed at
// a socket that doesn't exist (before the addon loads), so `Vault.open` falls
// back to a key file in a temporary directory. Every test asserts that.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/nonexistent/tincan-vault-test-bus";

let native;
try {
  native = await import(new URL("../index.js", import.meta.url).href);
} catch {}
const skip = native ? false : "addon not built (run `pnpm build:native`)";

/** Asserts that `fn` throws (or rejects with) an error whose code is `code`. */
async function rejectsWith(fn, code) {
  await assert.rejects(
    async () => fn(),
    (err) => {
      assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
      return true;
    },
  );
}

describe("Vault", { skip }, () => {
  let dir;
  let n = 0;
  const dbPath = () => join(dir, `vault-${++n}.db`);

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "tincan-vault-test-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects an empty path or id", async () => {
    await rejectsWith(() => native.Vault.open(""), "INVALID_INPUT");
    await rejectsWith(() => native.Vault.open(dbPath(), { id: "" }), "INVALID_INPUT");
  });

  it("creates an encrypted database with a 0600 key file and reopens it", async () => {
    const path = dbPath();
    const vault = await native.Vault.open(path, { id: "test" });
    assert.equal(vault.keyStorage, "file");
    assert.equal(vault.keyFile, path.replace(/\.db$/, ".key"));
    assert.equal(vault.path, path);
    assert.equal(vault.isOpen, true);
    assert.match(vault.cipherVersion(), /^\d+\.\d+/);
    assert.equal(statSync(vault.keyFile).mode & 0o777, 0o600);

    vault.execBatch("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    assert.deepEqual(vault.exec("INSERT INTO t (body) VALUES (?)", ["hello"]), {
      changes: 1,
      lastInsertRowid: 1,
    });
    vault.close();
    assert.equal(vault.isOpen, false);

    const bytes = readFileSync(path);
    assert.ok(bytes.length > 0);
    assert.ok(!bytes.subarray(0, 16).toString("latin1").startsWith("SQLite format 3"));
    assert.equal(bytes.indexOf("hello"), -1);

    const again = await native.Vault.open(path, { id: "test" });
    assert.deepEqual(again.query("SELECT id, body FROM t"), [{ id: 1, body: "hello" }]);
    again.close();
  });

  it("won't create a new key for an existing database", async () => {
    const path = dbPath();
    const vault = await native.Vault.open(path);
    vault.execBatch("CREATE TABLE t (x)");
    vault.close();
    unlinkSync(vault.keyFile);
    await rejectsWith(() => native.Vault.open(path), "NOT_FOUND");
    assert.equal(existsSync(vault.keyFile), false);
  });

  it("refuses a key that doesn't open the database", async () => {
    const first = dbPath();
    const second = dbPath();
    const a = await native.Vault.open(first);
    a.execBatch("CREATE TABLE t (x)");
    a.close();
    const b = await native.Vault.open(second);
    b.close();
    // Give the first database the second one's key.
    const key = readFileSync(b.keyFile);
    rmSync(a.keyFile);
    writeFileSync(a.keyFile, key, { mode: 0o600 });
    await rejectsWith(() => native.Vault.open(first), "PERMISSION_DENIED");
  });

  it("binds and returns every type", () => {
    const vault = native.Vault.openInMemory();
    assert.equal(vault.keyStorage, "memory");
    assert.equal(vault.path, null);
    assert.equal(vault.keyFile, null);
    vault.execBatch("CREATE TABLE v (a, b, c, d, e, f, g, h)");
    const big = 2n ** 62n;
    vault.exec("INSERT INTO v VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      null,
      undefined,
      42,
      1.5,
      true,
      "text",
      new Uint8Array([1, 2, 3]),
      big,
    ]);
    const [row] = vault.query(
      "SELECT a, b, c, typeof(c) AS tc, d, typeof(d) AS td, e, f, g, h FROM v",
    );
    assert.equal(row.a, null);
    assert.equal(row.b, null);
    assert.equal(row.c, 42);
    assert.equal(row.tc, "integer");
    assert.equal(row.d, 1.5);
    assert.equal(row.td, "real");
    assert.equal(row.e, 1);
    assert.equal(row.f, "text");
    assert.ok(Buffer.isBuffer(row.g));
    assert.deepEqual([...row.g], [1, 2, 3]);
    assert.equal(row.h, big);
    assert.equal(vault.query("SELECT ? AS x", [9007199254740991n])[0].x, 9007199254740991);
    assert.equal(vault.query("SELECT ? AS x", [-(2n ** 63n)])[0].x, -(2n ** 63n));
    assert.deepEqual(vault.query("SELECT 1 AS x, 2 AS x"), [{ x: 2 }]);
    assert.deepEqual(vault.query("SELECT * FROM v WHERE 0"), []);
    vault.close();
  });

  it("rejects parameters it can't bind", async () => {
    const vault = native.Vault.openInMemory();
    await rejectsWith(() => vault.query("SELECT ?", [{}]), "INVALID_INPUT");
    await rejectsWith(() => vault.query("SELECT ?", [[1]]), "INVALID_INPUT");
    await rejectsWith(() => vault.query("SELECT ?", [Symbol("s")]), "INVALID_INPUT");
    await rejectsWith(() => vault.query("SELECT ?", [2n ** 64n]), "INVALID_INPUT");
    await rejectsWith(() => vault.query("SELECT ?, ?", [1]), "INVALID_INPUT");
    await rejectsWith(() => vault.query("SELEKT 1"), "INVALID_INPUT");
    vault.close();
  });

  it("maps a constraint failure to CONFLICT", async () => {
    const vault = native.Vault.openInMemory();
    vault.execBatch("CREATE TABLE u (k TEXT PRIMARY KEY)");
    vault.exec("INSERT INTO u VALUES (?)", ["a"]);
    await rejectsWith(() => vault.exec("INSERT INTO u VALUES (?)", ["a"]), "CONFLICT");
    vault.close();
  });

  it("commits a transaction and returns its value", () => {
    const vault = native.Vault.openInMemory();
    vault.execBatch("CREATE TABLE t (x)");
    const result = vault.transaction(() => {
      assert.equal(vault.inTransaction, true);
      vault.exec("INSERT INTO t VALUES (1)");
      return { ok: true };
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(vault.inTransaction, false);
    assert.equal(vault.query("SELECT count(*) AS n FROM t")[0].n, 1);
    vault.close();
  });

  it("rolls back and rethrows the body's own error", () => {
    const vault = native.Vault.openInMemory();
    vault.execBatch("CREATE TABLE t (x)");
    const thrown = new TypeError("boom");
    thrown.extra = 7;
    assert.throws(
      () =>
        vault.transaction(() => {
          vault.exec("INSERT INTO t VALUES (1)");
          throw thrown;
        }),
      (err) => err === thrown,
    );
    assert.equal(vault.inTransaction, false);
    assert.equal(vault.query("SELECT count(*) AS n FROM t")[0].n, 0);
    // Non-Error throws pass through too.
    assert.throws(
      () =>
        vault.transaction(() => {
          throw "plain";
        }),
      (err) => err === "plain",
    );
    vault.close();
  });

  it("rejects an async body, a nested transaction and a non-function", async () => {
    const vault = native.Vault.openInMemory();
    vault.execBatch("CREATE TABLE t (x)");
    await rejectsWith(
      () =>
        vault.transaction(() => {
          vault.exec("INSERT INTO t VALUES (1)");
          return Promise.resolve();
        }),
      "INVALID_INPUT",
    );
    assert.equal(vault.inTransaction, false);
    assert.equal(vault.query("SELECT count(*) AS n FROM t")[0].n, 0);

    let inner;
    vault.transaction(() => {
      try {
        vault.transaction(() => {});
      } catch (err) {
        inner = err;
      }
    });
    assert.equal(inner?.code, "INVALID_INPUT");
    assert.equal(vault.inTransaction, false);

    assert.throws(() => vault.transaction(42));
    vault.close();
  });

  it("throws NOT_CONNECTED after close, and closes twice", async () => {
    const vault = native.Vault.openInMemory();
    vault.close();
    vault.close();
    assert.equal(vault.inTransaction, false);
    await rejectsWith(() => vault.query("SELECT 1"), "NOT_CONNECTED");
    await rejectsWith(() => vault.exec("SELECT 1"), "NOT_CONNECTED");
    await rejectsWith(() => vault.execBatch("SELECT 1"), "NOT_CONNECTED");
    await rejectsWith(() => vault.cipherVersion(), "NOT_CONNECTED");
    await rejectsWith(() => vault.transaction(() => {}), "NOT_CONNECTED");
  });

  it("fails a commit cleanly when the body closes the vault", async () => {
    const vault = native.Vault.openInMemory();
    await rejectsWith(() => vault.transaction(() => vault.close()), "NOT_CONNECTED");
    assert.equal(vault.isOpen, false);
  });
});
