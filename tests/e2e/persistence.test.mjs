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
