import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import process from 'node:process';

const current = process.argv.find((argument) => argument.startsWith('--current='))?.split('=')[1];
const packages = [
  { directory: 'npm/linux-x64', name: 'micro-sandbox-linux-x64', cpu: 'x64', machine: 0x3e },
  { directory: 'npm/linux-arm64', name: 'micro-sandbox-linux-arm64', cpu: 'arm64', machine: 0xb7 },
];

const root = JSON.parse(await readFile('package.json', 'utf8'));
const version = root.version;
assert(root.name === '@agnusdei12071207/micro-sandbox', 'main package name');
assert(typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version), 'main package version');
assert(root.engines?.node === '>=24.18.0', 'Node LTS engine');
assert(root.type === 'module', 'ESM package type');
assert(root.exports?.['.']?.import === './dist/index.js', 'ESM export');
assert(root.exports?.['.']?.types === './dist/index.d.ts', 'type export');
assert(root.optionalDependencies?.['micro-sandbox-linux-x64'] === version, 'x64 dependency');
assert(root.optionalDependencies?.['micro-sandbox-linux-arm64'] === version, 'ARM64 dependency');
assert(root.files?.includes('docs/ARCHITECTURE.md'), 'English architecture is packaged');
assert(!root.files?.some((file) => file.endsWith('.ko.md')), 'translated docs are not packaged');

const readme = await readFile('README.md', 'utf8');
assert(!readme.includes('ARCHITECTURE.ko.md'), 'README has no translated-doc link');
const markdownDocs = (await readdir('docs')).filter((file) => file.endsWith('.md'));
assert(
  markdownDocs.length === 1 && markdownDocs[0] === 'ARCHITECTURE.md',
  'docs contains only the English architecture',
);

for (const platform of packages) {
  const manifest = JSON.parse(await readFile(`${platform.directory}/package.json`, 'utf8'));
  assert(manifest.name === platform.name, `${platform.cpu} package name`);
  assert(manifest.version === version, `${platform.cpu} package version`);
  assert(manifest.os?.length === 1 && manifest.os[0] === 'linux', `${platform.cpu} OS`);
  assert(manifest.cpu?.length === 1 && manifest.cpu[0] === platform.cpu, `${platform.cpu} CPU`);
  assert(manifest.exports?.['./bin/micro-sandbox'] === './bin/micro-sandbox', `${platform.cpu} export`);
  assert(manifest.bin?.['micro-sandbox-native'] === 'bin/micro-sandbox', `${platform.cpu} executable`);

  if (!process.argv.includes('--source-only') && (!current || current === platform.cpu)) {
    const binary = `${platform.directory}/bin/micro-sandbox`;
    await access(binary, constants.X_OK);
    const info = await stat(binary);
    assert(info.isFile(), `${platform.cpu} binary file`);
    const contents = await readFile(binary);
    const header = contents.subarray(0, 64);
    assert(header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), `${platform.cpu} ELF`);
    assert(header.readUInt16LE(18) === platform.machine, `${platform.cpu} ELF architecture`);
    const programOffset = Number(header.readBigUInt64LE(32));
    const entrySize = header.readUInt16LE(54);
    const entryCount = header.readUInt16LE(56);
    const hasInterpreter = Array.from({ length: entryCount }, (_, index) =>
      contents.readUInt32LE(programOffset + index * entrySize),
    ).includes(3);
    assert(!hasInterpreter, `${platform.cpu} static ELF`);
  }
}

function assert(condition, label) {
  if (!condition) throw new Error(`Package verification failed: ${label}`);
}
