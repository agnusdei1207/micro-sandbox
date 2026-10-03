import process from 'node:process';
import { run } from './lib/exec.mjs';
import { assertVersionsSynced } from './lib/versions.mjs';

// Usage: node scripts/verify-release.mjs <tag>
// The checked-out commit must be the tag commit, or a descendant of it whose
// only difference from the tag is package-lock.json (the post-publication
// lockfile refresh). Requires full history and tags (fetch-depth: 0).
const version = assertVersionsSynced('.');
const expectedTag = `v${version}`;
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (tag !== expectedTag) {
  throw new Error(`Release tag ${JSON.stringify(tag)} must equal ${expectedTag}`);
}

const tagCommit = git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], true);
if (tagCommit.status !== 0) {
  throw new Error(`Release tag ${tag} does not exist in this checkout; fetch tags with full history`);
}
const head = git(['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim();
if (head !== tagCommit.stdout.trim()) {
  if (git(['merge-base', '--is-ancestor', tag, 'HEAD'], true).status !== 0) {
    throw new Error(`HEAD ${head} is not a descendant of release tag ${tag}`);
  }
  const diff = git(['diff', '--quiet', tag, 'HEAD', '--', '.', ':(exclude)package-lock.json'], true);
  if (diff.status !== 0) {
    const changed = git(['diff', '--name-only', tag, 'HEAD', '--', '.', ':(exclude)package-lock.json']).stdout.trim();
    throw new Error(`HEAD differs from release tag ${tag} beyond package-lock.json:\n${changed}`);
  }
}

function git(args, allowFailure = false) {
  return run('git', args, { capture: true, allowFailure, label: `git ${args[0]}` });
}
