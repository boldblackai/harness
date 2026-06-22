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
  setupIfNecessary,
} from "./helpers.mjs";

setupIfNecessary();

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
