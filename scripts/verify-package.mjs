import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import process from 'node:process';
import { MAIN_PACKAGE, parseCurrentArch, selectedPlatforms } from './lib/platforms.mjs';
import { assertVersionsSynced } from './lib/versions.mjs';

const current = parseCurrentArch(process.argv, { label: 'package' });
const sourceOnly = process.argv.includes('--source-only');

assertVersionsSynced('.');
const root = JSON.parse(await readFile('package.json', 'utf8'));
assert(root.name === MAIN_PACKAGE, 'main package name');
assert(root.engines?.node === '>=24.18.0', 'Node LTS engine');
assert(root.type === 'module', 'ESM package type');
assert(root.exports?.['.']?.import === './dist/index.js', 'ESM export');
assert(root.exports?.['.']?.types === './dist/index.d.ts', 'type export');
assert(root.files?.includes('docs'), 'documentation tree is packaged');
assert(!root.files?.some((file) => file.endsWith('.ko.md')), 'translated docs are not packaged');

const readme = await readFile('README.md', 'utf8');
assert(!readme.includes('ARCHITECTURE.ko.md'), 'README has no translated-doc link');
const markdownDocs = (await readdir('docs', { recursive: true }))
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.replaceAll('\\', '/'));
for (const required of [
  'ARCHITECTURE.md',
  'GLOSSARY.md',
  'OPERATIONS.md',
  'intents/00-project.md',
  'intents/0001-audit-and-refactor.md',
]) {
  assert(markdownDocs.includes(required), `documentation includes ${required}`);
}
assert(!markdownDocs.some((file) => file.endsWith('.ko.md')), 'documentation is English-only');

for (const platform of selectedPlatforms(undefined)) {
  const manifest = JSON.parse(await readFile(`${platform.directory}/package.json`, 'utf8'));
  assert(manifest.os?.length === 1 && manifest.os[0] === 'linux', `${platform.arch} OS`);
  assert(manifest.cpu?.length === 1 && manifest.cpu[0] === platform.arch, `${platform.arch} CPU`);
  assert(manifest.exports?.['./bin/micro-sandbox'] === './bin/micro-sandbox', `${platform.arch} export`);
  assert(manifest.bin?.['micro-sandbox-native'] === 'bin/micro-sandbox', `${platform.arch} executable`);
}

if (!sourceOnly) {
  for (const platform of selectedPlatforms(current)) {
    const binary = `${platform.directory}/bin/micro-sandbox`;
    await access(binary, constants.X_OK);
    const info = await stat(binary);
    assert(info.isFile(), `${platform.arch} binary file`);
    const contents = await readFile(binary);
    const header = contents.subarray(0, 64);
    assert(header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), `${platform.arch} ELF`);
    assert(header.readUInt16LE(18) === platform.elfMachine, `${platform.arch} ELF architecture`);
    const programOffset = Number(header.readBigUInt64LE(32));
    const entrySize = header.readUInt16LE(54);
    const entryCount = header.readUInt16LE(56);
    const hasInterpreter = Array.from({ length: entryCount }, (_, index) =>
      contents.readUInt32LE(programOffset + index * entrySize),
    ).includes(3);
    assert(!hasInterpreter, `${platform.arch} static ELF`);
  }
}

function assert(condition, label) {
  if (!condition) throw new Error(`Package verification failed: ${label}`);
}
