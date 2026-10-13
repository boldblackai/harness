// Tier 1 egress-control tests: --network passthrough
// (rfcs/2026-10-08_egress_allowlist.md). Tier 2 (--egress) has its own file.
//
// Also locks the RFC's hard compatibility requirement: with no egress flags,
// harness emits the identical argv it emitted before the feature — no
// --network token anywhere in the default path.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  containerArgs,
  dockerArgs,
  runCli,
  setupIfNecessary,
} from "./helpers.mjs";

setupIfNecessary();

// ---- default argv unchanged (RFC "Backward compatibility") ------------------

test("no egress flags: argv contains no --network token (docker)", () => {
  const r = runCli(["-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  assert.ok(a, "expected DOCKER_INVOKED line");
  assert.equal(
    a.includes("--network"),
    false,
    `default path must not emit --network: ${a.join(" ")}`,
  );
});

test("no egress flags: argv contains no --network token (apple)", () => {
  const r = runCli(["-p", "noop"], {
    extraEnv: { HARNESS_CONTAINER_RUNTIME: "apple" },
  });
  assert.equal(r.status, 0, r.stderr);
  const a = containerArgs(r.stdout);
  assert.ok(a, "expected CONTAINER_INVOKED line");
  assert.equal(
    a.includes("--network"),
    false,
    `default path must not emit --network: ${a.join(" ")}`,
  );
});

// ---- flag forwarding --------------------------------------------------------

test("--network forwards verbatim under docker", () => {
  const r = runCli(["-p", "noop", "--network", "corp-proxy-net"]);
  assert.equal(r.status, 0, r.stderr);
  const a = dockerArgs(r.stdout);
  assert.ok(a, "expected DOCKER_INVOKED line");
  const idx = a.indexOf("--network");
  assert.notEqual(idx, -1, `expected --network: ${a.join(" ")}`);
  assert.equal(a[idx + 1], "corp-proxy-net");
});

test("--network forwards verbatim under the apple runtime", () => {
  const r = runCli(["-p", "noop", "--network", "corp-proxy-net"], {
    extraEnv: { HARNESS_CONTAINER_RUNTIME: "apple" },
  });
  assert.equal(r.status, 0, r.stderr);
  const a = containerArgs(r.stdout);
  assert.ok(a, "expected CONTAINER_INVOKED line");
  const idx = a.indexOf("--network");
  assert.notEqual(idx, -1, `expected --network: ${a.join(" ")}`);
  assert.equal(a[idx + 1], "corp-proxy-net");
});

test("--network host warns on stderr but proceeds", () => {
  const r = runCli(["-p", "noop", "--network", "host"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /--network host/);
  assert.match(r.stderr, /network isolation/i);
  const a = dockerArgs(r.stdout);
  assert.equal(a[a.indexOf("--network") + 1], "host");
});

test("empty --network value is rejected", () => {
  const r = runCli(["-p", "noop", "--network", ""]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--network/);
  assert.match(r.stderr, /non-empty/);
  assert.equal(dockerArgs(r.stdout), null, "must not spawn");
});
