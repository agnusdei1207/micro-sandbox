import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from '../dist/index.js';
import { imageReencodeJob } from '../examples/reencode-image.mjs';
import { scriptJob } from '../examples/run-script.mjs';

test('core exports only generic sandbox capabilities', () => {
  assert.equal('sanitizeFile' in api, false);
  assert.equal('sanitizeImage' in api, false);
  assert.equal('sanitizeHtmlDocument' in api, false);
  assert.equal('runInLinuxKernelSandbox' in api, false);
  assert.equal(typeof api.createSandbox, 'function');
});

test('recipes compose caller-owned tools through the generic job request', () => {
  const image = imageReencodeJob(Buffer.from('pixels'));
  assert.equal(image.command, '/usr/bin/magick');
  assert.deepEqual(image.args, ['/input/upload', '-strip', '/output/safe.png']);
  assert.deepEqual(image.artifacts.inputs[0].data, Buffer.from('pixels'));

  const script = scriptJob('console.log("isolated")');
  assert.equal(script.command, '/usr/bin/node');
  assert.deepEqual(script.args, ['-e', 'console.log("isolated")']);
});
