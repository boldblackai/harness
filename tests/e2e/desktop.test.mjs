import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  WORK_DIR,
  normalizeCwd,
  runCli,
  runtimeArgsAny,
  setupIfNecessary,
} from "./helpers.mjs";

setupIfNecessary();

// ---- `harness desktop`: command contract ------------------------------------

test("desktop with an explicit non-hermes agent errors out", () => {
  for (const agent of ["pi", "opencode"]) {
    const r = runCli(["desktop", "-a", agent]);
    assert.equal(r.status, 1, `expected exit 1 for -a ${agent}: ${r.stderr}`);
    assert.match(r.stderr, /desktop works only with -a hermes/);
  }
});

test("desktop with explicit -a hermes is accepted", () => {
  const r = runCli(["desktop", "-a", "hermes"]);
  assert.equal(r.status, 0, r.stderr);
});

test("desktop takes no prompt (hard error)", () => {
  const r = runCli(["desktop", "-p", "noop"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /desktop does not take a prompt/);
});

test("desktop rejects an empty --prompt too (no coercion gap)", () => {
  const r = runCli(["desktop", "--prompt", ""]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /desktop does not take a prompt/);
});

test("desktop takes no positional prompt (hard error)", () => {
  const r = runCli(["desktop", "extra-words"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /desktop does not take a prompt/);
});

// ---- `harness desktop`: serve-only + publish/env plumbing -------------------

test("desktop runs no agent command (serve-only) and sets the desktop env", () => {
  const r = runCli(["desktop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = runtimeArgsAny(r.stdout);
  assert.ok(a, "expected runtime invocation");
  assert.ok(
    !a.includes("chat"),
    `no agent command must run in desktop mode: ${a.join(" ")}`,
  );
  assert.ok(
    a.includes("HARNESS_DESKTOP=1"),
    `expected HARNESS_DESKTOP=1 env in: ${a.join(" ")}`,
  );
  assert.ok(
    a.includes("HARNESS_DESKTOP_SERVE_ONLY=1"),
    `expected HARNESS_DESKTOP_SERVE_ONLY=1 in: ${a.join(" ")}`,
  );
  assert.ok(
    a.includes("HARNESS_DESKTOP_HOST_PORT=3000"),
    `expected HARNESS_DESKTOP_HOST_PORT=3000 in: ${a.join(" ")}`,
  );
  assert.ok(
    a.includes("3000:3000"),
    `expected 3000:3000 publish in: ${a.join(" ")}`,
  );
});

test("desktop reuses a user tcp publish of container port 3000 (URL follows it)", () => {
  const r = runCli(["desktop", "--port", "8080:3000"]);
  assert.equal(r.status, 0, r.stderr);
  const a = runtimeArgsAny(r.stdout);
  assert.ok(
    a.includes("8080:3000"),
    `expected 8080:3000 publish in: ${a.join(" ")}`,
  );
  assert.ok(
    !a.includes("3000:3000"),
    `3000:3000 must NOT be added when the user publishes container 3000: ${a.join(" ")}`,
  );
  assert.ok(
    a.includes("HARNESS_DESKTOP_HOST_PORT=8080"),
    `expected HARNESS_DESKTOP_HOST_PORT=8080 in: ${a.join(" ")}`,
  );
});

test("desktop adds 3000:3000 alongside a publish of an unrelated port", () => {
  const r = runCli(["desktop", "--port", "9999:8080"]);
  assert.equal(r.status, 0, r.stderr);
  const a = runtimeArgsAny(r.stdout);
  assert.ok(a.includes("9999:8080"));
  assert.ok(a.includes("3000:3000"));
  assert.ok(a.includes("HARNESS_DESKTOP_HOST_PORT=3000"));
});

test("desktop: a udp container-3000 publish does NOT suppress the implied TCP publish", () => {
  const r = runCli(["desktop", "--port", "8080:3000/udp"]);
  assert.equal(r.status, 0, r.stderr);
  const a = runtimeArgsAny(r.stdout);
  assert.ok(
    a.includes("8080:3000/udp"),
    `expected the udp publish kept in: ${a.join(" ")}`,
  );
  assert.ok(
    a.includes("3000:3000"),
    `udp must NOT suppress the implied TCP publish: ${a.join(" ")}`,
  );
  assert.ok(
    a.includes("HARNESS_DESKTOP_HOST_PORT=3000"),
    `expected HARNESS_DESKTOP_HOST_PORT=3000 in: ${a.join(" ")}`,
  );
});

test("desktop: an explicit tcp container-3000 publish still suppresses (URL follows it)", () => {
  const r = runCli(["desktop", "--port", "8080:3000/tcp"]);
  assert.equal(r.status, 0, r.stderr);
  const a = runtimeArgsAny(r.stdout);
  assert.ok(
    a.includes("8080:3000/tcp"),
    `expected the tcp publish in: ${a.join(" ")}`,
  );
  assert.ok(
    !a.includes("3000:3000"),
    `3000:3000 must NOT be added when a tcp publish covers container 3000: ${a.join(" ")}`,
  );
  assert.ok(
    a.includes("HARNESS_DESKTOP_HOST_PORT=8080"),
    `expected HARNESS_DESKTOP_HOST_PORT=8080 in: ${a.join(" ")}`,
  );
});

test("HARNESS_DESKTOP_PASSWORD is forwarded only when set", () => {
  const without = runCli(["desktop"]);
  assert.equal(without.status, 0, without.stderr);
  const a1 = runtimeArgsAny(without.stdout);
  assert.ok(
    !a1.some((arg) => arg.startsWith("HARNESS_DESKTOP_PASSWORD=")),
    "no password env expected when HARNESS_DESKTOP_PASSWORD is unset",
  );

  const withPw = runCli(["desktop"], {
    extraEnv: { HARNESS_DESKTOP_PASSWORD: "s3cret-from-env" },
  });
  assert.equal(withPw.status, 0, withPw.stderr);
  const a2 = runtimeArgsAny(withPw.stdout);
  assert.ok(
    a2.includes("HARNESS_DESKTOP_PASSWORD=s3cret-from-env"),
    `expected password env in: ${a2.join(" ")}`,
  );
});

test("desktop carries --model to the gateway env as HERMES_MODEL", () => {
  const r = runCli(["desktop", "-m", "some/model"]);
  assert.equal(r.status, 0, r.stderr);
  const a = runtimeArgsAny(r.stdout);
  assert.ok(
    a.includes("HERMES_MODEL=some/model"),
    `expected HERMES_MODEL=some/model in: ${a.join(" ")}`,
  );
});

test("without desktop no desktop env or publish leaks into the run", () => {
  const r = runCli(["-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = runtimeArgsAny(r.stdout);
  assert.ok(!a.includes("HARNESS_DESKTOP=1"));
  assert.ok(!a.includes("3000:3000"));
});

// ---- `harness desktop`: persistence semantics -------------------------------

function persistHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-home-"));
  const xdgData = path.join(homeDir, ".local", "share");
  fs.mkdirSync(xdgData, { recursive: true });
  return { homeDir, xdgData };
}

test("desktop keeps persistence (interactive-style sessions survive)", () => {
  const { homeDir, xdgData } = persistHome();
  const r = runCli(["desktop"], {
    extraEnv: { HOME: homeDir, XDG_DATA_HOME: xdgData },
  });
  assert.equal(r.status, 0, r.stderr);
  const nCwd = normalizeCwd(WORK_DIR, homeDir);
  assert.equal(
    fs.existsSync(path.join(xdgData, "harness", nCwd, "hermes")),
    true,
    `XDG_DATA_HOME/harness/${nCwd}/hermes/ should be created for desktop runs`,
  );
});

test("desktop keeps persistence with piped stdin", () => {
  const { homeDir, xdgData } = persistHome();
  const r = runCli(["desktop"], {
    extraEnv: { HOME: homeDir, XDG_DATA_HOME: xdgData },
    input: "piped text",
  });
  assert.equal(r.status, 0, r.stderr);
  const nCwd = normalizeCwd(WORK_DIR, homeDir);
  assert.equal(
    fs.existsSync(path.join(xdgData, "harness", nCwd, "hermes")),
    true,
    "piped stdin must not demote a desktop run to ephemeral",
  );
});

test("desktop --ephemeral is still ephemeral (explicit wins)", () => {
  const { homeDir, xdgData } = persistHome();
  const r = runCli(["desktop", "--ephemeral"], {
    extraEnv: { HOME: homeDir, XDG_DATA_HOME: xdgData },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    fs.existsSync(path.join(xdgData, "harness")),
    false,
    "explicit --ephemeral must win over desktop persistence",
  );
});
