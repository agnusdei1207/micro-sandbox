import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as api from '../dist/index.js';
import { imageReencodeJob } from '../examples/reencode-image.mjs';
import { scriptJob } from '../examples/run-script.mjs';

const isolation = {
  userNamespace: true,
  pidNamespace: true,
  mountNamespace: true,
  networkNamespace: true,
  ipcNamespace: true,
  utsNamespace: true,
  cgroupNamespace: true,
  cgroupV2: true,
  seccomp: true,
  noNewPrivileges: true,
  capabilitiesDropped: true,
  pivotRoot: true,
} as const;

test('core exports only generic sandbox capabilities', () => {
  assert.equal('sanitizeFile' in api, false);
  assert.equal('sanitizeImage' in api, false);
  assert.equal('sanitizeHtmlDocument' in api, false);
  assert.equal('runInLinuxKernelSandbox' in api, false);
  assert.equal(typeof api.createSandbox, 'function');
});

test('script recipe runs without hidden runtime registration', async () => {
  const requests: unknown[] = [];
  const sandbox = new api.Sandbox({}, async () => ({
    async request<T>(_type: string, payload: unknown): Promise<T> {
      requests.push(payload);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputLimitExceeded: false,
        oomKilled: false,
        stdoutBase64: Buffer.from('isolated\n').toString('base64'),
        stderrBase64: '',
        isolation,
        metrics: { durationMs: 1, peakMemoryBytes: 0 },
      } as T;
    },
    async close() {},
  }));

  try {
    const result = await sandbox.run(scriptJob('console.log("isolated")'));
    assert.equal(result.stdout.toString(), 'isolated\n');
    assert.equal((requests[0] as { command: string }).command, '/usr/bin/node');
  } finally {
    await sandbox.close();
  }
});

test('image recipe runs without hidden runtime registration and raises both input byte limits', async () => {
  const input = Buffer.alloc(9 * 1024 * 1024, 0x5a);
  const output = Buffer.from('safe image');
  const job = imageReencodeJob(input, { inputBytes: 16 * 1024 * 1024 });

  const sandbox = new api.Sandbox({}, async () => ({
    async request<T>(_type: string, payload: unknown): Promise<T> {
      const request = payload as {
        command: string;
        workspace: { path: string };
      };
      assert.equal(request.command, '/usr/bin/magick');
      await writeFile(`${request.workspace.path}/output/safe.png`, output);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputLimitExceeded: false,
        oomKilled: false,
        stdoutBase64: '',
        stderrBase64: '',
        isolation,
        metrics: { durationMs: 1, peakMemoryBytes: 0 },
        artifacts: [{
          path: 'safe.png',
          size: output.length,
          sha256: createHash('sha256').update(output).digest('hex'),
        }],
      } as T;
    },
    async close() {},
  }));

  try {
    const result = await sandbox.run(job);
    assert.deepEqual(result.artifacts[0]?.data, output);
  } finally {
    await sandbox.close();
  }
});
