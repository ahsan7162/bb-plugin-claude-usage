// Release guard: bb installs this plugin with a full `git clone`, so every branch and tag ships with
// every release. README media is a GitHub attachment (dragged into the README on github.com), never git.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const MEDIA = /\.(mp4|mov|webm|mkv|avi|gif|png|jpe?g|webp)$/i;
const MAX_BYTES = 1_000_000;

test("no media or large file in any branch or tag", (t) => {
  let objects: string;
  try {
    // Every blob reachable from any branch or tag, history included: that is what a clone downloads.
    const list = execFileSync("git", ["rev-list", "--objects", "--branches", "--tags"], { encoding: "utf8", maxBuffer: 64 << 20 });
    objects = execFileSync("git", ["cat-file", "--batch-check=%(objecttype) %(objectsize) %(rest)"], {
      input: list,
      encoding: "utf8",
      maxBuffer: 64 << 20,
    });
  } catch {
    return t.skip("not a git checkout");
  }
  const blobs = objects
    .split("\n")
    .map((line) => line.match(/^blob (\d+) (.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ size: Number(m[1]), path: m[2]! }));
  assert.deepEqual(blobs.filter((b) => MEDIA.test(b.path)).map((b) => b.path), [], "README media is a GitHub attachment, not a file in git");
  assert.deepEqual(blobs.filter((b) => b.size > MAX_BYTES).map((b) => `${b.path} (${b.size} B)`), [], "files over 1 MB ship with every install");
});
