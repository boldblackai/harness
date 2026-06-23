import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  CLI,
  ENV_FILE,
  REPO_ROOT,
  SAMPLE_FILE,
  SHIM_DIR,
  WORK_DIR,
  containerArgs,
  dockerArgs,
  hasScript,
  makeContainerShim,
  makeDockerShim,
  normalizeCwd,
  runCli,
  runtimeArgsAny,
  setupIfNecessary,
} from "./helpers.mjs";

setupIfNecessary();

// ---- argument parsing & validation -----------------------------------------

test("--help exits 0 and prints USAGE", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: harness/);
  assert.match(r.stdout, /--prompt/);
  assert.match(r.stdout, /--no-verify/);
  assert.match(r.stdout, /--ephemeral/);
  assert.match(r.stdout, /pi, opencode, hermes/);
});

test("-h exits 0 and prints USAGE", () => {
  const r = runCli(["-h"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: harness/);
});

test("--help documents HARNESS_IMAGE_TAG environment variable", () => {
  // PR #13 added HARNESS_IMAGE_TAG to the help output. Lock that in so
  // future changes to USAGE don't silently drop documented env vars.
  const r = runCli(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  // The env var name itself must appear.
  assert.match(r.stdout, /HARNESS_IMAGE_TAG/);
  // And it must be in the dedicated "Environment variables:" section
  // so users can find it (not buried in prose).
  assert.match(r.stdout, /Environment variables:[\s\S]*HARNESS_IMAGE_TAG/);
  // And the description must explain what it does (override image tag).
  assert.match(r.stdout, /HARNESS_IMAGE_TAG[\s\S]*[Dd]ocker image tag/);
});

test("unrecognized flags emit a warning on stderr", () => {
  const r = runCli(["--bogus-flag", "--another-fake", "-p", "noop"]);
  assert.equal(r.status, 0);
  assert.match(
    r.stderr,
    /warning: unrecognized flag\(s\): --bogus-flag, --another-fake/,
  );
});

test("recognized flags do not emit a warning", () => {
  const r = runCli(["--no-verify", "-p", "noop"]);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /unrecognized flag/);
});

test("unknown agent fails fast with helpful error", () => {
  const r = runCli(["-a", "bogus-agent", "-p", "noop"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown agent/);
  assert.match(r.stderr, /Available:.*pi/);
});

test("missing --env-file fails with descriptive error", () => {
  const r = runCli(["-e", "/tmp/does-not-exist.env", "-p", "x"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /env file not found/);
});

test("missing --file fails with descriptive error", () => {
  const r = runCli(["-f", "/tmp/does-not-exist.py", "-p", "x"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /file not found/);
});

test("--file pointing at a directory fails", () => {
  const r = runCli(["-f", WORK_DIR, "-p", "x"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /requires a file, not a directory/);
});

// ---- HARNESS_IMAGE_TAG / cosign skip ---------------------------------------

test("HARNESS_IMAGE_TAG short-circuits cosign verification", () => {
  const r = runCli(["-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /skipping cosign verification/);
  const args = runtimeArgsAny(r.stdout);
  assert.ok(args, "expected *_INVOKED line");
  // image is the last positional before container cmd; for pi it's REGISTRY:test-tag
  assert.ok(
    args.some((a) => a === "ghcr.io/boldblackai/harness:test-tag"),
    `expected pi image in args: ${args.join(" ")}`,
  );
});

test("--no-verify still invokes docker successfully (no real cosign call)", () => {
  // Functional invariant: with --no-verify the CLI must not block on cosign
  // and must reach the docker invocation. We don't assert on informational
  // stderr lines because minimist's `--no-X => X=false` convention can cause
  // the "HARNESS_IMAGE_TAG is set" notice to still print (harmless).
  const r = runCli(["--no-verify", "-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /refusing to verify/);
  assert.doesNotMatch(r.stderr, /image signature verification failed/);
  const args = runtimeArgsAny(r.stdout);
  assert.ok(args, "expected *_INVOKED line");
});

// ---- env-file forwarding ---------------------------------------------------

test("--env-file is passed to docker as --env-file <abs>", () => {
  const r = runCli(["-e", ENV_FILE, "-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = runtimeArgsAny(r.stdout);
  const i = a.indexOf("--env-file");
  assert.notEqual(i, -1);
  assert.equal(a[i + 1], ENV_FILE); // resolved to abs path; ENV_FILE already abs
});

// ---- cloud/local mode (HARNESS_CLOUD_MODE) ---------------------------------

test("-e without --local sets HARNESS_CLOUD_MODE=1 (cloud mode)", () => {
  const r = runCli(["-e", ENV_FILE, "-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = runtimeArgsAny(r.stdout);
  const idx = a.findIndex(
    (v, i) => v === "-e" && a[i + 1] === "HARNESS_CLOUD_MODE=1",
  );
  assert.notEqual(idx, -1, `HARNESS_CLOUD_MODE=1 not found in: ${a.join(" ")}`);
});

test("no -e does NOT set HARNESS_CLOUD_MODE (local mode)", () => {
  const r = runCli(["-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = runtimeArgsAny(r.stdout);
  const has = a.some(
    (v, i) => v === "-e" && a[i + 1]?.startsWith("HARNESS_CLOUD_MODE"),
  );
  assert.ok(
    !has,
    `HARNESS_CLOUD_MODE should not be set without -e: ${a.join(" ")}`,
  );
});

test("-e with --local does NOT set HARNESS_CLOUD_MODE (forced local)", () => {
  const r = runCli(["-e", ENV_FILE, "--local", "-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = runtimeArgsAny(r.stdout);
  // --env-file should still be present
  assert.notEqual(a.indexOf("--env-file"), -1);
  const has = a.some(
    (v, i) => v === "-e" && a[i + 1]?.startsWith("HARNESS_CLOUD_MODE"),
  );
  assert.ok(
    !has,
    `HARNESS_CLOUD_MODE should not be set with --local: ${a.join(" ")}`,
  );
});

test("cloud mode works for all agents (pi, opencode, hermes)", () => {
  for (const agent of ["pi", "opencode", "hermes"]) {
    const r = runCli(["-a", agent, "-e", ENV_FILE, "-p", "noop"]);
    assert.equal(r.status, 0, r.stderr);
    const a = runtimeArgsAny(r.stdout);
    const has = a.some(
      (v, i) => v === "-e" && a[i + 1] === "HARNESS_CLOUD_MODE=1",
    );
    assert.ok(has, `${agent}: HARNESS_CLOUD_MODE=1 expected: ${a.join(" ")}`);
  }
});

test("--help documents --local flag", () => {
  const r = spawnSync("node", [CLI, "--help"], { encoding: "utf8" });
  assert.match(r.stdout, /--local/);
  assert.match(r.stdout, /local mode/i);
});

// ---- file mount vs cwd mount -----------------------------------------------

test("--file mounts only the file at /workspace/<basename>", () => {
  const r = runCli(["-f", SAMPLE_FILE, "-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = runtimeArgsAny(r.stdout);
  const vIdx = a.indexOf("-v");
  assert.notEqual(vIdx, -1);
  assert.equal(a[vIdx + 1], `${SAMPLE_FILE}:/workspace/script.py`);
});

test("default mount is cwd:/workspace", () => {
  const r = runCli(["-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = runtimeArgsAny(r.stdout);
  const vIdx = a.indexOf("-v");
  assert.notEqual(vIdx, -1);
  assert.equal(a[vIdx + 1], `${WORK_DIR}:/workspace`);
});

// ---- security flags --------------------------------------------------------

test("docker invocation always includes hardening flags", () => {
  const r = runCli(["-p", "noop"], {
    extraEnv: { HARNESS_CONTAINER_RUNTIME: "docker" },
  });
  const a = dockerArgs(r.stdout);
  assert.ok(a.includes("--rm"));
  assert.ok(a.includes("--cap-drop=ALL"));
  assert.ok(a.includes("--cap-add=NET_RAW"));
  const sIdx = a.indexOf("--security-opt");
  assert.notEqual(sIdx, -1);
  assert.equal(a[sIdx + 1], "no-new-privileges:true");
  // seccomp profile blocks AF_ALG socket creation
  const sIdx2 = a.indexOf("--security-opt", sIdx + 1);
  assert.notEqual(sIdx2, -1);
  assert.match(a[sIdx2 + 1], /^seccomp=.*block-af-alg\.json$/);
  // -w /workspace is set
  const wIdx = a.indexOf("-w");
  assert.notEqual(wIdx, -1);
  assert.equal(a[wIdx + 1], "/workspace");
});
