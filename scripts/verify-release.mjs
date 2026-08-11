import { readFile } from 'node:fs/promises';
import process from 'node:process';

const root = JSON.parse(await readFile('package.json', 'utf8'));
const expectedTag = `v${root.version}`;
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
if (tag !== expectedTag) {
  throw new Error(`Release tag ${JSON.stringify(tag)} must equal ${expectedTag}`);
}
for (const directory of ['npm/linux-x64', 'npm/linux-arm64']) {
  const platform = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'));
  if (platform.version !== root.version) {
    throw new Error(`${platform.name} version ${platform.version} must equal ${root.version}`);
  }
}
