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
  hasScript,
  makeContainerShim,
  makeDockerShim,
  normalizeCwd,
  runCli,
  runtimeArgsAny,
  setupIfNecessary,
} from "./helpers.mjs";

setupIfNecessary();

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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
  const a = runtimeArgsAny(r.stdout);
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
  const a = runtimeArgsAny(r.stdout);
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
  const a = runtimeArgsAny(r.stdout);
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
  const a = runtimeArgsAny(r.stdout);
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
  const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(cleaned);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
  const a = runtimeArgsAny(cleaned);
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
    const a = runtimeArgsAny(r.stdout);
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
  const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
    const a = runtimeArgsAny(r.stdout);
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
  const a = runtimeArgsAny(r.stdout.replace(/\r/g, ""));
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
  const a = runtimeArgsAny(r.stdout);
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
  const a = runtimeArgsAny(r.stdout.replace(/\r/g, ""));
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
