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

test("one-shot run (-p) is implicitly ephemeral: no .harness/ dir created", () => {
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
  const r = spawnSync("node", [CLI, "-p", "noop"], {
    cwd: localWork,
    env: {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH}`,
      HARNESS_IMAGE_TAG: "test-tag",
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    fs.existsSync(path.join(localWork, ".harness")),
    false,
    ".harness/ should NOT be created for one-shot runs",
  );
});

test("piped stdin is implicitly ephemeral and forwards prompt", () => {
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-cwd-"));
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
  assert.equal(fs.existsSync(path.join(localWork, ".harness")), false);
  const a = dockerArgs(r.stdout);
  // pi adapter receives the piped prompt via -p
  const idx = a.indexOf("pi");
  assert.notEqual(idx, -1);
  assert.equal(a[idx + 1], "-p");
  assert.match(a[idx + 2], /piped/);
});

test("interactive (PTY, no -p, no --ephemeral) creates .harness/<agent>/ persistence dir", () => {
  // Inverse of the two implicit-ephemeral cases above: when the user is
  // truly interactive (TTY, no -p, no piped stdin) and does NOT pass
  // --ephemeral, the run() path must materialize the persistence dirs the
  // adapter advertises via persistMounts(). For the pi adapter that is
  // `<cwd>/.harness/pi/` (empty hostSubpath -> persistRoot itself).
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
  const r = spawnSync("script", ["-qfec", `node ${CLI}`, "/dev/null"], {
    cwd: localWork,
    env: {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH}`,
      HARNESS_IMAGE_TAG: "test-tag",
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    fs.existsSync(path.join(localWork, ".harness", "pi")),
    true,
    ".harness/pi/ should be created in interactive mode without --ephemeral",
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
  // the run() path must NOT create .harness/<agent>/ and must NOT include
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
  const r = spawnSync(
    "script",
    ["-qfec", `node ${CLI} --ephemeral`, "/dev/null"],
    {
      cwd: localWork,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
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
  const r = spawnSync("node", [CLI], {
    cwd: localWork,
    env: {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH}`,
      HARNESS_IMAGE_TAG: "test-tag",
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
  const r = spawnSync(
    "script",
    ["-qfec", `node ${CLI} -a opencode`, "/dev/null"],
    {
      cwd: localWork,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
      },
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);

  // All three host-side persistence buckets must be created.
  for (const sub of ["config", "share", "state"]) {
    assert.equal(
      fs.existsSync(path.join(localWork, ".harness", "opencode", sub)),
      true,
      `.harness/opencode/${sub}/ should be created in interactive mode`,
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
