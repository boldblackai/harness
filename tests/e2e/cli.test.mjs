// E2E tests for the harness CLI.
//
// Strategy: shadow `docker` with a tiny shim on PATH that prints
// `DOCKER_INVOKED <args>` to stdout and exits 0. We then run the real
// built CLI under various flag combinations and assert:
//   - process exit code
//   - stdout/stderr text
//   - the exact docker args the CLI produced
//
// This exercises the full CLI: minimist parsing, agent adapters, env-file
// validation, file-mount validation, persistence directory creation,
// adapter-specific docker args (e.g. OPENCODE_MODEL), volume mounts, and
// the cosign verification skip path (HARNESS_IMAGE_TAG and --no-verify).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(REPO_ROOT, "bin", "harness.js");

let SHIM_DIR;
let WORK_DIR;
let ENV_FILE;
let SAMPLE_FILE;

function ensureBuilt() {
  if (!fs.existsSync(CLI)) {
    throw new Error(`Build first: ${CLI} not found. Run \`pnpm build\`.`);
  }
}

function makeRuntimeShim(dir, binaryName, marker) {
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, binaryName);
  // Echo invocation prefix so the CLI's own stderr is distinguishable.
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

function makeDockerShim(dir) {
  return makeRuntimeShim(dir, "docker", "DOCKER_INVOKED");
}

function makeContainerShim(dir) {
  return makeRuntimeShim(dir, "container", "CONTAINER_INVOKED");
}

function runCli(args, { extraEnv = {}, input = null } = {}) {
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
function runtimeArgs(stdout, marker) {
  const lines = stdout.split("\n");
  const line = marker
    ? lines.find((l) => l.startsWith(`${marker} `))
    : lines.find((l) => /^\w+_INVOKED /.test(l));
  if (!line) return null;
  // Split safely: shims join with spaces, but our test fixtures never
  // contain literal spaces inside individual args.
  return line
    .replace(/^\w+_INVOKED /, "")
    .split(" ")
    .filter(Boolean);
}

function dockerArgs(stdout) {
  return runtimeArgs(stdout, "DOCKER_INVOKED");
}

function containerArgs(stdout) {
  return runtimeArgs(stdout, "CONTAINER_INVOKED");
}

function normalizeCwd(cwd, home) {
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
  const args = dockerArgs(r.stdout);
  assert.ok(args, "expected DOCKER_INVOKED line");
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
  const args = dockerArgs(r.stdout);
  assert.ok(args, "expected DOCKER_INVOKED line");
});

// ---- pi adapter ------------------------------------------------------------

test("pi: prompt is forwarded as `pi -p <prompt>`", () => {
  const r = runCli(["-p", "hello pi"]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  // last 3 args should be: <image> pi -p hello pi (joined)
  // We just assert ordering of the agent command at the tail.
  const tail = a.slice(a.indexOf("pi"));
  assert.deepEqual(tail.slice(0, 3), ["pi", "-p", "hello"]);
  assert.equal(tail[3], "pi"); // "pi" is second word of the prompt — split by space
});

test("pi: --model is forwarded with --provider ollama in local mode", () => {
  const r = runCli(["-p", "noop", "-m", "anthropic/claude-sonnet-4-5"]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  const idx = a.indexOf("pi");
  assert.notEqual(idx, -1);
  // In local mode (no env file), pi passes --provider ollama alongside --model
  // so the model is routed to LM Studio even when the model name contains slashes.
  assert.deepEqual(a.slice(idx, idx + 7), [
    "pi",
    "-p",
    "noop",
    "--provider",
    "ollama",
    "--model",
    "anthropic/claude-sonnet-4-5",
  ]);
});

test("pi: --model with --env-file does NOT inject --provider ollama (env mode)", () => {
  // Inverse of the local-mode case above. When the user supplies --env-file,
  // the provider/credentials are configured via env vars (e.g. OPENROUTER_API_KEY),
  // and the CLI must NOT override that with `--provider ollama`. This test
  // locks down the boundary so future refactors don't accidentally inject
  // --provider in env-file mode (or drop it in local mode).
  const r = runCli([
    "-e",
    ENV_FILE,
    "-p",
    "noop",
    "-m",
    "anthropic/claude-sonnet-4-5",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  const idx = a.indexOf("pi");
  assert.notEqual(idx, -1);
  // pi command tail is exactly: pi -p noop --model <model>
  assert.deepEqual(a.slice(idx, idx + 5), [
    "pi",
    "-p",
    "noop",
    "--model",
    "anthropic/claude-sonnet-4-5",
  ]);
  // And no --provider flag anywhere in pi's argv.
  const tail = a.slice(idx);
  assert.equal(
    tail.indexOf("--provider"),
    -1,
    `unexpected --provider in env-file mode: ${tail.join(" ")}`,
  );
});

test("pi: interactive (no -p, no piped stdin) with --model emits 'pi --provider ollama --model X' (no -p)", () => {
  // Covers the `prompt === null` branch in PiAdapter.buildCommand. That
  // branch is only reachable when process.stdin.isTTY === true, so we
  // allocate a PTY via util-linux `script` to fake an interactive shell.
  // The docker shim exits 0 immediately, so the CLI returns right after
  // emitting the DOCKER_INVOKED line.
  //
  // NOTE: `script` is part of bsdmainutils / util-linux and is preinstalled
  // on the ubuntu-latest runner. If a runner ever drops it this test must
  // be skipped (see top-level conditional below).
  const which = spawnSync("sh", ["-c", "command -v script"], {
    encoding: "utf8",
  });
  if (which.status !== 0) {
    // Skip on platforms without `script` (rare; ubuntu-latest has it).
    return;
  }
  const r = spawnSync(
    "script",
    ["-qfec", `node ${CLI} -m anthropic/claude-sonnet-4-5`, "/dev/null"],
    {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HOME: path.dirname(SHIM_DIR),
        XDG_DATA_HOME: path.join(path.dirname(SHIM_DIR), ".local", "share"),
      },
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  // `script` injects CR characters; strip them before parsing.
  const cleaned = r.stdout.replace(/\r/g, "");
  const a = dockerArgs(cleaned);
  assert.ok(a, `expected DOCKER_INVOKED line in: ${cleaned}`);
  const idx = a.indexOf("pi");
  assert.notEqual(idx, -1);
  // No -p anywhere in pi's argv (this is the no-prompt branch).
  const tail = a.slice(idx);
  assert.equal(
    tail.indexOf("-p"),
    -1,
    `unexpected -p in interactive mode: ${tail.join(" ")}`,
  );
  // Exactly: pi --provider ollama --model <model>
  assert.deepEqual(a.slice(idx, idx + 5), [
    "pi",
    "--provider",
    "ollama",
    "--model",
    "anthropic/claude-sonnet-4-5",
  ]);
});

// ---- opencode adapter ------------------------------------------------------

test("opencode: image tag is `opencode-<version>`", () => {
  const r = runCli(["-a", "opencode", "-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  assert.ok(
    a.some((s) => s === "ghcr.io/boldblackai/harness:opencode-test-tag"),
    `expected opencode image: ${a.join(" ")}`,
  );
});

test("opencode: --env-file is forwarded (env-file is adapter-agnostic)", () => {
  // The existing --env-file test only exercises the pi adapter. --env-file
  // is plumbed at the docker level (envFileArgs is built before the adapter
  // is selected), so it MUST work for opencode too. Lock that contract.
  const r = runCli(["-a", "opencode", "-e", ENV_FILE, "-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  const eIdx = a.indexOf("--env-file");
  assert.notEqual(eIdx, -1, `--env-file missing in: ${a.join(" ")}`);
  // Must be the absolute path (path.resolve in run()).
  assert.equal(a[eIdx + 1], path.resolve(ENV_FILE));
  // And opencode is still the agent.
  assert.notEqual(a.indexOf("opencode"), -1);
});

test("opencode: --model is passed via OPENCODE_MODEL env, not CLI", () => {
  const r = runCli([
    "-a",
    "opencode",
    "-p",
    "noop",
    "-m",
    "anthropic/claude-sonnet-4-5",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  // -e OPENCODE_MODEL=...
  const eIdx = a.findIndex(
    (v, i) => v === "-e" && a[i + 1]?.startsWith("OPENCODE_MODEL="),
  );
  assert.notEqual(
    eIdx,
    -1,
    `expected -e OPENCODE_MODEL=...; got ${a.join(" ")}`,
  );
  assert.equal(a[eIdx + 1], "OPENCODE_MODEL=anthropic/claude-sonnet-4-5");
  // container cmd is just `opencode run noop`
  const cmdIdx = a.indexOf(
    "opencode",
    a.indexOf("ghcr.io/boldblackai/harness:opencode-test-tag"),
  );
  assert.deepEqual(a.slice(cmdIdx, cmdIdx + 3), ["opencode", "run", "noop"]);
});

// ---- hermes adapter --------------------------------------------------------

test("hermes: no -m, no -p emits exactly ['hermes','chat'] (no stray flags)", () => {
  // Covers the no-model + interactive branch of HermesAdapter.buildCommand:
  //   args = ["hermes","chat"]; no -m pushed (model falsy);
  //   no -q pushed (prompt === null when no -p and no piped stdin).
  // Locks that future refactors don't accidentally inject defaults for
  // either flag in the no-args path.
  //
  // Requires a PTY so process.stdin.isTTY === true and the prompt stays null.
  const which = spawnSync("sh", ["-c", "command -v script"], {
    encoding: "utf8",
  });
  if (which.status !== 0) {
    return;
  }
  const r = spawnSync(
    "script",
    ["-qfec", `node ${CLI} -a hermes`, "/dev/null"],
    {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HOME: path.dirname(SHIM_DIR),
        XDG_DATA_HOME: path.join(path.dirname(SHIM_DIR), ".local", "share"),
      },
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  const cleaned = r.stdout.replace(/\r/g, "");
  const a = dockerArgs(cleaned);
  assert.ok(a, `expected DOCKER_INVOKED line in: ${cleaned}`);
  const idx = a.indexOf("hermes");
  assert.notEqual(idx, -1);
  // Exactly the two-token tail; no -m, no -q.
  assert.deepEqual(a.slice(idx), ["hermes", "chat"]);
});

test("hermes: model is passed via -m <provider/model>", () => {
  const r = runCli([
    "-a",
    "hermes",
    "-p",
    "noop",
    "-m",
    "anthropic/claude-sonnet-4-5",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  const cmdStart = a.indexOf("hermes");
  assert.notEqual(cmdStart, -1);
  assert.deepEqual(a.slice(cmdStart, cmdStart + 6), [
    "hermes",
    "chat",
    "-m",
    "anthropic/claude-sonnet-4-5",
    "-q",
    "noop",
  ]);
});

// ---- env-file forwarding ---------------------------------------------------

test("--env-file is passed to docker as --env-file <abs>", () => {
  const r = runCli(["-e", ENV_FILE, "-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  const i = a.indexOf("--env-file");
  assert.notEqual(i, -1);
  assert.equal(a[i + 1], ENV_FILE); // resolved to abs path; ENV_FILE already abs
});

// ---- cloud/local mode (HARNESS_CLOUD_MODE) ---------------------------------

test("-e without --local sets HARNESS_CLOUD_MODE=1 (cloud mode)", () => {
  const r = runCli(["-e", ENV_FILE, "-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  const idx = a.findIndex(
    (v, i) => v === "-e" && a[i + 1] === "HARNESS_CLOUD_MODE=1",
  );
  assert.notEqual(idx, -1, `HARNESS_CLOUD_MODE=1 not found in: ${a.join(" ")}`);
});

test("no -e does NOT set HARNESS_CLOUD_MODE (local mode)", () => {
  const r = runCli(["-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
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
  const a = dockerArgs(r.stdout);
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
    const a = dockerArgs(r.stdout);
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
  const a = dockerArgs(r.stdout);
  const vIdx = a.indexOf("-v");
  assert.notEqual(vIdx, -1);
  assert.equal(a[vIdx + 1], `${SAMPLE_FILE}:/workspace/script.py`);
});

test("default mount is cwd:/workspace", () => {
  const r = runCli(["-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  const vIdx = a.indexOf("-v");
  assert.notEqual(vIdx, -1);
  assert.equal(a[vIdx + 1], `${WORK_DIR}:/workspace`);
});

// ---- security flags --------------------------------------------------------

test("docker invocation always includes hardening flags", () => {
  const r = runCli(["-p", "noop"]);
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

// ---- persistence behaviour --------------------------------------------------

test("one-shot run (-p) is implicitly ephemeral: no .harness/ dir created", () => {
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-home-"));
  const xdgData = path.join(homeDir, ".local", "share");
  fs.mkdirSync(xdgData, { recursive: true });
  const r = spawnSync("node", [CLI, "-p", "noop"], {
    cwd: localWork,
    env: {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH}`,
      HARNESS_IMAGE_TAG: "test-tag",
      HOME: homeDir,
      XDG_DATA_HOME: xdgData,
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    fs.existsSync(path.join(localWork, ".harness")),
    false,
    ".harness/ should NOT be created for one-shot runs",
  );
  assert.equal(
    fs.existsSync(path.join(xdgData, "harness")),
    false,
    "XDG persist dir should NOT be created for one-shot runs",
  );
});

test("piped stdin is implicitly ephemeral and forwards prompt", () => {
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-home-"));
  const xdgData = path.join(homeDir, ".local", "share");
  fs.mkdirSync(xdgData, { recursive: true });
  const r = spawnSync("node", [CLI], {
    cwd: localWork,
    env: {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH}`,
      HARNESS_IMAGE_TAG: "test-tag",
      HOME: homeDir,
      XDG_DATA_HOME: xdgData,
    },
    input: "piped prompt\n",
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(localWork, ".harness")), false);
  assert.equal(
    fs.existsSync(path.join(xdgData, "harness")),
    false,
    "XDG persist dir should NOT be created for piped stdin",
  );
  const a = dockerArgs(r.stdout);
  // pi adapter receives the piped prompt via -p
  const idx = a.indexOf("pi");
  assert.notEqual(idx, -1);
  assert.equal(a[idx + 1], "-p");
  assert.match(a[idx + 2], /piped/);
});

test("interactive (PTY) creates persistence dir at XDG_DATA_HOME/harness/<normalized>/<agent>/", () => {
  // Inverse of the two implicit-ephemeral cases above: when the user is
  // truly interactive (TTY, no -p, no piped stdin) and does NOT pass
  // --ephemeral, the run() path must materialize the persistence dirs the
  // adapter advertises via persistMounts(). For the pi adapter the persist
  // root is `$XDG_DATA_HOME/harness/<normalized-cwd>/pi/`.
  //
  // This locks the boundary so a future refactor can't accidentally drop
  // the fs.mkdirSync() call or invert the `effectiveEphemeral` flag.
  //
  // Requires a PTY (process.stdin.isTTY === true is the gate). We allocate
  // one via util-linux `script`, same as the pi no-prompt test above.
  const which = spawnSync("sh", ["-c", "command -v script"], {
    encoding: "utf8",
  });
  if (which.status !== 0) {
    // Skip on platforms without `script` (rare; ubuntu-latest has it).
    return;
  }
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-home-"));
  const xdgData = path.join(homeDir, ".local", "share");
  fs.mkdirSync(xdgData, { recursive: true });
  const r = spawnSync("script", ["-qfec", `node ${CLI}`, "/dev/null"], {
    cwd: localWork,
    env: {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH}`,
      HARNESS_IMAGE_TAG: "test-tag",
      HOME: homeDir,
      XDG_DATA_HOME: xdgData,
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const nCwd = normalizeCwd(localWork, homeDir);
  assert.equal(
    fs.existsSync(path.join(xdgData, "harness", nCwd, "pi")),
    true,
    `XDG_DATA_HOME/harness/${nCwd}/pi/ should be created in interactive mode without --ephemeral`,
  );
  // .harness/ must NOT be created in CWD
  assert.equal(
    fs.existsSync(path.join(localWork, ".harness")),
    false,
    ".harness/ must NOT be created in CWD (XDG migration)",
  );
  // And the docker args must include a -v mount targeting /home/harness/.pi/agent.
  const cleaned = r.stdout.replace(/\r/g, "");
  const a = dockerArgs(cleaned);
  assert.ok(a, `expected DOCKER_INVOKED line in: ${cleaned}`);
  const mountTarget = "/home/harness/.pi/agent";
  const hasMount = a.some((arg) => arg.endsWith(`:${mountTarget}`));
  assert.ok(
    hasMount,
    `expected a -v mount ending in :${mountTarget} in: ${a.join(" ")}`,
  );
});

test("--ephemeral overrides interactive PTY: no .harness/ dir, no persist mount", () => {
  // Inverse of the interactive-PTY persistence test: when the user is in a
  // real PTY (TTY, no -p, no piped stdin) but EXPLICITLY passes --ephemeral,
  // the run() path must NOT create persistence dirs and must NOT include
  // the adapter's persistMounts() in the docker args.
  //
  // This locks the precedence of the --ephemeral flag in
  // `effectiveEphemeral = argv.ephemeral || promptArg !== null || !process.stdin.isTTY`
  // so a future refactor can't accidentally drop the OR-with-argv.ephemeral
  // and re-introduce host-side directories for opt-out users.
  const which = spawnSync("sh", ["-c", "command -v script"], {
    encoding: "utf8",
  });
  if (which.status !== 0) {
    return; // platforms without `script` (rare; ubuntu-latest has it).
  }
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-home-"));
  const xdgData = path.join(homeDir, ".local", "share");
  fs.mkdirSync(xdgData, { recursive: true });
  const r = spawnSync(
    "script",
    ["-qfec", `node ${CLI} --ephemeral`, "/dev/null"],
    {
      cwd: localWork,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HOME: homeDir,
        XDG_DATA_HOME: xdgData,
      },
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    fs.existsSync(path.join(localWork, ".harness")),
    false,
    ".harness/ must NOT be created when --ephemeral is passed in interactive mode",
  );
  assert.equal(
    fs.existsSync(path.join(xdgData, "harness")),
    false,
    "XDG persist dir must NOT be created when --ephemeral is passed",
  );
  const cleaned = r.stdout.replace(/\r/g, "");
  const a = dockerArgs(cleaned);
  assert.ok(a, `expected DOCKER_INVOKED line in: ${cleaned}`);
  const mountTarget = "/home/harness/.pi/agent";
  const hasMount = a.some((arg) => arg.endsWith(`:${mountTarget}`));
  assert.equal(
    hasMount,
    false,
    `--ephemeral must suppress persistMounts(); got mount in: ${a.join(" ")}`,
  );
});
test("piped whitespace-only stdin takes no-prompt branch (pi has no -p)", () => {
  // The stdin handler at the bottom of run() is:
  //   run(input.trim() ? input : null)
  //
  // i.e. if the piped payload is whitespace-only (spaces, tabs, newlines),
  // the trim() is empty and we pass `null` -> the no-prompt branch.
  //
  // Behaviour to lock:
  //   - exit code 0
  //   - implicitly ephemeral (piped, !isTTY) so NO .harness/ dir
  //   - pi adapter's docker cmd has NO `-p` arg (interactive pi, just `pi`)
  //
  // This guards against a regression where `input` (raw, untrimmed) gets
  // passed through and the adapter receives `-p "   \n"` instead.
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-home-"));
  const xdgData = path.join(homeDir, ".local", "share");
  fs.mkdirSync(xdgData, { recursive: true });
  const r = spawnSync("node", [CLI], {
    cwd: localWork,
    env: {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH}`,
      HARNESS_IMAGE_TAG: "test-tag",
      HOME: homeDir,
      XDG_DATA_HOME: xdgData,
    },
    input: "   \n\t  \n",
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    fs.existsSync(path.join(localWork, ".harness")),
    false,
    "piped stdin is implicitly ephemeral; .harness/ must NOT be created",
  );
  assert.equal(
    fs.existsSync(path.join(xdgData, "harness")),
    false,
    "XDG persist dir must NOT be created for piped whitespace stdin",
  );
  const a = dockerArgs(r.stdout);
  assert.ok(a, `expected DOCKER_INVOKED line in: ${r.stdout}`);
  const piIdx = a.indexOf("pi");
  assert.notEqual(piIdx, -1, `expected 'pi' in docker args: ${a.join(" ")}`);
  const tail = a.slice(piIdx);
  assert.equal(
    tail.includes("-p"),
    false,
    `whitespace stdin must NOT inject -p; got cmd: ${tail.join(" ")}`,
  );
});

test("opencode interactive (no --ephemeral) creates all three persistence dirs and mounts", () => {
  // OpenCodeAdapter.persistMounts() returns three distinct mounts:
  //   - config -> /home/harness/.config/opencode
  //   - share  -> /home/harness/.local/share/opencode
  //   - state  -> /home/harness/.local/state/opencode
  //
  // The pi adapter test only locks a single empty-hostSubpath mount. This
  // test locks the multi-mount shape so a future refactor can't silently
  // drop one of the three OpenCode persistence buckets (which would lose
  // user history / config across container runs).
  const which = spawnSync("sh", ["-c", "command -v script"], {
    encoding: "utf8",
  });
  if (which.status !== 0) {
    return; // skip on platforms without `script`.
  }
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-home-"));
  const xdgData = path.join(homeDir, ".local", "share");
  fs.mkdirSync(xdgData, { recursive: true });
  const r = spawnSync(
    "script",
    ["-qfec", `node ${CLI} -a opencode`, "/dev/null"],
    {
      cwd: localWork,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HOME: homeDir,
        XDG_DATA_HOME: xdgData,
      },
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);

  // All three host-side persistence buckets must be created under XDG.
  const nCwd = normalizeCwd(localWork, homeDir);
  for (const sub of ["config", "share", "state"]) {
    assert.equal(
      fs.existsSync(path.join(xdgData, "harness", nCwd, "opencode", sub)),
      true,
      `XDG_DATA_HOME/harness/${nCwd}/opencode/${sub}/ should be created in interactive mode`,
    );
  }

  // All three docker -v mounts must target the documented container paths.
  const cleaned = r.stdout.replace(/\r/g, "");
  const a = dockerArgs(cleaned);
  assert.ok(a, `expected DOCKER_INVOKED line in: ${cleaned}`);
  const targets = [
    "/home/harness/.config/opencode",
    "/home/harness/.local/share/opencode",
    "/home/harness/.local/state/opencode",
  ];
  for (const t of targets) {
    assert.ok(
      a.some((arg) => arg.endsWith(`:${t}`)),
      `expected -v mount ending in :${t} in: ${a.join(" ")}`,
    );
  }
});

// ---- user skills mounting --------------------------------------------------
//
// All skills tests use a temp directory as HOME via extraEnv so the CLI's
// os.homedir() resolves there.  This avoids creating/removing dirs in the
// caller's real home directory and eliminates the risk of leaving artifacts
// behind on test failure.

function makeSkillsHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-skills-"));
  return {
    home: tmp,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

test("existing ~/.agents/skills is mounted into the container", () => {
  const { home, cleanup } = makeSkillsHome();
  fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
  try {
    const r = runCli(["-p", "noop"], { extraEnv: { HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.agents/skills")),
      `expected .agents/skills mount in: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
  }
});

test("existing ~/.claude/skills is mounted into the container", () => {
  const { home, cleanup } = makeSkillsHome();
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  try {
    const r = runCli(["-p", "noop"], { extraEnv: { HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.claude/skills")),
      `expected .claude/skills mount in: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
  }
});

test("--no-skills suppresses all skills mounts", () => {
  const { home, cleanup } = makeSkillsHome();
  fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  try {
    const r = runCli(["--no-skills", "-p", "noop"], {
      extraEnv: { HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.equal(
      a.some((arg) => arg.includes("/.agents/skills")),
      false,
      `--no-skills must not mount .agents/skills: ${a.join(" ")}`,
    );
    assert.equal(
      a.some((arg) => arg.includes("/.claude/skills")),
      false,
      `--no-skills must not mount .claude/skills: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
  }
});

test("non-existent skills directories are silently skipped", () => {
  // Empty temp HOME — no skills dirs exist, so both should be skipped.
  const { home, cleanup } = makeSkillsHome();
  try {
    const r = runCli(["-p", "noop"], { extraEnv: { HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.equal(
      a.some((arg) => arg.includes("/.agents/skills")),
      false,
      `non-existent .agents/skills must not be mounted: ${a.join(" ")}`,
    );
    assert.equal(
      a.some((arg) => arg.includes("/.claude/skills")),
      false,
      `non-existent .claude/skills must not be mounted: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
  }
});

test("skills mounts work with --file mode", () => {
  const { home, cleanup } = makeSkillsHome();
  fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
  try {
    const r = runCli(["--file", SAMPLE_FILE, "-p", "noop"], {
      extraEnv: { HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    // The file mount and skills mount should both be present.
    assert.ok(
      a.some((arg) => arg.endsWith(":/workspace/script.py")),
      `expected file mount in: ${a.join(" ")}`,
    );
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.agents/skills")),
      `expected skills mount in --file mode: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
  }
});

test("--help documents --no-skills", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--no-skills/);
});

// ---- --volumes / -v flag ---------------------------------------------------

test("--help documents --volumes", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--volumes/);
});

test("-v short flag works same as --volumes", () => {
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-vol-"));
  const r = runCli(["-p", "noop", "-v", `${extraDir}:/mnt/data`]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  assert.ok(a, "expected DOCKER_INVOKED line");
  assert.ok(
    a.includes(`${extraDir}:/mnt/data`),
    `expected user volume mount in args: ${a.join(" ")}`,
  );
});

test("--volumes with valid spec passes through as -v to docker", () => {
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-vol-"));
  const r = runCli(["-p", "noop", "--volumes", `${extraDir}:/mnt/data`]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  assert.ok(a, "expected DOCKER_INVOKED line");
  assert.ok(
    a.includes(`${extraDir}:/mnt/data`),
    `expected user volume mount in args: ${a.join(" ")}`,
  );
});

test("--volumes with absolute host path resolves correctly", () => {
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-vol-"));
  const r = runCli(["-p", "noop", "--volumes", `${extraDir}:/opt/thing:ro`]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  assert.ok(
    a.includes(`${extraDir}:/opt/thing:ro`),
    `expected volume with opts in args: ${a.join(" ")}`,
  );
});

test("--volumes with non-existent host path fails", () => {
  const r = runCli(["-p", "noop", "--volumes", "/nonexistent/path:/mnt/data"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /volume source path does not exist/);
});

test("--volumes with missing colon fails", () => {
  const r = runCli(["-p", "noop", "--volumes", "nospec"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /invalid volume spec/);
});

test("--volumes with relative host path is resolved to absolute", () => {
  const r = runCli(["-p", "noop", "--volumes", "relative:/mnt/data"]);
  // The CLI resolves relative paths via path.resolve, so it should fail
  // because "relative" doesn't exist in WORK_DIR.
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /volume source path does not exist/);
});

test("multiple --volumes flags all pass through", () => {
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "harness-vol-"));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "harness-vol-"));
  const r = runCli([
    "-p",
    "noop",
    "--volumes",
    `${dir1}:/mnt/a`,
    "--volumes",
    `${dir2}:/mnt/b`,
  ]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  assert.ok(
    a.includes(`${dir1}:/mnt/a`),
    `expected first volume in args: ${a.join(" ")}`,
  );
  assert.ok(
    a.includes(`${dir2}:/mnt/b`),
    `expected second volume in args: ${a.join(" ")}`,
  );
});

test("--volumes does not break existing workspace mount", () => {
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-vol-"));
  const r = runCli(["-p", "noop", "--volumes", `${extraDir}:/mnt/data`]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  // workspace mount must still be present
  assert.ok(
    a.includes(`${WORK_DIR}:/workspace`),
    `expected workspace mount in args: ${a.join(" ")}`,
  );
  // user volume must also be present
  assert.ok(
    a.includes(`${extraDir}:/mnt/data`),
    `expected user volume in args: ${a.join(" ")}`,
  );
});

test("--volumes is forwarded alongside --file mode (both mounts present)", () => {
  // --file replaces the default cwd:/workspace mount with a single
  // file:/workspace/<basename> mount. Locking down here that user-supplied
  // --volumes still land in the docker args next to the file mount, so a
  // user can `harness --file script.py --volumes ~/secrets:/home/harness/.config/x`
  // for credentials without losing the file mount or vice versa.
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-vol-file-"));
  try {
    const r = runCli([
      "--file",
      SAMPLE_FILE,
      "--volumes",
      `${extraDir}:/mnt/data`,
      "-p",
      "noop",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    // file mount must be present
    assert.ok(
      a.some((arg) => arg.endsWith(":/workspace/script.py")),
      `expected --file mount in: ${a.join(" ")}`,
    );
    // user volume must be present
    assert.ok(
      a.includes(`${extraDir}:/mnt/data`),
      `expected --volumes mount in: ${a.join(" ")}`,
    );
    // default cwd:/workspace mount must NOT be present (file mode replaces it)
    assert.equal(
      a.some((arg) => arg === `${WORK_DIR}:/workspace`),
      false,
      `--file mode must not mount cwd:/workspace; got: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(extraDir, { recursive: true, force: true });
  }
});

test("--volumes is forwarded alongside interactive persistence mounts", () => {
  // In interactive (PTY, no -p, no --ephemeral) mode the CLI creates the
  // persistence directory under XDG_DATA_HOME and adds its mount(s) to docker
  // args. Lock down here that user-supplied --volumes are appended AFTER the
  // persist mounts and BOTH land in the final docker invocation so a future
  // refactor cannot accidentally drop one path when the other is in play.
  const which = spawnSync("sh", ["-c", "command -v script"], {
    encoding: "utf8",
  });
  if (which.status !== 0) {
    return; // skip on platforms without `script`.
  }
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-home-"));
  const xdgData = path.join(homeDir, ".local", "share");
  fs.mkdirSync(xdgData, { recursive: true });
  const extraDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "harness-vol-persist-"),
  );
  try {
    const r = spawnSync(
      "script",
      ["-qfec", `node ${CLI} --volumes ${extraDir}:/mnt/data`, "/dev/null"],
      {
        cwd: localWork,
        env: {
          ...process.env,
          PATH: `${SHIM_DIR}:${process.env.PATH}`,
          HARNESS_IMAGE_TAG: "test-tag",
          HOME: homeDir,
          XDG_DATA_HOME: xdgData,
        },
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 0, r.stderr);

    // interactive non-ephemeral path created the persist dir under XDG
    const nCwd = normalizeCwd(localWork, homeDir);
    assert.equal(
      fs.existsSync(path.join(xdgData, "harness", nCwd, "pi")),
      true,
      `XDG_DATA_HOME/harness/${nCwd}/pi/ should be created in interactive mode`,
    );

    const cleaned = r.stdout.replace(/\r/g, "");
    const a = dockerArgs(cleaned);
    assert.ok(a, `expected DOCKER_INVOKED line in: ${cleaned}`);
    // persist mount target must be present
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.pi/agent")),
      `expected persist mount in: ${a.join(" ")}`,
    );
    // user volume must also be present
    assert.ok(
      a.includes(`${extraDir}:/mnt/data`),
      `expected --volumes mount alongside persist: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(extraDir, { recursive: true, force: true });
  }
});

test("--volumes is forwarded alongside --file mode (both mounts present)", () => {
  // --file replaces the default cwd:/workspace mount with a single
  // file:/workspace/<basename> mount. Locking down here that user-supplied
  // --volumes still land in the docker args next to the file mount, so a
  // user can `harness --file script.py --volumes ~/secrets:/home/harness/.config/x`
  // for credentials without losing the file mount or vice versa.
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-vol-file-"));
  try {
    const r = runCli([
      "--file",
      SAMPLE_FILE,
      "--volumes",
      `${extraDir}:/mnt/data`,
      "-p",
      "noop",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    // file mount must be present
    assert.ok(
      a.some((arg) => arg.endsWith(":/workspace/script.py")),
      `expected --file mount in: ${a.join(" ")}`,
    );
    // user volume must be present
    assert.ok(
      a.includes(`${extraDir}:/mnt/data`),
      `expected --volumes mount in: ${a.join(" ")}`,
    );
    // default cwd:/workspace mount must NOT be present (file mode replaces it)
    assert.equal(
      a.some((arg) => arg === `${WORK_DIR}:/workspace`),
      false,
      `--file mode must not mount cwd:/workspace; got: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(extraDir, { recursive: true, force: true });
  }
});

test("skills path that is a regular file (not directory) is silently skipped", () => {
  // The skills mount loop only mounts a path when it both exists AND is a
  // directory (`fs.statSync(sd.host).isDirectory()`). Lock down the negative
  // case: if the user has a regular file at ~/.agents/skills (e.g. a leftover
  // file from a prior incompatible layout), the CLI must NOT pass it as a
  // -v mount to docker. Otherwise docker would mount a file at a path that
  // /home/harness expects to be a directory and the container would either
  // error or worse, hide other content.
  const { home, cleanup } = makeSkillsHome();
  // Create ~/.agents/skills as a FILE (not a directory).
  fs.mkdirSync(path.join(home, ".agents"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".agents", "skills"),
    "this is a file, not a skills directory\n",
  );
  // Also create a real .claude/skills DIR so we can confirm the directory
  // path still mounts and only the file path is skipped.
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  try {
    const r = runCli(["-p", "noop"], { extraEnv: { HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");

    // The .agents/skills FILE must NOT be mounted.
    assert.equal(
      a.some((arg) => arg.includes("/.agents/skills")),
      false,
      `regular file at ~/.agents/skills must not be mounted; got: ${a.join(" ")}`,
    );

    // The real .claude/skills DIR must still mount, proving the loop didn't
    // bail wholesale and only the non-directory entry was skipped.
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.claude/skills")),
      `existing .claude/skills directory must still mount: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
  }
});

test("--volumes is forwarded alongside --file mode (both mounts present)", () => {
  // --file replaces the default cwd:/workspace mount with a single
  // file:/workspace/<basename> mount. Locking down here that user-supplied
  // --volumes still land in the docker args next to the file mount, so a
  // user can `harness --file script.py --volumes ~/secrets:/home/harness/.config/x`
  // for credentials without losing the file mount or vice versa.
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-vol-file-"));
  try {
    const r = runCli([
      "--file",
      SAMPLE_FILE,
      "--volumes",
      `${extraDir}:/mnt/data`,
      "-p",
      "noop",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    // file mount must be present
    assert.ok(
      a.some((arg) => arg.endsWith(":/workspace/script.py")),
      `expected --file mount in: ${a.join(" ")}`,
    );
    // user volume must be present
    assert.ok(
      a.includes(`${extraDir}:/mnt/data`),
      `expected --volumes mount in: ${a.join(" ")}`,
    );
    // default cwd:/workspace mount must NOT be present (file mode replaces it)
    assert.equal(
      a.some((arg) => arg === `${WORK_DIR}:/workspace`),
      false,
      `--file mode must not mount cwd:/workspace; got: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(extraDir, { recursive: true, force: true });
  }
});

test("--volumes coexists with skills mounts and the workspace mount (no interference)", () => {
  // Three-way: an existing user skills directory at ~/.agents/skills, a
  // user --volumes spec, and the default cwd:/workspace mount must all
  // pass through to docker simultaneously. Locks the contract that none
  // of these orthogonal mount sources interfere with each other.
  const { home, cleanup } = makeSkillsHome();
  fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
  const extraDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "harness-vol-skills-"),
  );
  try {
    const r = runCli(["-p", "noop", "--volumes", `${extraDir}:/mnt/data`], {
      extraEnv: { HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");

    // Workspace mount.
    assert.ok(
      a.includes(`${WORK_DIR}:/workspace`),
      `expected workspace mount in: ${a.join(" ")}`,
    );
    // Skills mount.
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.agents/skills")),
      `expected .agents/skills mount in: ${a.join(" ")}`,
    );
    // User volume.
    assert.ok(
      a.includes(`${extraDir}:/mnt/data`),
      `expected --volumes mount in: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
    fs.rmSync(extraDir, { recursive: true, force: true });
  }
});

test("--volumes is forwarded alongside --file mode (both mounts present)", () => {
  // --file replaces the default cwd:/workspace mount with a single
  // file:/workspace/<basename> mount. Locking down here that user-supplied
  // --volumes still land in the docker args next to the file mount, so a
  // user can `harness --file script.py --volumes ~/secrets:/home/harness/.config/x`
  // for credentials without losing the file mount or vice versa.
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-vol-file-"));
  try {
    const r = runCli([
      "--file",
      SAMPLE_FILE,
      "--volumes",
      `${extraDir}:/mnt/data`,
      "-p",
      "noop",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    // file mount must be present
    assert.ok(
      a.some((arg) => arg.endsWith(":/workspace/script.py")),
      `expected --file mount in: ${a.join(" ")}`,
    );
    // user volume must be present
    assert.ok(
      a.includes(`${extraDir}:/mnt/data`),
      `expected --volumes mount in: ${a.join(" ")}`,
    );
    // default cwd:/workspace mount must NOT be present (file mode replaces it)
    assert.equal(
      a.some((arg) => arg === `${WORK_DIR}:/workspace`),
      false,
      `--file mode must not mount cwd:/workspace; got: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(extraDir, { recursive: true, force: true });
  }
});

test("--no-skills and --volumes are independent flags (skills suppressed, user volume forwarded)", () => {
  // The two v1.6.x mount-shaping flags are orthogonal: --no-skills
  // suppresses the skills mounts, --volumes appends a user mount.
  // Lock that BOTH effects fire when the flags are passed together,
  // so a future refactor that conflates them (e.g. shared codepath
  // accidentally short-circuits one when the other is set) breaks.
  const { home, cleanup } = makeSkillsHome();
  fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  const extraDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "harness-noskills-vol-"),
  );
  try {
    const r = runCli(
      ["--no-skills", "-p", "noop", "--volumes", `${extraDir}:/mnt/data`],
      { extraEnv: { HOME: home } },
    );
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");

    // --no-skills must suppress BOTH skills mounts even though the dirs exist.
    assert.equal(
      a.some((arg) => arg.includes("/.agents/skills")),
      false,
      `--no-skills must suppress .agents/skills; got: ${a.join(" ")}`,
    );
    assert.equal(
      a.some((arg) => arg.includes("/.claude/skills")),
      false,
      `--no-skills must suppress .claude/skills; got: ${a.join(" ")}`,
    );

    // --volumes user mount must STILL pass through.
    assert.ok(
      a.includes(`${extraDir}:/mnt/data`),
      `expected --volumes mount alongside --no-skills: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
    fs.rmSync(extraDir, { recursive: true, force: true });
  }
});

test("--volumes is forwarded alongside --file mode (both mounts present)", () => {
  // --file replaces the default cwd:/workspace mount with a single
  // file:/workspace/<basename> mount. Locking down here that user-supplied
  // --volumes still land in the docker args next to the file mount, so a
  // user can `harness --file script.py --volumes ~/secrets:/home/harness/.config/x`
  // for credentials without losing the file mount or vice versa.
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-vol-file-"));
  try {
    const r = runCli([
      "--file",
      SAMPLE_FILE,
      "--volumes",
      `${extraDir}:/mnt/data`,
      "-p",
      "noop",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    // file mount must be present
    assert.ok(
      a.some((arg) => arg.endsWith(":/workspace/script.py")),
      `expected --file mount in: ${a.join(" ")}`,
    );
    // user volume must be present
    assert.ok(
      a.includes(`${extraDir}:/mnt/data`),
      `expected --volumes mount in: ${a.join(" ")}`,
    );
    // default cwd:/workspace mount must NOT be present (file mode replaces it)
    assert.equal(
      a.some((arg) => arg === `${WORK_DIR}:/workspace`),
      false,
      `--file mode must not mount cwd:/workspace; got: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(extraDir, { recursive: true, force: true });
  }
});

test("--volumes appears after built-in mounts in docker args (last-wins override capability)", () => {
  // Docker's `-v` flag has "last wins" semantics for overlapping target
  // paths. The CLI assembles docker args as `...volumeArgs, ...userVolumeArgs`
  // (src/harness.ts:508-509), so user-supplied --volumes are appended AFTER
  // built-in mounts (workspace, skills, persist). This gives a real capability:
  // a user can override the default workspace mount with
  // `--volumes /tmp/sandbox:/workspace`, or shadow a skills directory with
  // `--volumes /tmp/empty:/home/harness/.agents/skills`.
  //
  // Lock that ordering boundary: a future refactor that prepends user volumes
  // (...userVolumeArgs, ...volumeArgs) would silently strip the override
  // capability, since the trailing built-in mount would now win.
  const { home, cleanup } = makeSkillsHome();
  fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-vol-order-"));
  try {
    const r = runCli(["-p", "noop", "--volumes", `${extraDir}:/mnt/data`], {
      extraEnv: { HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");

    // Find the index of each mount target's `-v` flag. We look for the
    // index of the value (e.g. `${WORK_DIR}:/workspace`) and assume `-v`
    // is at index-1.
    const workspaceIdx = a.indexOf(`${WORK_DIR}:/workspace`);
    const skillsIdx = a.findIndex((arg) =>
      arg.endsWith(":/home/harness/.agents/skills"),
    );
    const userIdx = a.indexOf(`${extraDir}:/mnt/data`);

    assert.notEqual(
      workspaceIdx,
      -1,
      `workspace mount missing: ${a.join(" ")}`,
    );
    assert.notEqual(skillsIdx, -1, `skills mount missing: ${a.join(" ")}`);
    assert.notEqual(userIdx, -1, `user volume missing: ${a.join(" ")}`);

    // User volume index must be strictly greater than every built-in
    // mount index, so docker's last-wins resolution favors the user.
    assert.ok(
      userIdx > workspaceIdx,
      `--volumes must appear AFTER workspace mount; user@${userIdx} workspace@${workspaceIdx} args=${a.join(" ")}`,
    );
    assert.ok(
      userIdx > skillsIdx,
      `--volumes must appear AFTER skills mount; user@${userIdx} skills@${skillsIdx} args=${a.join(" ")}`,
    );
  } finally {
    cleanup();
    fs.rmSync(extraDir, { recursive: true, force: true });
  }
});

test("--volumes is forwarded alongside --file mode (both mounts present)", () => {
  // --file replaces the default cwd:/workspace mount with a single
  // file:/workspace/<basename> mount. Locking down here that user-supplied
  // --volumes still land in the docker args next to the file mount, so a
  // user can `harness --file script.py --volumes ~/secrets:/home/harness/.config/x`
  // for credentials without losing the file mount or vice versa.
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-vol-file-"));
  try {
    const r = runCli([
      "--file",
      SAMPLE_FILE,
      "--volumes",
      `${extraDir}:/mnt/data`,
      "-p",
      "noop",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    // file mount must be present
    assert.ok(
      a.some((arg) => arg.endsWith(":/workspace/script.py")),
      `expected --file mount in: ${a.join(" ")}`,
    );
    // user volume must be present
    assert.ok(
      a.includes(`${extraDir}:/mnt/data`),
      `expected --volumes mount in: ${a.join(" ")}`,
    );
    // default cwd:/workspace mount must NOT be present (file mode replaces it)
    assert.equal(
      a.some((arg) => arg === `${WORK_DIR}:/workspace`),
      false,
      `--file mode must not mount cwd:/workspace; got: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(extraDir, { recursive: true, force: true });
  }
});

test("hermes interactive (no --ephemeral) creates persistence dir and mounts", () => {
  // HermesAdapter.persistMounts() returns a single mount:
  //   '' -> /home/harness/.hermes
  //
  // The empty hostSubpath means the persist root itself is mounted directly.
  const which = spawnSync("sh", ["-c", "command -v script"], {
    encoding: "utf8",
  });
  if (which.status !== 0) {
    return; // skip on platforms without `script`.
  }
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-home-"));
  const xdgData = path.join(homeDir, ".local", "share");
  fs.mkdirSync(xdgData, { recursive: true });
  const r = spawnSync(
    "script",
    ["-qfec", `node ${CLI} -a hermes`, "/dev/null"],
    {
      cwd: localWork,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HOME: homeDir,
        XDG_DATA_HOME: xdgData,
      },
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);

  // Host-side persistence dir must be created under XDG.
  const nCwd = normalizeCwd(localWork, homeDir);
  assert.equal(
    fs.existsSync(path.join(xdgData, "harness", nCwd, "hermes")),
    true,
    `XDG_DATA_HOME/harness/${nCwd}/hermes/ should be created in interactive mode`,
  );

  // Docker -v mount must target the default hermes home.
  const cleaned = r.stdout.replace(/\r/g, "");
  const a = dockerArgs(cleaned);
  assert.ok(a, `expected DOCKER_INVOKED line in: ${cleaned}`);
  assert.ok(
    a.some((arg) => arg.endsWith(":/home/harness/.hermes")),
    `expected -v mount ending in :/home/harness/.hermes in: ${a.join(" ")}`,
  );
});

test("--volumes is forwarded alongside --file mode (both mounts present)", () => {
  // --file replaces the default cwd:/workspace mount with a single
  // file:/workspace/<basename> mount. Locking down here that user-supplied
  // --volumes still land in the docker args next to the file mount, so a
  // user can `harness --file script.py --volumes ~/secrets:/home/harness/.config/x`
  // for credentials without losing the file mount or vice versa.
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-vol-file-"));
  try {
    const r = runCli([
      "--file",
      SAMPLE_FILE,
      "--volumes",
      `${extraDir}:/mnt/data`,
      "-p",
      "noop",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    // file mount must be present
    assert.ok(
      a.some((arg) => arg.endsWith(":/workspace/script.py")),
      `expected --file mount in: ${a.join(" ")}`,
    );
    // user volume must be present
    assert.ok(
      a.includes(`${extraDir}:/mnt/data`),
      `expected --volumes mount in: ${a.join(" ")}`,
    );
    // default cwd:/workspace mount must NOT be present (file mode replaces it)
    assert.equal(
      a.some((arg) => arg === `${WORK_DIR}:/workspace`),
      false,
      `--file mode must not mount cwd:/workspace; got: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(extraDir, { recursive: true, force: true });
  }
});

test("hermes: prompt is forwarded as `hermes chat -q <prompt>` (NOT -p)", () => {
  // HermesAdapter.buildCommand emits ["hermes","chat"] + ["-m", model] (if model)
  // + ["-q", prompt] (if prompt). The existing hermes test only locks the
  // no-model + no-prompt case ['hermes','chat']. Lock the prompt-forwarding
  // shape: it must be -q, NOT -p (-p is the pi flag), and the prompt must
  // immediately follow -q.
  //
  // Also lock the ordering when BOTH -m and -p are provided:
  // ["hermes","chat","-m","<model>","-q","<prompt>"]
  const r = runCli([
    "-a",
    "hermes",
    "-m",
    "anthropic/claude-sonnet-4-5",
    "-p",
    "summarize",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  assert.ok(a, "expected DOCKER_INVOKED line");

  const hermesIdx = a.indexOf("hermes");
  assert.notEqual(hermesIdx, -1, `expected 'hermes' in: ${a.join(" ")}`);
  // The container command tail must be exactly: hermes chat -m MODEL -q PROMPT
  const tail = a.slice(hermesIdx);
  assert.deepEqual(
    tail,
    ["hermes", "chat", "-m", "anthropic/claude-sonnet-4-5", "-q", "summarize"],
    `unexpected hermes tail: ${tail.join(" ")}`,
  );

  // And -p (the pi flag) must NOT appear in the hermes container cmd.
  assert.equal(
    tail.includes("-p"),
    false,
    `hermes must use -q, not -p; got tail: ${tail.join(" ")}`,
  );
});

test("--volumes is forwarded alongside --file mode (both mounts present)", () => {
  // --file replaces the default cwd:/workspace mount with a single
  // file:/workspace/<basename> mount. Locking down here that user-supplied
  // --volumes still land in the docker args next to the file mount, so a
  // user can `harness --file script.py --volumes ~/secrets:/home/harness/.config/x`
  // for credentials without losing the file mount or vice versa.
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-vol-file-"));
  try {
    const r = runCli([
      "--file",
      SAMPLE_FILE,
      "--volumes",
      `${extraDir}:/mnt/data`,
      "-p",
      "noop",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    // file mount must be present
    assert.ok(
      a.some((arg) => arg.endsWith(":/workspace/script.py")),
      `expected --file mount in: ${a.join(" ")}`,
    );
    // user volume must be present
    assert.ok(
      a.includes(`${extraDir}:/mnt/data`),
      `expected --volumes mount in: ${a.join(" ")}`,
    );
    // default cwd:/workspace mount must NOT be present (file mode replaces it)
    assert.equal(
      a.some((arg) => arg === `${WORK_DIR}:/workspace`),
      false,
      `--file mode must not mount cwd:/workspace; got: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(extraDir, { recursive: true, force: true });
  }
});

test("image tag mapping: pi gets bare tag, opencode/hermes get adapter-prefixed tags", () => {
  // getImage() at src/harness.ts has an asymmetric rule:
  //   pi       -> ghcr.io/boldblackai/harness:<TAG>
  //   opencode -> ghcr.io/boldblackai/harness:opencode-<TAG>
  //   hermes   -> ghcr.io/boldblackai/harness:hermes-<TAG>
  //
  // The existing test at line 309 (`opencode: image tag is "opencode-<version>"`)
  // only covers the opencode prefix path. Lock the **full mapping** here so
  // a future refactor can\'t accidentally:
  //   - add a "pi-" prefix to pi (which would break every existing pi user)
  //   - drop the prefix for opencode/hermes (which would map all 3 agents
  //     to the same image)
  const cases = [
    { agent: "pi", expectedTag: "test-tag" },
    { agent: "opencode", expectedTag: "opencode-test-tag" },
    { agent: "hermes", expectedTag: "hermes-test-tag" },
  ];
  for (const { agent, expectedTag } of cases) {
    const r = runCli(["-a", agent, "-p", "noop"], {
      extraEnv: { HARNESS_IMAGE_TAG: "test-tag" },
    });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, `expected DOCKER_INVOKED line for ${agent}`);
    const expectedImage = `ghcr.io/boldblackai/harness:${expectedTag}`;
    assert.ok(
      a.includes(expectedImage),
      `expected image '${expectedImage}' for agent '${agent}' in: ${a.join(" ")}`,
    );
    // Negative: the pi-prefixed form must NEVER appear.
    assert.equal(
      a.some((arg) => arg.startsWith("ghcr.io/boldblackai/harness:pi-")),
      false,
      `pi must never get a 'pi-' prefix; got: ${a.join(" ")}`,
    );
  }
});

// ----------------------------------------------------------------------------
// v1.7.x coverage bump (bundled to avoid the cli.test.mjs tail-append rebase
// chain that #47-#57 hit). All blocks below are pure tail-appends and exercise
// distinct, currently-uncovered behaviors of the shipped CLI as of c86e6f9.
// ----------------------------------------------------------------------------

test("default agent (no -a/--agent) is pi and image tag has no adapter prefix", () => {
  // Locks: src/harness.ts default agent fallback (`argv.agent ?? "pi"`)
  // AND getImage() pi-bare-tag asymmetry. PR #55 covered the per-adapter
  // mapping when -a is explicit; this covers the *default* (no flag) path.
  const r = runCli(["-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  assert.ok(a, "expected DOCKER_INVOKED line");
  // Image must be the bare-tag form, not opencode-* or hermes-*.
  const image = a.find((x) => x.startsWith("ghcr.io/boldblackai/harness:"));
  assert.ok(image, `expected image arg in: ${a.join(" ")}`);
  assert.ok(
    !/opencode-|hermes-/.test(image),
    `default agent should produce bare-tag image, got: ${image}`,
  );
  // Container cmd must start with the pi binary.
  const piIdx = a.indexOf("pi");
  assert.notEqual(piIdx, -1, "expected 'pi' in container cmd");
});

test("-a short alias selects the agent (parity with --agent)", () => {
  // The minimist alias map declares { a: "agent" }. PR #25 tested -a hermes
  // implicitly via runCli(["-a", "hermes", ...]) but never asserted that
  // the short form is *equivalent* to --agent. Lock that explicitly so a
  // future change that only handles --agent (long form) gets caught.
  const rShort = runCli(["-a", "hermes", "-p", "noop"]);
  const rLong = runCli(["--agent", "hermes", "-p", "noop"]);
  assert.equal(rShort.status, 0, rShort.stderr);
  assert.equal(rLong.status, 0, rLong.stderr);
  const aShort = dockerArgs(rShort.stdout);
  const aLong = dockerArgs(rLong.stdout);
  // Both must produce the same hermes-prefixed image and same container
  // command shape (slice from "hermes" forward).
  const imgShort = aShort.find((x) =>
    x.startsWith("ghcr.io/boldblackai/harness:"),
  );
  const imgLong = aLong.find((x) =>
    x.startsWith("ghcr.io/boldblackai/harness:"),
  );
  assert.equal(
    imgShort,
    imgLong,
    "image tag should match between -a and --agent",
  );
  assert.match(
    imgShort,
    /hermes-/,
    `expected hermes-prefixed image, got ${imgShort}`,
  );
  const idxShort = aShort.indexOf("hermes");
  const idxLong = aLong.indexOf("hermes");
  assert.deepEqual(aShort.slice(idxShort), aLong.slice(idxLong));
});

test("--agent=hermes (equals form) selects the agent", () => {
  // minimist accepts both `--agent X` and `--agent=X`. The equals form is
  // common in shell pipelines and CI configs. Lock it.
  const r = runCli(["--agent=hermes", "-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  assert.ok(a, "expected DOCKER_INVOKED line");
  const idx = a.indexOf("hermes");
  assert.notEqual(idx, -1, `expected 'hermes' in: ${a.join(" ")}`);
  // hermes adapter shape: hermes chat -q <prompt>
  assert.deepEqual(a.slice(idx, idx + 3), ["hermes", "chat", "-q"]);
  assert.equal(a[idx + 3], "noop");
});

test("opencode: prompt is forwarded as `opencode run <prompt>`", () => {
  // Symmetric to the merged hermes-prompt-shape test (#54) and the
  // pi -p test. OpenCodeAdapter.buildCommand returns
  //   ["opencode", "run", prompt]   when prompt !== null
  //   ["opencode"]                   when prompt === null
  // No prior test asserts the `run` subcommand position. Lock it.
  const r = runCli(["-a", "opencode", "-p", "summarize"]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  assert.ok(a, "expected DOCKER_INVOKED line");
  const idx = a.indexOf("opencode");
  assert.notEqual(idx, -1);
  // opencode adapter must emit exactly: opencode run summarize
  // (no stray flags between binary and subcommand).
  const tail = a.slice(idx);
  assert.deepEqual(
    tail,
    ["opencode", "run", "summarize"],
    `unexpected opencode tail: ${tail.join(" ")}`,
  );
});

test("piped stdin uses -i flag (no -t, no combined -it)", () => {
  // src/harness.ts: `const ttyFlags = interactive ? ["-it"] : ["-i"];`
  // When stdin is a pipe (the common CI / scripting case), the CLI must
  // emit a bare `-i`, never the combined `-it` (which would force a TTY
  // and break some shells). No existing test pins down the exact flag
  // shape on the no-TTY branch.
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  try {
    const r = spawnSync("node", [CLI], {
      cwd: localWork,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
      },
      input: "piped prompt\n",
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.ok(a.includes("-i"), `expected -i in: ${a.join(" ")}`);
    assert.ok(
      !a.includes("-it"),
      `piped stdin must not produce combined -it: ${a.join(" ")}`,
    );
    assert.ok(
      !a.includes("-t"),
      `piped stdin must not produce -t: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(localWork, { recursive: true, force: true });
  }
});

test("image arg immediately precedes the container command", () => {
  // Ordering invariant: the docker positional arg list ends with
  //   ... <image> <agent-binary> [args...]
  // where <agent-binary> is the first element of adapter.buildCommand().
  // No existing test pins this ordering, but reordering would be a real
  // regression (docker would treat the binary as the image).
  const r = runCli(["-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  assert.ok(a, "expected DOCKER_INVOKED line");
  const imgIdx = a.findIndex((x) =>
    x.startsWith("ghcr.io/boldblackai/harness:"),
  );
  assert.notEqual(imgIdx, -1, "expected an image arg");
  // The token immediately after the image must be the agent binary
  // (start of the adapter's container command).
  assert.equal(
    a[imgIdx + 1],
    "pi",
    `expected pi binary right after image; got: ${a.slice(imgIdx, imgIdx + 3).join(" ")}`,
  );
  // And the image must NOT appear earlier among the docker flags
  // (sanity: only one image arg, in the right slot).
  const firstImgIdx = a.indexOf(a[imgIdx]);
  assert.equal(firstImgIdx, imgIdx, "image should appear exactly once");
});

test('empty --volumes "" is silently coerced to no-volume (falsy-empty branch)', () => {
  // src/harness.ts initializes the volume list as
  //   Array.isArray(argv.volumes) ? argv.volumes
  //     : argv.volumes ? [argv.volumes]
  //     : [];
  // An empty string is JS-falsy so it falls into the `[]` branch and skips
  // the per-spec validation entirely. This is the right behavior for shell
  // scripts that build flags via expansion (e.g. `--volumes "$EXTRA_VOL"`
  // where EXTRA_VOL may be unset) - it should be a no-op, not a fatal
  // error. Lock the no-op behavior so a future stricter-validation pass
  // doesn't silently break script callers.
  const r = runCli(["--volumes", "", "-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  assert.ok(a, "expected DOCKER_INVOKED line");
  // No malformed empty-suffix mount string was added.
  assert.ok(
    !a.some((x) => x === ":" || x.endsWith(":") || x.startsWith(":")),
    `expected no malformed empty mount; got: ${a.join(" ")}`,
  );
  // The workspace mount must still be present (default behavior intact).
  const vIdx = a.indexOf("-v");
  assert.notEqual(vIdx, -1);
  assert.equal(a[vIdx + 1], `${WORK_DIR}:/workspace`);
});

test("--volumes with multi-colon options preserves the full option suffix", () => {
  // src/harness.ts builds the docker mount string as
  //   `${path.resolve(parts[0])}:${parts.slice(1).join(":")}`
  // i.e. it rejoins everything after the first colon back together. This
  // matters for docker mounts with multiple options like `:ro,Z` or
  // `:rw,delegated`, and for SELinux-relabel forms `:Z`. Existing tests
  // cover single-option `:ro` (line ~873). Multi-segment options (more
  // than one ":" in the suffix) exercise the slice/join contract.
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-vol-"));
  try {
    const spec = `${extraDir}:/opt/thing:ro:Z`;
    const r = runCli(["-p", "noop", "--volumes", spec]);
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    // The full suffix `:/opt/thing:ro:Z` must be preserved verbatim.
    assert.ok(
      a.includes(`${extraDir}:/opt/thing:ro:Z`),
      `expected multi-option mount preserved; got: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(extraDir, { recursive: true, force: true });
  }
});

// ---- CWD normalization (XDG persistence) ----------------------------------

test("normalizeCwd: CWD under home strips prefix, replaces / with _", () => {
  const which = spawnSync("sh", ["-c", "command -v script"], {
    encoding: "utf8",
  });
  if (which.status !== 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-norm-"));
  const homeDir = path.join(tmp, "home");
  const projectDir = path.join(homeDir, "projects", "foo");
  fs.mkdirSync(projectDir, { recursive: true });
  const xdgData = path.join(tmp, "xdg-data");
  fs.mkdirSync(xdgData, { recursive: true });
  try {
    const r = spawnSync("script", ["-qfec", `node ${CLI}`, "/dev/null"], {
      cwd: projectDir,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HOME: homeDir,
        XDG_DATA_HOME: xdgData,
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      fs.existsSync(path.join(xdgData, "harness", "_projects_foo", "pi")),
      true,
      "persist dir should be at XDG_DATA_HOME/harness/_projects_foo/pi/",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("normalizeCwd: CWD is exactly home dir → uses _home", () => {
  const which = spawnSync("sh", ["-c", "command -v script"], {
    encoding: "utf8",
  });
  if (which.status !== 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-norm-home-"));
  const homeDir = path.join(tmp, "myhome");
  fs.mkdirSync(homeDir, { recursive: true });
  const xdgData = path.join(tmp, "xdg-data");
  fs.mkdirSync(xdgData, { recursive: true });
  try {
    const r = spawnSync("script", ["-qfec", `node ${CLI}`, "/dev/null"], {
      cwd: homeDir,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HOME: homeDir,
        XDG_DATA_HOME: xdgData,
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      fs.existsSync(path.join(xdgData, "harness", "_home", "pi")),
      true,
      "persist dir should be at XDG_DATA_HOME/harness/_home/pi/",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("normalizeCwd: CWD not under home keeps full path with slashes replaced", () => {
  const which = spawnSync("sh", ["-c", "command -v script"], {
    encoding: "utf8",
  });
  if (which.status !== 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-norm-abs-"));
  const sandboxDir = path.join(tmp, "tmp", "sandbox");
  fs.mkdirSync(sandboxDir, { recursive: true });
  const xdgData = path.join(tmp, "xdg-data");
  fs.mkdirSync(xdgData, { recursive: true });
  const fakeHome = path.join(tmp, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  try {
    const r = spawnSync("script", ["-qfec", `node ${CLI}`, "/dev/null"], {
      cwd: sandboxDir,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HOME: fakeHome,
        XDG_DATA_HOME: xdgData,
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      fs.existsSync(path.join(xdgData, "harness")),
      true,
      "harness root should exist in XDG_DATA_HOME",
    );
    assert.equal(
      fs.existsSync(path.join(sandboxDir, ".harness")),
      false,
      ".harness/ must NOT be created in CWD",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- Mise mount tests ------------------------------------------------------

test("interactive mode creates mise dir and mounts it at /home/harness/.local/share/mise", () => {
  const which = spawnSync("sh", ["-c", "command -v script"], {
    encoding: "utf8",
  });
  if (which.status !== 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mise-"));
  const xdgData = path.join(tmp, "xdg-data");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(xdgData, { recursive: true });
  try {
    const r = spawnSync("script", ["-qfec", `node ${CLI}`, "/dev/null"], {
      cwd: workDir,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HOME: tmp,
        XDG_DATA_HOME: xdgData,
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    // Verify mise data dir on host
    const nCwd = normalizeCwd(workDir, tmp);
    const miseDir = path.join(xdgData, "harness", nCwd, "pi", "mise");
    assert.equal(
      fs.existsSync(miseDir),
      true,
      `mise dir should exist at ${miseDir}`,
    );
    // Verify mise state dir on host
    const miseStateDir = path.join(
      xdgData,
      "harness",
      nCwd,
      "pi",
      "mise-state",
    );
    assert.equal(
      fs.existsSync(miseStateDir),
      true,
      `mise-state dir should exist at ${miseStateDir}`,
    );
    // Verify docker mounts
    const cleaned = r.stdout.replace(/\r/g, "");
    const a = dockerArgs(cleaned);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.local/share/mise")),
      `expected mise data volume mount in: ${a.join(" ")}`,
    );
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.local/state/mise")),
      `expected mise state volume mount in: ${a.join(" ")}`,
    );
    // Verify npm dir on host
    const npmDir = path.join(xdgData, "harness", nCwd, "pi", "npm");
    assert.equal(
      fs.existsSync(npmDir),
      true,
      `npm dir should exist at ${npmDir}`,
    );
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.local/share/npm")),
      `expected npm volume mount in: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ephemeral mode (-p) does NOT create mise dir or mount", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mise-eph-"));
  const xdgData = path.join(tmp, "xdg-data");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(xdgData, { recursive: true });
  try {
    const r = spawnSync("node", [CLI, "-p", "noop"], {
      cwd: workDir,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HOME: tmp,
        XDG_DATA_HOME: xdgData,
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      fs.existsSync(path.join(xdgData, "harness")),
      false,
      "no persist dirs should exist in ephemeral mode",
    );
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.equal(
      a.some((arg) => arg.endsWith(":/home/harness/.local/share/mise")),
      false,
      "ephemeral mode must not mount mise data",
    );
    assert.equal(
      a.some((arg) => arg.endsWith(":/home/harness/.local/state/mise")),
      false,
      "ephemeral mode must not mount mise state",
    );
    assert.equal(
      a.some((arg) => arg.endsWith(":/home/harness/.local/share/npm")),
      false,
      "ephemeral mode must not mount npm",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- XDG_DATA_HOME override test -------------------------------------------

test("XDG_DATA_HOME override: persist dirs created at custom location", () => {
  const which = spawnSync("sh", ["-c", "command -v script"], {
    encoding: "utf8",
  });
  if (which.status !== 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-xdg-"));
  const customXdg = path.join(tmp, "custom-xdg");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(customXdg, { recursive: true });
  try {
    const r = spawnSync("script", ["-qfec", `node ${CLI}`, "/dev/null"], {
      cwd: workDir,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HOME: tmp,
        XDG_DATA_HOME: customXdg,
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      fs.existsSync(path.join(customXdg, "harness")),
      true,
      "harness root should exist under custom XDG_DATA_HOME",
    );
    const defaultXdg = path.join(tmp, ".local", "share");
    assert.equal(
      fs.existsSync(path.join(defaultXdg, "harness")),
      false,
      "no persist dir should exist under default ~/.local/share",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- No-.harness/ and deprecation tests ------------------------------------

test("no .harness/ directory is ever created in the CWD (XDG migration)", () => {
  const which = spawnSync("sh", ["-c", "command -v script"], {
    encoding: "utf8",
  });
  if (which.status !== 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-no-dot-"));
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const xdgData = path.join(tmp, "xdg-data");
  fs.mkdirSync(xdgData, { recursive: true });
  try {
    const r = spawnSync("script", ["-qfec", `node ${CLI}`, "/dev/null"], {
      cwd: workDir,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HOME: tmp,
        XDG_DATA_HOME: xdgData,
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      fs.existsSync(path.join(workDir, ".harness")),
      false,
      ".harness/ must NEVER be created in the CWD",
    );
    assert.equal(
      fs.existsSync(path.join(xdgData, "harness")),
      true,
      "persist data should exist under XDG_DATA_HOME",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("deprecation warning fires when old .harness/ directory exists in CWD", () => {
  const which = spawnSync("sh", ["-c", "command -v script"], {
    encoding: "utf8",
  });
  if (which.status !== 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-deprecat-"));
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(workDir, ".harness", "pi"), { recursive: true });
  const xdgData = path.join(tmp, "xdg-data");
  fs.mkdirSync(xdgData, { recursive: true });
  try {
    const r = spawnSync("script", ["-qfec", `node ${CLI}`, "/dev/null"], {
      cwd: workDir,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HOME: tmp,
        XDG_DATA_HOME: xdgData,
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    // When using script (PTY), stderr is merged into stdout
    const combined = r.stdout + r.stderr;
    assert.match(
      combined,
      /found.*\.harness.*persistence data now lives at/,
      "should emit deprecation warning about old .harness/ directory",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- --help XDG documentation test -----------------------------------------

test("--help documents XDG_DATA_HOME and XDG_CACHE_HOME environment variables", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /XDG_DATA_HOME/);
  assert.match(r.stdout, /XDG_CACHE_HOME/);
  assert.match(r.stdout, /Environment variables:[\s\S]*XDG_DATA_HOME/);
  assert.match(r.stdout, /\$XDG_DATA_HOME\/harness/);
});

// ---- global context files mounting (issue #85) -----------------------------
//
// A single host ~/.agents/AGENTS.md and ~/.claude/CLAUDE.md are bind-mounted
// into each agent's context directory. Reuses makeSkillsHome() for an isolated
// temp HOME.

function writeAgentsMd(home) {
  fs.mkdirSync(path.join(home, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(home, ".agents", "AGENTS.md"), "# global rules\n");
}

function writeClaudeMd(home) {
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# claude rules\n");
}

test("global ~/.agents/AGENTS.md is mounted to the pi context path", () => {
  const { home, cleanup } = makeSkillsHome();
  writeAgentsMd(home);
  try {
    const r = runCli(["-p", "noop"], { extraEnv: { HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.pi/agent/AGENTS.md")),
      `expected AGENTS.md mount at pi path in: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
  }
});

test("global ~/.agents/AGENTS.md is mounted to the opencode context path", () => {
  const { home, cleanup } = makeSkillsHome();
  writeAgentsMd(home);
  try {
    const r = runCli(["-a", "opencode", "-p", "noop"], {
      extraEnv: { HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.ok(
      a.some((arg) =>
        arg.endsWith(":/home/harness/.config/opencode/AGENTS.md"),
      ),
      `expected AGENTS.md mount at opencode path in: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
  }
});

test("global ~/.agents/AGENTS.md is mounted to the hermes context path", () => {
  const { home, cleanup } = makeSkillsHome();
  writeAgentsMd(home);
  try {
    const r = runCli(["-a", "hermes", "-p", "noop"], {
      extraEnv: { HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.hermes/AGENTS.md")),
      `expected AGENTS.md mount at hermes path in: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
  }
});

test("global ~/.claude/CLAUDE.md is mounted to the pi context path", () => {
  const { home, cleanup } = makeSkillsHome();
  writeClaudeMd(home);
  try {
    const r = runCli(["-p", "noop"], { extraEnv: { HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.pi/agent/CLAUDE.md")),
      `expected CLAUDE.md mount at pi path in: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
  }
});

test("global ~/.claude/CLAUDE.md is mounted to the opencode context path", () => {
  const { home, cleanup } = makeSkillsHome();
  writeClaudeMd(home);
  try {
    const r = runCli(["-a", "opencode", "-p", "noop"], {
      extraEnv: { HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.ok(
      a.some((arg) =>
        arg.endsWith(":/home/harness/.config/opencode/CLAUDE.md"),
      ),
      `expected CLAUDE.md mount at opencode path in: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
  }
});

test("AGENTS.md and CLAUDE.md are both mounted when both exist", () => {
  const { home, cleanup } = makeSkillsHome();
  writeAgentsMd(home);
  writeClaudeMd(home);
  try {
    const r = runCli(["-p", "noop"], { extraEnv: { HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.pi/agent/AGENTS.md")),
      `expected AGENTS.md mount in: ${a.join(" ")}`,
    );
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.pi/agent/CLAUDE.md")),
      `expected CLAUDE.md mount in: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
  }
});

test("--no-context-files suppresses all global context file mounts", () => {
  const { home, cleanup } = makeSkillsHome();
  writeAgentsMd(home);
  writeClaudeMd(home);
  try {
    const r = runCli(["--no-context-files", "-p", "noop"], {
      extraEnv: { HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.equal(
      a.some((arg) => arg.includes("/AGENTS.md")),
      false,
      `--no-context-files must not mount AGENTS.md: ${a.join(" ")}`,
    );
    assert.equal(
      a.some((arg) => arg.includes("/CLAUDE.md")),
      false,
      `--no-context-files must not mount CLAUDE.md: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
  }
});

test("-nc short flag suppresses all global context file mounts", () => {
  const { home, cleanup } = makeSkillsHome();
  writeAgentsMd(home);
  writeClaudeMd(home);
  try {
    const r = runCli(["-nc", "-p", "noop"], { extraEnv: { HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.equal(
      a.some((arg) => arg.includes("/AGENTS.md") || arg.includes("/CLAUDE.md")),
      false,
      `-nc must not mount context files: ${a.join(" ")}`,
    );
    // -nc must not leak as an unrecognized-flag warning.
    assert.equal(
      /unrecognized flag/.test(r.stderr),
      false,
      `-nc must be recognized: ${r.stderr}`,
    );
  } finally {
    cleanup();
  }
});

test("non-existent global context files are silently skipped", () => {
  // Empty temp HOME — no AGENTS.md/CLAUDE.md exist, so mounts are skipped.
  const { home, cleanup } = makeSkillsHome();
  try {
    const r = runCli(["-p", "noop"], { extraEnv: { HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.equal(
      a.some((arg) => arg.includes("/AGENTS.md") || arg.includes("/CLAUDE.md")),
      false,
      `non-existent context files must not be mounted: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
  }
});

test("global context file mount works with --file mode", () => {
  const { home, cleanup } = makeSkillsHome();
  writeAgentsMd(home);
  try {
    const r = runCli(["--file", SAMPLE_FILE, "-p", "noop"], {
      extraEnv: { HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.ok(
      a.some((arg) => arg.endsWith(":/workspace/script.py")),
      `expected file mount in: ${a.join(" ")}`,
    );
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.pi/agent/AGENTS.md")),
      `expected AGENTS.md mount in --file mode: ${a.join(" ")}`,
    );
  } finally {
    cleanup();
  }
});

test("--help documents --no-context-files and -nc", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--no-context-files/);
  assert.match(r.stdout, /-nc/);
});

// ---- project-level XDG config persistence (issue #92) ----------------------
//
// The container's ~/.config (/home/harness/.config) is persisted at the
// project (cwd) level — `$XDG_DATA_HOME/harness/<normalized-cwd>/xdg_config` —
// one level above the per-agent persist root, so config written by tools like
// jj survives across runs and is shared across agents. Like the other persist
// mounts, this only happens for interactive (non-ephemeral) sessions.

function hasScript() {
  return (
    spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" })
      .status === 0
  );
}

test("interactive (PTY) persists ~/.config at XDG_DATA_HOME/harness/<cwd>/xdg_config", () => {
  if (!hasScript()) return; // needs a PTY; ubuntu-latest has util-linux script
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-home-"));
  const xdgData = path.join(homeDir, ".local", "share");
  fs.mkdirSync(xdgData, { recursive: true });
  const r = spawnSync("script", ["-qfec", `node ${CLI}`, "/dev/null"], {
    cwd: localWork,
    env: {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH}`,
      HARNESS_IMAGE_TAG: "test-tag",
      HOME: homeDir,
      XDG_DATA_HOME: xdgData,
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const nCwd = normalizeCwd(localWork, homeDir);
  // Host dir is created one level above the per-agent (pi) root.
  assert.equal(
    fs.existsSync(path.join(xdgData, "harness", nCwd, "xdg_config")),
    true,
    `XDG_DATA_HOME/harness/${nCwd}/xdg_config should be created interactively`,
  );
  // And the docker args mount it to the container's XDG config home.
  const a = dockerArgs(r.stdout.replace(/\r/g, ""));
  assert.ok(a, "expected DOCKER_INVOKED line");
  assert.ok(
    a.some((arg) => arg.endsWith(":/home/harness/.config")),
    `expected -v mount ending in :/home/harness/.config in: ${a.join(" ")}`,
  );
});

test("one-shot (-p) is ephemeral: no xdg_config dir, no ~/.config mount", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-home-"));
  const xdgData = path.join(homeDir, ".local", "share");
  fs.mkdirSync(xdgData, { recursive: true });
  const r = runCli(["-p", "noop"], {
    extraEnv: { HOME: homeDir, XDG_DATA_HOME: xdgData },
  });
  assert.equal(r.status, 0, r.stderr);
  const nCwd = normalizeCwd(WORK_DIR, homeDir);
  assert.equal(
    fs.existsSync(path.join(xdgData, "harness", nCwd, "xdg_config")),
    false,
    "xdg_config must NOT be created for one-shot (ephemeral) runs",
  );
  const a = dockerArgs(r.stdout);
  assert.ok(a, "expected DOCKER_INVOKED line");
  assert.equal(
    a.some((arg) => arg.endsWith(":/home/harness/.config")),
    false,
    `ephemeral run must NOT mount /home/harness/.config: ${a.join(" ")}`,
  );
});

test("opencode interactive keeps both the cwd-level .config and per-agent .config/opencode mounts", () => {
  if (!hasScript()) return;
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-home-"));
  const xdgData = path.join(homeDir, ".local", "share");
  fs.mkdirSync(xdgData, { recursive: true });
  const r = spawnSync(
    "script",
    ["-qfec", `node ${CLI} -a opencode`, "/dev/null"],
    {
      cwd: localWork,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HOME: homeDir,
        XDG_DATA_HOME: xdgData,
      },
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout.replace(/\r/g, ""));
  assert.ok(a, "expected DOCKER_INVOKED line");
  // Cwd-level whole-.config mount (issue #92) ...
  assert.ok(
    a.some((arg) => arg.endsWith(":/home/harness/.config")),
    `expected cwd-level .config mount in: ${a.join(" ")}`,
  );
  // ... coexists with opencode's per-agent .config/opencode bucket.
  assert.ok(
    a.some((arg) => arg.endsWith(":/home/harness/.config/opencode")),
    `expected per-agent .config/opencode mount in: ${a.join(" ")}`,
  );
});

// ----------------------------------------------------------------------------
// Container runtime selection (HARNESS_CONTAINER_RUNTIME) — RFC 2026-06-20.
//
// harness can target either docker (default) or Apple's `container` CLI.
// Selection is driven by HARNESS_CONTAINER_RUNTIME (case-insensitive,
// named values). Both shims are installed in SHIM_DIR in before(), so a test
// opts into the apple path by setting HARNESS_CONTAINER_RUNTIME=apple.
// ----------------------------------------------------------------------------

test("--help documents HARNESS_CONTAINER_RUNTIME", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /HARNESS_CONTAINER_RUNTIME/);
  assert.match(
    r.stdout,
    /Environment variables:[\s\S]*HARNESS_CONTAINER_RUNTIME/,
  );
});

test("HARNESS_CONTAINER_RUNTIME unset defaults to docker", () => {
  const r = runCli(["-p", "noop"], {
    extraEnv: { HARNESS_CONTAINER_RUNTIME: undefined },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(dockerArgs(r.stdout), "expected DOCKER_INVOKED line");
  assert.equal(
    containerArgs(r.stdout),
    null,
    "container must NOT be invoked when runtime is unset",
  );
});

test("HARNESS_CONTAINER_RUNTIME=docker invokes docker", () => {
  const r = runCli(["-p", "noop"], {
    extraEnv: { HARNESS_CONTAINER_RUNTIME: "docker" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(dockerArgs(r.stdout), "expected DOCKER_INVOKED line");
  assert.equal(containerArgs(r.stdout), null);
});

test("HARNESS_CONTAINER_RUNTIME=apple invokes container", () => {
  const r = runCli(["-p", "noop"], {
    extraEnv: { HARNESS_CONTAINER_RUNTIME: "apple" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(containerArgs(r.stdout), "expected CONTAINER_INVOKED line");
  assert.equal(
    dockerArgs(r.stdout),
    null,
    "docker must NOT be invoked under the apple runtime",
  );
});

test("HARNESS_CONTAINER_RUNTIME is case-insensitive (APPLE, Docker)", () => {
  const rUpper = runCli(["-p", "noop"], {
    extraEnv: { HARNESS_CONTAINER_RUNTIME: "APPLE" },
  });
  assert.equal(rUpper.status, 0, rUpper.stderr);
  assert.ok(
    containerArgs(rUpper.stdout),
    "APPLE should select the container runtime",
  );

  const rMixed = runCli(["-p", "noop"], {
    extraEnv: { HARNESS_CONTAINER_RUNTIME: "Docker" },
  });
  assert.equal(rMixed.status, 0, rMixed.stderr);
  assert.ok(dockerArgs(rMixed.stdout), "Docker should select docker");
});

test("unknown HARNESS_CONTAINER_RUNTIME exits non-zero with a helpful message and does not spawn", () => {
  const r = runCli(["-p", "noop"], {
    extraEnv: { HARNESS_CONTAINER_RUNTIME: "podman" },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown HARNESS_CONTAINER_RUNTIME/);
  assert.match(r.stderr, /Valid values/);
  // No runtime should have been spawned.
  assert.equal(dockerArgs(r.stdout), null);
  assert.equal(containerArgs(r.stdout), null);
});

// ---- apple runtime argv shape ---------------------------------------------

test("apple runtime (non-interactive): -i without -t, no clustered -it", () => {
  // Piped stdin → !isTTY → the apple path emits a bare -i, never -t or -it.
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-rt-"));
  try {
    const r = spawnSync("node", [CLI, "-p", "noop"], {
      cwd: localWork,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HARNESS_CONTAINER_RUNTIME: "apple",
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const a = containerArgs(r.stdout);
    assert.ok(a, "expected CONTAINER_INVOKED line");
    assert.ok(a.includes("-i"), `expected -i in: ${a.join(" ")}`);
    assert.equal(
      a.includes("-t"),
      false,
      `non-interactive apple must not emit -t: ${a.join(" ")}`,
    );
    assert.equal(
      a.includes("-it"),
      false,
      `apple must never emit clustered -it: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(localWork, { recursive: true, force: true });
  }
});

test("apple runtime (interactive PTY): -i and -t emitted separately", () => {
  if (!hasScript()) return; // needs a PTY
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-rt-pty-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-rt-home-"));
  const xdgData = path.join(homeDir, ".local", "share");
  fs.mkdirSync(xdgData, { recursive: true });
  try {
    const r = spawnSync("script", ["-qfec", `node ${CLI}`, "/dev/null"], {
      cwd: localWork,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HARNESS_CONTAINER_RUNTIME: "apple",
        HOME: homeDir,
        XDG_DATA_HOME: xdgData,
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const a = containerArgs(r.stdout.replace(/\r/g, ""));
    assert.ok(a, "expected CONTAINER_INVOKED line");
    // -i and -t must be present as SEPARATE tokens (not clustered -it).
    assert.ok(a.includes("-i"), `expected -i: ${a.join(" ")}`);
    assert.ok(a.includes("-t"), `expected -t: ${a.join(" ")}`);
    assert.equal(
      a.includes("-it"),
      false,
      `apple must emit -i/-t separately, never -it: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(localWork, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("apple runtime: caps are space-separated and --security-opt is absent", () => {
  const r = runCli(["-p", "noop"], {
    extraEnv: { HARNESS_CONTAINER_RUNTIME: "apple" },
  });
  assert.equal(r.status, 0, r.stderr);
  const a = containerArgs(r.stdout);
  assert.ok(a, "expected CONTAINER_INVOKED line");
  // run --rm lead the argv
  assert.equal(a[0], "run");
  assert.equal(a[1], "--rm");
  // Capabilities: space-separated form (--cap-drop ALL --cap-add NET_RAW),
  // NOT the =-joined form docker uses.
  const dropIdx = a.indexOf("--cap-drop");
  assert.notEqual(dropIdx, -1, `expected --cap-drop: ${a.join(" ")}`);
  assert.equal(a[dropIdx + 1], "ALL");
  const addIdx = a.indexOf("--cap-add");
  assert.notEqual(addIdx, -1);
  assert.equal(a[addIdx + 1], "NET_RAW");
  assert.equal(
    a.includes("--cap-drop=ALL"),
    false,
    `apple must not use =-joined caps: ${a.join(" ")}`,
  );
  // No --security-opt token anywhere (microVM isolation subsumes seccomp /
  // no-new-privileges — see RFC Runtime Isolation).
  assert.equal(
    a.includes("--security-opt"),
    false,
    `apple must not emit --security-opt: ${a.join(" ")}`,
  );
});

test("apple runtime: no per-run seccomp/no-new-privileges warning on stderr", () => {
  // The omission of --security-opt is intentional and documented, not a
  // regression. Lock that harness does NOT nag the user about it on every
  // apple run.
  const r = runCli(["-p", "noop"], {
    extraEnv: { HARNESS_CONTAINER_RUNTIME: "apple" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(
    r.stderr,
    /seccomp|no-new-privileges|security-opt/i,
    `apple path must not warn about dropped security opts: ${r.stderr}`,
  );
});

test("apple runtime: env-file, -e, -v, -w, image, and container cmd match the docker path", () => {
  // Parity: everything EXCEPT tty/cap/security tokenization must be identical
  // between the two runtimes for the same inputs.
  const dockerR = runCli([
    "-e",
    ENV_FILE,
    "-p",
    "noop",
    "-v",
    `${SAMPLE_FILE}:/x`,
  ]);
  const appleR = runCli(
    ["-e", ENV_FILE, "-p", "noop", "-v", `${SAMPLE_FILE}:/x`],
    {
      extraEnv: { HARNESS_CONTAINER_RUNTIME: "apple" },
    },
  );
  assert.equal(dockerR.status, 0, dockerR.stderr);
  assert.equal(appleR.status, 0, appleR.stderr);
  const d = dockerArgs(dockerR.stdout);
  const c = containerArgs(appleR.stdout);
  assert.ok(d && c, "expected both runtimes to be invoked");

  // --env-file <abs>
  assert.deepEqual(
    d.slice(d.indexOf("--env-file"), d.indexOf("--env-file") + 2),
    c.slice(c.indexOf("--env-file"), c.indexOf("--env-file") + 2),
  );
  // -e HARNESS_CLOUD_MODE=1 present in both
  assert.ok(
    d.some((v, i) => v === "-e" && d[i + 1] === "HARNESS_CLOUD_MODE=1"),
  );
  assert.ok(
    c.some((v, i) => v === "-e" && c[i + 1] === "HARNESS_CLOUD_MODE=1"),
  );
  // user volume
  assert.ok(d.includes(`${SAMPLE_FILE}:/x`));
  assert.ok(c.includes(`${SAMPLE_FILE}:/x`));
  // -w /workspace
  assert.equal(d[d.indexOf("-w") + 1], "/workspace");
  assert.equal(c[c.indexOf("-w") + 1], "/workspace");
  // image and container command (tail after the image) identical
  const dImg = d.findIndex((x) => x.startsWith("ghcr.io/boldblackai/harness:"));
  const cImg = c.findIndex((x) => x.startsWith("ghcr.io/boldblackai/harness:"));
  assert.notEqual(dImg, -1);
  assert.notEqual(cImg, -1);
  assert.equal(d[dImg], c[cImg], "image must match across runtimes");
  assert.deepEqual(d.slice(dImg), c.slice(cImg), "container cmd must match");
});

// ---- missing runtime binary (apple) ---------------------------------------

test("apple runtime with `container` absent from PATH exits with the install hint", () => {
  // PATH has docker (so the harness process can run node) but NOT container.
  // The ensureReady() probe must fail fast before any spawn.
  const dockerOnlyDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "harness-nodocker-"),
  );
  makeDockerShim(dockerOnlyDir);
  try {
    const r = spawnSync("node", [CLI, "-p", "noop"], {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        PATH: `${dockerOnlyDir}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HARNESS_CONTAINER_RUNTIME: "apple",
      },
      encoding: "utf8",
    });
    assert.notEqual(
      r.status,
      0,
      "should exit non-zero when container is missing",
    );
    assert.match(r.stderr, /HARNESS_CONTAINER_RUNTIME=apple requires/);
    assert.match(r.stderr, /github.com\/apple\/container/);
    assert.match(r.stderr, /container system start/);
    // No runtime spawn attempted.
    assert.equal(dockerArgs(r.stdout), null);
    assert.equal(containerArgs(r.stdout), null);
  } finally {
    fs.rmSync(dockerOnlyDir, { recursive: true, force: true });
  }
});

// ---- cosign cache is runtime-agnostic -------------------------------------
//
// The cache is keyed by digest (repo@sha256:<d>), not by runtime. A digest
// verified under docker is a cache hit under apple/container. These tests use
// "smart" inspect shims that return a fixed descriptor digest, seed the cache
// with the matching repo@<digest> entry, and assert neither runtime re-pulls
// or re-verifies (no `pull` / `cosign` invocation) — the run proceeds.

const SHARED_DIGEST =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHARED_DIGEST_REF = `ghcr.io/boldblackai/harness@sha256:${SHARED_DIGEST}`;

function seededCacheDir(digestRef) {
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-cache-"));
  fs.mkdirSync(path.join(cacheHome, "harness"), { recursive: true });
  fs.writeFileSync(
    path.join(cacheHome, "harness", "cosign-verified.json"),
    JSON.stringify({
      version: 1,
      verified: {
        [digestRef]: { tag: "seeded", verifiedAt: "2026-01-01T00:00:00.000Z" },
      },
    }),
  );
  return cacheHome;
}

function makeAppleInspectShim(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, "container");
  fs.writeFileSync(
    shim,
    `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  printf '%s' '[{"configuration":{"descriptor":{"digest":"sha256:${SHARED_DIGEST}"}}}]'
  exit 0
fi
echo "CONTAINER_INVOKED $*"
exit 0
`,
    { mode: 0o755 },
  );
  return shim;
}

function makeDockerInspectShim(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, "docker");
  fs.writeFileSync(
    shim,
    `#!/usr/bin/env bash
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  printf '%s' '${SHARED_DIGEST_REF}'
  exit 0
fi
echo "DOCKER_INVOKED $*"
exit 0
`,
    { mode: 0o755 },
  );
  return shim;
}

test("apple runtime: seeded cosign cache short-circuits verification (no pull, no cosign)", () => {
  const VERSION = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  ).version;
  const image = `ghcr.io/boldblackai/harness:${VERSION}`;
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-rt-cache-"));
  const cacheHome = seededCacheDir(SHARED_DIGEST_REF);
  makeAppleInspectShim(shimDir);
  try {
    const r = spawnSync("node", [CLI, "-p", "noop"], {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH}`,
        // Intentionally NO HARNESS_IMAGE_TAG and NO --no-verify: we want the
        // real verify path, which must hit the seeded cache.
        HARNESS_CONTAINER_RUNTIME: "apple",
        XDG_CACHE_HOME: cacheHome,
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    // No pull attempt (cache hit returns before the pull fallback).
    assert.equal(
      /pulling/.test(r.stderr),
      false,
      `apple must not pull on a cache hit: ${r.stderr}`,
    );
    // No cosign invocation evidence.
    assert.equal(
      /cosign/.test(r.stderr),
      false,
      `apple must not call cosign on a cache hit: ${r.stderr}`,
    );
    // The container run still happened, and no `image pull` was issued.
    const a = containerArgs(r.stdout);
    assert.ok(a, "expected CONTAINER_INVOKED run line");
    assert.equal(a[0], "run");
    assert.ok(
      !r.stdout.includes("CONTAINER_INVOKED image pull"),
      `apple must not issue 'image pull' on a cache hit: ${r.stdout}`,
    );
    assert.ok(
      a.includes(image),
      `expected image ${image} in run argv: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(cacheHome, { recursive: true, force: true });
  }
});

test("cosign cache is runtime-agnostic: same digest entry is a hit under docker too", () => {
  // The complement of the apple cache test: the identical seeded cache entry
  // (same repo@sha256:<d> key) must also short-circuit verification under the
  // docker runtime, proving the cache is keyed by digest, not by runtime.
  const VERSION = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  ).version;
  const image = `ghcr.io/boldblackai/harness:${VERSION}`;
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-rt-dcache-"));
  const cacheHome = seededCacheDir(SHARED_DIGEST_REF);
  makeDockerInspectShim(shimDir);
  try {
    const r = spawnSync("node", [CLI, "-p", "noop"], {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH}`,
        HARNESS_CONTAINER_RUNTIME: "docker",
        XDG_CACHE_HOME: cacheHome,
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      /pulling/.test(r.stderr),
      false,
      `docker must not pull on a cache hit: ${r.stderr}`,
    );
    assert.equal(
      /cosign/.test(r.stderr),
      false,
      `docker must not call cosign on a cache hit: ${r.stderr}`,
    );
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED run line");
    assert.equal(a[0], "run");
    assert.ok(
      !r.stdout.includes("DOCKER_INVOKED pull"),
      `docker must not issue 'pull' on a cache hit: ${r.stdout}`,
    );
    assert.ok(a.includes(image), `expected image ${image}: ${a.join(" ")}`);
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(cacheHome, { recursive: true, force: true });
  }
});
