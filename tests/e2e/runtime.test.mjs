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
  const pathWithoutContainer = process.env.PATH.split(path.delimiter)
    .filter((dir) => {
      try {
        return !fs.existsSync(path.join(dir, "container"));
      } catch {
        return true;
      }
    })
    .join(path.delimiter);
  try {
    const r = spawnSync("node", [CLI, "-p", "noop"], {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        PATH: `${dockerOnlyDir}:${pathWithoutContainer}`,
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

test("HARNESS_CONTAINER_RUNTIME=apple warns when host.docker.internal DNS is missing", () => {
  const which = spawnSync("sh", ["-c", "command -v container"], {
    encoding: "utf8",
  });
  if (which.status !== 0) return;
  const list = spawnSync("container", ["system", "dns", "list"], {
    encoding: "utf8",
  });
  if (list.status !== 0 || list.stdout.includes("host.docker.internal")) return;

  const r = runCli(["-p", "noop"], {
    extraEnv: { HARNESS_CONTAINER_RUNTIME: "apple" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /host\.docker\.internal/);
  assert.match(r.stderr, /container system dns create/);
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
