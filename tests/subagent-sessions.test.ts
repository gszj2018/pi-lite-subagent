/** All filesystem operations use self-cleaning temporary trees, never user session directories. */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { isPathSafeSessionId, subagentSessionDir } from "../extension/session-paths.ts";
import { MAX_SESSION_METADATA_BYTES, readSessionIdentity, scanSubagentSessions,
  SESSION_METADATA_CONCURRENCY } from "../extension/subagent-sessions.ts";
import { sessionText, SESSION_TIME, withTempSessions } from "./helpers/sessions-fixture.ts";

test("shared session paths preserve the runner layout and reject unsafe ids without creating directories", () => {
  assert.equal(subagentSessionDir("", "parent"), undefined);
  for (const id of ["", "../parent", ".", "-bad", "bad/child", "bad\\child"]) {
    assert.equal(isPathSafeSessionId(id), false);
    assert.equal(subagentSessionDir("sessions", id), undefined);
  }
  assert.equal(subagentSessionDir("sessions", "a_b.c-1"), path.join("sessions", "lite-subagent", "a_b.c-1"));
  assert.equal(SESSION_METADATA_CONCURRENCY, 4);
});

test("discovery reads only ordinary direct jsonl files and sorts by creation metadata, not modification time", async (t) => {
  const f = await withTempSessions(t);
  const older = await f.child(f.parent, "older", { agent: "worker", timestamp: "2026-10-19T00:00:00.000Z" });
  const newer = await f.child(f.parent, "newer", { agent: "reviewer", timestamp: SESSION_TIME });
  const directory = path.dirname(older.file);
  await fs.utimes(older.file, new Date("2030-01-01"), new Date("2030-01-01"));
  await fs.utimes(newer.file, new Date("2020-01-01"), new Date("2020-01-01"));
  await fs.writeFile(path.join(directory, "ignore.txt"), sessionText("ignored", f.cwd));
  await fs.mkdir(path.join(directory, "nested.jsonl"));
  await fs.writeFile(path.join(directory, "nested.jsonl", "hidden.jsonl"), sessionText("hidden", f.cwd));
  const before = await fs.readFile(older.file);
  const scan = await scanSubagentSessions(f.root, f.parent);
  assert.deepEqual(scan.sessions.map((session) => [session.header?.id, session.agent]), [
    ["newer", "reviewer"], ["older", "worker"],
  ]);
  assert.equal(scan.skipped, 1);
  assert.equal(scan.degraded, 0);
  assert.deepEqual(await fs.readFile(older.file), before, "discovery does not rewrite sessions");
});

test("malformed, missing-marker, empty and oversized files retain bounded metadata fallbacks", async (t) => {
  const f = await withTempSessions(t);
  const missing = await f.child(f.parent, "no-marker");
  const broken = await f.child(f.parent, "broken", { agent: "must-not-trust" });
  await fs.appendFile(broken.file, "not-json\nnull\n");
  const large = await f.child(f.parent, "large", { agent: "not-scanned" });
  const handle = await fs.open(large.file, "r+");
  try { await handle.truncate(MAX_SESSION_METADATA_BYTES + 1); } finally { await handle.close(); }
  const directory = path.dirname(missing.file);
  await fs.writeFile(path.join(directory, "empty.jsonl"), "");
  const fallback = "2026-10-21T01-02-03-004Z_invalid.jsonl";
  await fs.writeFile(path.join(directory, fallback), "{broken header\n");
  const scan = await scanSubagentSessions(f.root, f.parent);
  assert.equal(scan.sessions.length, 5);
  assert.equal(scan.degraded, 5);
  assert.ok(scan.sessions.every((session) => session.agent === "unknown"));
  assert.equal(scan.sessions.find((session) => session.fileName === fallback)?.created,
    Date.parse("2026-10-21T01:02:03.004Z"));
  assert.equal(scan.sessions.find((session) => session.fileName === "empty.jsonl")?.header, undefined);
  assert.deepEqual(await readSessionIdentity(large.file, scan.directory), large, "metadata size is not an open limit");
  await assert.rejects(readSessionIdentity(path.join(directory, "empty.jsonl")), /header/);
});

test("unsafe persistence and absent child directories fail without creating anything", async (t) => {
  const f = await withTempSessions(t);
  await assert.rejects(scanSubagentSessions("", f.parent), /persistent/);
  await assert.rejects(scanSubagentSessions(f.root, { ...f.parent, id: "../unsafe" }), /persistent/);
  await assert.rejects(scanSubagentSessions(f.root, f.parent));
  await assert.rejects(fs.stat(path.join(f.root, "lite-subagent")), { code: "ENOENT" });
  await assert.rejects(scanSubagentSessions(f.root, { ...f.parent, id: "wrong-id" }), /different session id/);
});

test("symbolic-link files are excluded and cannot be selected directly", async (t) => {
  const f = await withTempSessions(t);
  const ordinary = await f.child(f.parent, "ordinary", { agent: "worker" });
  const link = path.join(path.dirname(ordinary.file), "linked.jsonl");
  try {
    await fs.symlink(f.parent.file, link, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("File symlinks require platform privileges."); return; }
    throw error;
  }
  const scan = await scanSubagentSessions(f.root, f.parent);
  assert.deepEqual(scan.sessions.map((session) => session.header?.id), ["ordinary"]);
  assert.equal(scan.skipped, 1);
  await assert.rejects(readSessionIdentity(link, scan.directory), /ordinary/);
});

test("a child-directory junction cannot escape the expected session storage root", async (t) => {
  const f = await withTempSessions(t);
  const outside = path.join(f.cwd, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "unrelated.jsonl"), sessionText("unrelated", f.cwd));
  await fs.mkdir(path.join(f.root, "lite-subagent"));
  const candidate = path.join(f.root, "lite-subagent", f.parent.id);
  await fs.symlink(outside, candidate, "junction");
  await assert.rejects(scanSubagentSessions(f.root, f.parent), /escapes/);
});

test("selection revalidation rejects removal, wrong directory and changed headers", async (t) => {
  const f = await withTempSessions(t);
  const child = await f.child();
  const scan = await scanSubagentSessions(f.root, f.parent);
  await assert.rejects(readSessionIdentity(f.parent.file, scan.directory), /outside/);
  await fs.writeFile(child.file, sessionText("replacement", f.cwd));
  assert.equal((await readSessionIdentity(child.file, scan.directory)).id, "replacement");
  await fs.unlink(child.file);
  await assert.rejects(readSessionIdentity(child.file, scan.directory), { code: "ENOENT" });
});
