import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { importPhotoFiles, nodeSqliteDb, Store } from "../src/index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "tincan-photos-"));
  roots.push(root);
  const dir = join(root, "photos");
  mkdirSync(dir, { mode: 0o700 });
  const store = Store.open(nodeSqliteDb(new DatabaseSync(":memory:")), { now: () => 1 });
  const person = (id: string) => ({
    id,
    name: id,
    favorite: false,
    handles: [{ handle: `email:${id}@example.com`, label: null }],
  });
  store.replaceContacts(["ada", "bob", "carol", "dan", "eve"].map(person));
  return { root, dir, store };
}

/** A photo file as older versions wrote it: named by its content hash. */
function photoFile(dir: string, bytes: Buffer, extension: string): string {
  const name = `${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
  writeFileSync(join(dir, name), bytes, { mode: 0o600 });
  return name;
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');

describe("importPhotoFiles", () => {
  test("imports the photos contacts use, then deletes every file and the folder", () => {
    const { dir, store } = setup();
    const ada = photoFile(dir, JPEG, "jpg");
    const unused = photoFile(dir, PNG, "png");
    // Named like a photo, but its content doesn't match the name.
    const torn = `${"0".repeat(64)}.jpg`;
    writeFileSync(join(dir, torn), JPEG);
    // A valid name and hash, but not a raster image.
    const svg = photoFile(dir, SVG, "jpg");
    writeFileSync(join(dir, "stray.tmp"), "partial");
    mkdirSync(join(dir, "nested"));
    store.setContactPhoto("ada", ada);
    store.setContactPhoto("bob", torn);
    store.setContactPhoto("carol", svg);
    // Referenced, but its file is gone: it comes back with the next contact sync.
    store.setContactPhoto("dan", `${"1".repeat(64)}.png`);

    expect(importPhotoFiles(store, dir)).toEqual({ imported: 1, deleted: 6 });
    expect(existsSync(dir)).toBe(false);
    const photo = store.getContactPhoto("ada");
    expect(photo?.mediaType).toBe("image/jpeg");
    expect(Buffer.from(photo!.data)).toEqual(JPEG);
    for (const id of ["bob", "carol", "dan", "eve"]) expect(store.getContactPhoto(id)).toBeNull();
    expect(store.hasContactPhoto(unused)).toBe(false);
    // Contacts keep their photo names, so the next sync fills in what's missing.
    expect(store.contactPhoto("dan")).toBe(`${"1".repeat(64)}.png`);

    // Once the folder is gone there's nothing to do.
    expect(importPhotoFiles(store, dir)).toBeNull();
  });

  test("never follows a symlink", () => {
    const { root, dir, store } = setup();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    const name = photoFile(elsewhere, JPEG, "jpg");
    symlinkSync(join(elsewhere, name), join(dir, name));
    store.setContactPhoto("ada", name);
    expect(importPhotoFiles(store, dir)).toEqual({ imported: 0, deleted: 1 });
    expect(existsSync(join(elsewhere, name))).toBe(true);
    expect(store.getContactPhoto("ada")).toBeNull();

    // A photos folder that is itself a symlink is left alone, and so is what it points at.
    const link = join(root, "linked");
    symlinkSync(elsewhere, link);
    expect(importPhotoFiles(store, link)).toBeNull();
    expect(existsSync(join(elsewhere, name))).toBe(true);
  });
});
