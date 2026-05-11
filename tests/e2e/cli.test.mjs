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
import { execFileSync, spawnSync } from "node:child_process";
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

function makeDockerShim(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, "docker");
  // Echo invocation prefix so the CLI's own stderr is distinguishable.
  fs.writeFileSync(
    shim,
    `#!/usr/bin/env bash
echo "DOCKER_INVOKED $*"
exit 0
`,
    { mode: 0o755 },
  );
  return shim;
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

function dockerArgs(stdout) {
  const line = stdout.split("\n").find((l) => l.startsWith("DOCKER_INVOKED "));
  if (!line) return null;
  // Split safely: docker shim joined with spaces, but our test fixtures
  // never contain literal spaces inside individual args.
  return line.replace("DOCKER_INVOKED ", "").split(" ").filter(Boolean);
}

function xdgStateDir(env) {
  return env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
}

function persistDir(workspacePath, agent, env = {}) {
  const home = os.homedir();
  let stripped = workspacePath;
  if (stripped.startsWith(home + "/")) {
    stripped = stripped.slice(home.length + 1);
  } else {
    stripped = stripped.replace(/^\/+/, "");
  }
  const normalized = stripped.replace(/\/+$/, "").replace(/\//g, "-");
  return path.join(xdgStateDir(env), "harness", normalized, agent);
}

before(() => {
  ensureBuilt();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-"));
  SHIM_DIR = path.join(tmp, "shim");
  WORK_DIR = path.join(tmp, "work");
  fs.mkdirSync(WORK_DIR, { recursive: true });
  makeDockerShim(SHIM_DIR);

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
    args.some((a) => a === "ghcr.io/capotej/harness:test-tag"),
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
    a.some((s) => s === "ghcr.io/capotej/harness:opencode-test-tag"),
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
    a.indexOf("ghcr.io/capotej/harness:opencode-test-tag"),
  );
  assert.deepEqual(a.slice(cmdIdx, cmdIdx + 3), ["opencode", "run", "noop"]);
});

// ---- hermes adapter --------------------------------------------------------

test("hermes: no -m, no -p emits exactly ['hermes','chat'] (no stray flags)", () => {
  // Covers the no-model + interactive branch of HermesAdapter.buildCommand:
  //   args = ["hermes","chat"]; no -m pushed (model falsy); no -q pushed
  //   (prompt === null when no -p and no piped stdin).
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
  // -w /workspace is set
  const wIdx = a.indexOf("-w");
  assert.notEqual(wIdx, -1);
  assert.equal(a[wIdx + 1], "/workspace");
});

// ---- persistence behaviour --------------------------------------------------

test("one-shot run (-p) is implicitly ephemeral: no XDG state dir created", () => {
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-xdg-"));
  const env = {
    ...process.env,
    PATH: `${SHIM_DIR}:${process.env.PATH}`,
    HARNESS_IMAGE_TAG: "test-tag",
    XDG_STATE_HOME: xdgDir,
  };
  const r = spawnSync("node", [CLI, "-p", "noop"], {
    cwd: localWork,
    env,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    fs.existsSync(persistDir(localWork, "pi", env)),
    false,
    "XDG state dir should NOT be created for one-shot runs",
  );
});

test("piped stdin is implicitly ephemeral and forwards prompt", () => {
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-xdg-"));
  const env = {
    ...process.env,
    PATH: `${SHIM_DIR}:${process.env.PATH}`,
    HARNESS_IMAGE_TAG: "test-tag",
    XDG_STATE_HOME: xdgDir,
  };
  const r = spawnSync("node", [CLI], {
    cwd: localWork,
    env,
    input: "piped prompt\n",
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(persistDir(localWork, "pi", env)), false);
  const a = dockerArgs(r.stdout);
  // pi adapter receives the piped prompt via -p
  const idx = a.indexOf("pi");
  assert.notEqual(idx, -1);
  assert.equal(a[idx + 1], "-p");
  assert.match(a[idx + 2], /piped/);
});

test("interactive (PTY, no -p, no --ephemeral) creates XDG state persistence dir for agent", () => {
  // Inverse of the two implicit-ephemeral cases above: when the user is
  // truly interactive (TTY, no -p, no piped stdin) and does NOT pass
  // --ephemeral, the run() path must materialize the persistence dirs the
  // adapter advertises via persistMounts(). For the pi adapter that is
  // the agent subdirectory under $XDG_STATE_HOME/harness/<normalized-cwd>/.
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
  const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-xdg-"));
  const env = {
    ...process.env,
    PATH: `${SHIM_DIR}:${process.env.PATH}`,
    HARNESS_IMAGE_TAG: "test-tag",
    XDG_STATE_HOME: xdgDir,
  };
  const r = spawnSync("script", ["-qfec", `node ${CLI}`, "/dev/null"], {
    cwd: localWork,
    env,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    fs.existsSync(persistDir(localWork, "pi", env)),
    true,
    "XDG state dir for pi should be created in interactive mode without --ephemeral",
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

test("--ephemeral overrides interactive PTY: no XDG state dir, no persist mount", () => {
  // Inverse of the interactive-PTY persistence test: when the user is in a
  // real PTY (TTY, no -p, no piped stdin) but EXPLICITLY passes --ephemeral,
  // the run() path must NOT create the XDG state dir and must NOT include
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
  const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-xdg-"));
  const env = {
    ...process.env,
    PATH: `${SHIM_DIR}:${process.env.PATH}`,
    HARNESS_IMAGE_TAG: "test-tag",
    XDG_STATE_HOME: xdgDir,
  };
  const r = spawnSync(
    "script",
    ["-qfec", `node ${CLI} --ephemeral`, "/dev/null"],
    {
      cwd: localWork,
      env,
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    fs.existsSync(persistDir(localWork, "pi", env)),
    false,
    "XDG state dir must NOT be created when --ephemeral is passed in interactive mode",
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
  //   - implicitly ephemeral (piped, !isTTY) so NO XDG state dir
  //   - pi adapter's docker cmd has NO `-p` arg (interactive pi, just `pi`)
  //
  // This guards against a regression where `input` (raw, untrimmed) gets
  // passed through and the adapter receives `-p "   \n"` instead.
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-xdg-"));
  const env = {
    ...process.env,
    PATH: `${SHIM_DIR}:${process.env.PATH}`,
    HARNESS_IMAGE_TAG: "test-tag",
    XDG_STATE_HOME: xdgDir,
  };
  const r = spawnSync("node", [CLI], {
    cwd: localWork,
    env,
    input: "   \n\t  \n",
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    fs.existsSync(persistDir(localWork, "pi", env)),
    false,
    "piped stdin is implicitly ephemeral; XDG state dir must NOT be created",
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
  const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-xdg-"));
  const env = {
    ...process.env,
    PATH: `${SHIM_DIR}:${process.env.PATH}`,
    HARNESS_IMAGE_TAG: "test-tag",
    XDG_STATE_HOME: xdgDir,
  };
  const r = spawnSync(
    "script",
    ["-qfec", `node ${CLI} -a opencode`, "/dev/null"],
    {
      cwd: localWork,
      env,
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);

  // All three host-side persistence buckets must be created.
  for (const sub of ["config", "share", "state"]) {
    assert.equal(
      fs.existsSync(path.join(persistDir(localWork, "opencode", env), sub)),
      true,
      `XDG state dir opencode/${sub}/ should be created in interactive mode`,
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
  // XDG state dir for the agent and adds its mount(s) to docker
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
  const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-xdg-"));
  const extraDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "harness-vol-persist-"),
  );
  const env = {
    ...process.env,
    PATH: `${SHIM_DIR}:${process.env.PATH}`,
    HARNESS_IMAGE_TAG: "test-tag",
    XDG_STATE_HOME: xdgDir,
  };
  try {
    const r = spawnSync(
      "script",
      ["-qfec", `node ${CLI} --volumes ${extraDir}:/mnt/data`, "/dev/null"],
      {
        cwd: localWork,
        env,
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 0, r.stderr);

    // interactive non-ephemeral path created the persist dir
    assert.equal(
      fs.existsSync(persistDir(localWork, "pi", env)),
      true,
      "XDG state dir for pi should be created in interactive mode",
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

test("hermes interactive (no --ephemeral) creates both persistence dirs and mounts", () => {
  // HermesAdapter.persistMounts() returns two distinct mounts:
  //   - local      -> /home/harness/.hermes-local
  //   - openrouter -> /home/harness/.hermes-openrouter
  //
  // The pi adapter test only locks a single empty-hostSubpath mount and
  // PR #30 (mine, merged) locks the opencode 3-mount shape. This is the
  // analog test for hermes's 2-mount shape so a future refactor cannot
  // silently drop one of the two hermes persistence buckets.
  const which = spawnSync("sh", ["-c", "command -v script"], {
    encoding: "utf8",
  });
  if (which.status !== 0) {
    return; // skip on platforms without `script`.
  }
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-xdg-"));
  const env = {
    ...process.env,
    PATH: `${SHIM_DIR}:${process.env.PATH}`,
    HARNESS_IMAGE_TAG: "test-tag",
    XDG_STATE_HOME: xdgDir,
  };
  const r = spawnSync(
    "script",
    ["-qfec", `node ${CLI} -a hermes`, "/dev/null"],
    {
      cwd: localWork,
      env,
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);

  // Both host-side persistence buckets must be created.
  for (const sub of ["local", "openrouter"]) {
    assert.equal(
      fs.existsSync(path.join(persistDir(localWork, "hermes", env), sub)),
      true,
      `XDG state dir hermes/${sub}/ should be created in interactive mode`,
    );
  }

  // Both docker -v mounts must target the documented container paths.
  const cleaned = r.stdout.replace(/\r/g, "");
  const a = dockerArgs(cleaned);
  assert.ok(a, `expected DOCKER_INVOKED line in: ${cleaned}`);
  const targets = [
    "/home/harness/.hermes-local",
    "/home/harness/.hermes-openrouter",
  ];
  for (const t of targets) {
    assert.ok(
      a.some((arg) => arg.endsWith(`:${t}`)),
      `expected -v mount ending in :${t} in: ${a.join(" ")}`,
    );
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
  //   pi       -> ghcr.io/capotej/harness:<TAG>
  //   opencode -> ghcr.io/capotej/harness:opencode-<TAG>
  //   hermes   -> ghcr.io/capotej/harness:hermes-<TAG>
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
    const expectedImage = `ghcr.io/capotej/harness:${expectedTag}`;
    assert.ok(
      a.includes(expectedImage),
      `expected image '${expectedImage}' for agent '${agent}' in: ${a.join(" ")}`,
    );
    // Negative: the pi-prefixed form must NEVER appear.
    assert.equal(
      a.some((arg) => arg.startsWith("ghcr.io/capotej/harness:pi-")),
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
  const image = a.find((x) => x.startsWith("ghcr.io/capotej/harness:"));
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
  const imgShort = aShort.find((x) => x.startsWith("ghcr.io/capotej/harness:"));
  const imgLong = aLong.find((x) => x.startsWith("ghcr.io/capotej/harness:"));
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
  assert.deepEqual(a.slice(idx, idx + 2), ["hermes", "chat"]);
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
  const imgIdx = a.findIndex((x) => x.startsWith("ghcr.io/capotej/harness:"));
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
