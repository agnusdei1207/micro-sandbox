import { readFile } from 'node:fs/promises';
import { runNpm } from './lib/exec.mjs';
import { publishUnlessPresent } from './lib/npm-publish.mjs';
import { PLATFORMS } from './lib/platforms.mjs';
import { verifyReleaseArtifacts } from './release-artifacts.mjs';

// Publishes the checksum-verified release artifacts with provenance. A version
// already in the registry is skipped only when its integrity matches.
const root = JSON.parse(await readFile('package.json', 'utf8'));
const tarballs = verifyReleaseArtifacts({ directory: 'artifacts', mainName: root.name, version: root.version });
// Fail on a broken token even when every package already exists.
runNpm(['whoami'], { label: 'npm authentication' });
for (const name of [...PLATFORMS.map((platform) => platform.name), root.name]) {
  publishUnlessPresent({
    name,
    version: root.version,
    tarball: tarballs.get(name),
    provenance: true,
    npm: (args) => runNpm(args, { capture: true, allowFailure: true }),
  });
}
