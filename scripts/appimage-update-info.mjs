// Writes AppImage update information into an AppImage's `.upd_info` ELF section, where
// AppImageUpdate and AppImageLauncher look for it. electron-builder leaves the section empty.
//
//   node scripts/appimage-update-info.mjs <file.AppImage> "gh-releases-zsync|owner|repo|latest|Name-*-linux-x86_64.AppImage.zsync"
//
// The AppImage starts with the AppImageKit runtime, an ELF executable whose section headers
// stay valid in the final file, so the section is found by parsing those headers.
import { closeSync, openSync, readSync, writeSync } from "node:fs";

const [file, info] = process.argv.slice(2);
if (!file || !info) {
  console.error("usage: appimage-update-info.mjs <file.AppImage> <update-information>");
  process.exit(2);
}

/** The offset and size of a named section in an ELF64 little-endian file. */
export function findSection(fd, name) {
  const header = Buffer.alloc(64);
  readSync(fd, header, 0, 64, 0);
  if (header.readUInt32BE(0) !== 0x7f454c46) throw new Error("not an ELF file");
  if (header[4] !== 2 || header[5] !== 1) throw new Error("not a little-endian ELF64 file");
  const sectionTable = Number(header.readBigUInt64LE(0x28));
  const entrySize = header.readUInt16LE(0x3a);
  const count = header.readUInt16LE(0x3c);
  const namesIndex = header.readUInt16LE(0x3e);
  const table = Buffer.alloc(entrySize * count);
  readSync(fd, table, 0, table.length, sectionTable);
  const section = (i) => {
    const e = table.subarray(i * entrySize, (i + 1) * entrySize);
    return {
      nameOffset: e.readUInt32LE(0),
      offset: Number(e.readBigUInt64LE(0x18)),
      size: Number(e.readBigUInt64LE(0x20)),
    };
  };
  const names = section(namesIndex);
  const nameTable = Buffer.alloc(names.size);
  readSync(fd, nameTable, 0, names.size, names.offset);
  for (let i = 0; i < count; i++) {
    const s = section(i);
    const end = nameTable.indexOf(0, s.nameOffset);
    if (nameTable.toString("latin1", s.nameOffset, end) === name) return s;
  }
  throw new Error(`no ${name} section: is this an AppImage built on the AppImageKit runtime?`);
}

const fd = openSync(file, "r+");
try {
  const { offset, size } = findSection(fd, ".upd_info");
  const bytes = Buffer.from(info, "utf8");
  if (bytes.length >= size) throw new Error(`update information is longer than ${size - 1} bytes`);
  const padded = Buffer.alloc(size);
  bytes.copy(padded);
  writeSync(fd, padded, 0, size, offset);
  const check = Buffer.alloc(size);
  readSync(fd, check, 0, size, offset);
  if (!check.equals(padded)) throw new Error("read-back mismatch");
  console.log(`${file}: update information set (${bytes.length} bytes at ${offset})`);
} finally {
  closeSync(fd);
}
