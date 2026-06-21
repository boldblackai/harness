// Shared helpers for harness e2e tests.
//
// Strategy: shadow `docker`/`container` with a tiny shim on PATH that prints
// `<RUNTIME>_INVOKED <args>` to stdout and exits 0. We then run the real
// built CLI under various flag combinations and assert:
//   - process exit code
//   - stdout/stderr text
//   - the exact runtime args the CLI produced

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const CLI = path.join(REPO_ROOT, "bin", "harness.js");

// These are ESM live bindings — reassigned in before(), visible to importers.
export let SHIM_DIR;
export let WORK_DIR;
export let ENV_FILE;
export let SAMPLE_FILE;

function ensureBuilt() {
  if (!fs.existsSync(CLI)) {
    throw new Error(`Build first: ${CLI} not found. Run \`pnpm build\`.`);
  }
}

function makeRuntimeShim(dir, binaryName, marker) {
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, binaryName);
  fs.writeFileSync(
    shim,
    `#!/usr/bin/env bash
echo "${marker} $*"
exit 0
`,
    { mode: 0o755 },
  );
  return shim;
}

export function makeDockerShim(dir) {
  return makeRuntimeShim(dir, "docker", "DOCKER_INVOKED");
}

export function makeContainerShim(dir) {
  return makeRuntimeShim(dir, "container", "CONTAINER_INVOKED");
}

export function runCli(args, { extraEnv = {}, input = null } = {}) {
  const env = {
    ...process.env,
    PATH: `${SHIM_DIR}:${process.env.PATH}`,
    // Skip cosign verification; we never want a real network call here.
    HARNESS_IMAGE_TAG: "test-tag",
    ...extraEnv,
  };
  const opts = {
    cwd: WORK_DIR,
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  };
  if (input !== null) opts.input = input;
  return spawnSync("node", [CLI, ...args], opts);
}

// Generalized: returns the token list after any `*_INVOKED` marker
// (DOCKER_INVOKED or CONTAINER_INVOKED), regardless of which runtime ran.
export function runtimeArgs(stdout, marker) {
  const lines = stdout.split("\n");
  const line = marker
    ? lines.find((l) => l.startsWith(`${marker} `))
    : lines.find((l) => /^\w+_INVOKED /.test(l));
  if (!line) return null;
  return line
    .replace(/^\w+_INVOKED /, "")
    .split(" ")
    .filter(Boolean);
}

export function dockerArgs(stdout) {
  return runtimeArgs(stdout, "DOCKER_INVOKED");
}

export function containerArgs(stdout) {
  return runtimeArgs(stdout, "CONTAINER_INVOKED");
}

export function normalizeCwd(cwd, home) {
  let normalized = cwd;
  if (normalized.startsWith(home)) {
    normalized = normalized.slice(home.length);
  }
  normalized = normalized.replace(/\//g, "_");
  if (normalized === "") {
    normalized = "_home";
  }
  return normalized;
}

/** Returns true if the `script` command is available (needed for PTY tests). */
export function hasScript() {
  return (
    spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" })
      .status === 0
  );
}

// Singleton guard: ensures before/after hooks register exactly once
// regardless of how many test files import this module.
let _setup = false;
export function setupIfNecessary() {
  if (_setup) return;
  _setup = true;

  before(() => {
    ensureBuilt();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-"));
    SHIM_DIR = path.join(tmp, "shim");
    WORK_DIR = path.join(tmp, "work");
    fs.mkdirSync(WORK_DIR, { recursive: true });
    makeDockerShim(SHIM_DIR);
    makeContainerShim(SHIM_DIR);

    ENV_FILE = path.join(tmp, ".env");
    fs.writeFileSync(ENV_FILE, "OPENROUTER_API_KEY=fake\n");

    SAMPLE_FILE = path.join(tmp, "script.py");
    fs.writeFileSync(SAMPLE_FILE, 'print("hi")\n');
  });

  after(() => {
    // best-effort cleanup; ignore errors
    try {
      fs.rmSync(path.dirname(SHIM_DIR), { recursive: true, force: true });
    } catch {}
  });
}
