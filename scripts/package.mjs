// Builds dist/latch-<version>.zip for the Chrome Web Store.
// The store assigns its own ID, so the pinned "key" is left out, along with the
// local install file. After the first upload, put the store's ID in extension/id.js.
// The job application module serves a separate local tool, not Latch's single purpose,
// so it and the tabGroups permission it needs stay out of the store build.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'extension');
const skip = new Set(['install.json', 'application.js', 'application-scan.js']);
const STORE_PERMISSIONS = ['storage', 'scripting', 'alarms', 'favicon'];

function files(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (skip.has(name)) return [];
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const entries = files(source).map(path => {
  const name = relative(source, path).split(sep).join('/');
  let data = readFileSync(path);
  if (name === 'manifest.json') {
    const manifest = JSON.parse(data);
    delete manifest.key;
    manifest.permissions = manifest.permissions.filter(p => STORE_PERMISSIONS.includes(p));
    data = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  }
  return { name, data };
});

// Minimal zip writer: one deflated entry per file, then the central directory.
const local = [];
const central = [];
let offset = 0;
for (const { name, data } of entries) {
  const nameBuf = Buffer.from(name);
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0, 6); head.writeUInt16LE(8, 8);
  head.writeUInt32LE(0, 10); head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
  local.push(head, nameBuf, packed);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0, 8); dir.writeUInt16LE(8, 10);
  dir.writeUInt32LE(0, 12); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(nameBuf.length, 28); dir.writeUInt32LE(offset, 42);
  central.push(dir, nameBuf);
  offset += head.length + nameBuf.length + packed.length;
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);

const { version } = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', `latch-${version}.zip`);
writeFileSync(out, Buffer.concat([...local, ...central, end]));
console.log(`${relative(root, out)}  (${entries.length} files)`);

// The same files unpacked, for "Load unpacked" and for testing exactly what the store gets.
const unpacked = join(root, 'dist', `latch-${version}`);
rmSync(unpacked, { recursive: true, force: true });
for (const { name, data } of entries) {
  mkdirSync(dirname(join(unpacked, name)), { recursive: true });
  writeFileSync(join(unpacked, name), data);
}
console.log(relative(root, unpacked));
