// Behavior-matrix tests for scripts/fetch-retry.sh — the bounded-retry fetch
// wrapper the Dockerfile.hermes verify chain routes every network fetch
// through. Each test names the grammar property it locks; the matrix is the
// helper's contract: transient classes retry until success within the bound,
// Retry-After governs sleeps, non-transient failures fail fast, and
// persistent failure fails closed at the attempt cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const HELPER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "fetch-retry.sh",
);

// Starts a mock server whose i-th request gets PLAN[min(i, len-1)].
// Returns { url, requests, close }.
function mockServer(plan) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const [status, retryAfter] = plan[Math.min(requests.length - 1, plan.length - 1)];
    if (retryAfter !== null) res.setHeader("Retry-After", String(retryAfter));
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(status === 200 ? '{"ok":true}' : '{"message":"transient"}');
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/x`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function runHelper(url) {
  const dir = mkdtempSync(path.join(tmpdir(), "fetch-retry-"));
  const out = path.join(dir, "out.bin");
  const t0 = Date.now();
  let rc = 0;
  try {
    await execFileP("bash", [HELPER, out, url], { timeout: 120_000 });
  } catch (err) {
    rc = err.code ?? 1;
  }
  const elapsed = (Date.now() - t0) / 1000;
  const ok = rc === 0 && existsSync(out);
  rmSync(dir, { recursive: true, force: true });
  return { rc, ok, elapsed };
}

test("success on the first attempt issues exactly one request", async () => {
  const srv = await mockServer([[200, null]]);
  try {
    const r = await runHelper(srv.url);
    assert.equal(r.ok, true);
    assert.equal(srv.requests.length, 1);
    assert.ok(r.elapsed < 2, `expected no backoff sleep, took ${r.elapsed}s`);
  } finally {
    await srv.close();
  }
});

test("403 is transient: retries until success and honors Retry-After", async () => {
  const srv = await mockServer([[403, 1], [403, 1], [200, null]]);
  try {
    const r = await runHelper(srv.url);
    assert.equal(r.ok, true);
    assert.equal(srv.requests.length, 3);
    assert.ok(r.elapsed >= 2, `Retry-After 1+1 not honored, took ${r.elapsed}s`);
  } finally {
    await srv.close();
  }
});

test("429 honors Retry-After delta-seconds", async () => {
  const srv = await mockServer([[429, 2], [200, null]]);
  try {
    const r = await runHelper(srv.url);
    assert.equal(r.ok, true);
    assert.equal(srv.requests.length, 2);
    assert.ok(r.elapsed >= 2, `Retry-After 2 not honored, took ${r.elapsed}s`);
  } finally {
    await srv.close();
  }
});

test("5xx is transient: retries until success", async () => {
  const srv = await mockServer([[500, null], [502, null], [200, null]]);
  try {
    const r = await runHelper(srv.url);
    assert.equal(r.ok, true);
    assert.equal(srv.requests.length, 3);
  } finally {
    await srv.close();
  }
});

test("persistent transient failure fails closed at the attempt cap", async () => {
  const srv = await mockServer([[403, 1]]);
  try {
    const r = await runHelper(srv.url);
    assert.equal(r.ok, false);
    assert.notEqual(r.rc, 0);
    assert.equal(srv.requests.length, 5, "the attempt cap must bound persistent failure");
    assert.ok(r.elapsed < 60, `bounded backoff exceeded a minute: ${r.elapsed}s`);
  } finally {
    await srv.close();
  }
});

test("non-transient 4xx fails immediately without retries", async () => {
  const srv = await mockServer([[404, null]]);
  try {
    const r = await runHelper(srv.url);
    assert.equal(r.ok, false);
    assert.notEqual(r.rc, 0);
    assert.equal(srv.requests.length, 1, "a non-transient status must not retry");
    assert.ok(r.elapsed < 5, `fail-fast took ${r.elapsed}s`);
  } finally {
    await srv.close();
  }
});
