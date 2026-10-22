/** All filesystem operations use self-cleaning temporary trees, never user session directories. */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { isPathSafeSessionId, sameSessionFile, subagentSessionDir } from "../extension/session-paths.ts";
import { MAX_SESSION_METADATA_BYTES, scanSubagentSessions, SESSION_METADATA_CONCURRENCY,
  validateSessionFile } from "../extension/subagent-sessions.ts";
import { sessionText, SESSION_TIME, withTempSessions } from "./helpers/sessions-fixture.ts";

test("shared session paths preserve the runner layout and reject unsafe ids without creating directories", () => {
  assert.equal(subagentSessionDir("", "parent"), undefined);
  for (const id of ["", "../parent", ".", "-bad", "bad/child", "bad\\child"]) {
    assert.equal(isPathSafeSessionId(id), false);
    assert.equal(subagentSessionDir("sessions", id), undefined);
  }
  assert.equal(subagentSessionDir("sessions", "a_b.c-1"), path.join("sessions", "lite-subagent", "a_b.c-1"));
  assert.equal(SESSION_METADATA_CONCURRENCY, 4);
  const file = path.resolve("virtual-sessions", "parent.jsonl");
  assert.equal(sameSessionFile(file, `${path.dirname(file)}${path.sep}.${path.sep}parent.jsonl`), true);
  assert.equal(sameSessionFile(file, path.resolve("virtual-sessions", "child.jsonl")), false);
  assert.equal(sameSessionFile(file, file.toUpperCase()), path.sep === "\\", "comparison follows native path rules");
});

test("discovery reads only ordinary direct jsonl files and sorts by creation metadata, not modification time", async (t) => {
  const f = await withTempSessions(t);
  const older = await f.child(f.parent, "older", { agent: "worker", timestamp: "2026-10-19T00:00:00.000Z" });
  const newer = await f.child(f.parent, "newer", { agent: "reviewer", timestamp: SESSION_TIME });
  const directory = path.dirname(older.file);
  await fs.utimes(older.file, new Date("2030-01-01"), new Date("2030-01-01"));
  await fs.utimes(newer.file, new Date("2020-01-01"), new Date("2020-01-01"));
  await fs.writeFile(path.join(directory, "ignore.txt"), sessionText("ignored", f.projectDir));
  await fs.mkdir(path.join(directory, "nested.jsonl"));
  await fs.writeFile(path.join(directory, "nested.jsonl", "hidden.jsonl"), sessionText("hidden", f.projectDir));
  const before = await fs.readFile(older.file);
  const scan = await scanSubagentSessions(f.sessionDir, f.parent.id, f.parent.file);
  assert.deepEqual(scan.sessions.map((session) => [session.header?.id, session.agent]), [
    ["newer", "reviewer"], ["older", "worker"],
  ]);
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
  const scan = await scanSubagentSessions(f.sessionDir, f.parent.id, f.parent.file);
  assert.equal(scan.sessions.length, 5);
  assert.ok(scan.sessions.every((session) => session.agent === "unknown"));
  assert.equal(scan.sessions.find((session) => session.fileName === fallback)?.created,
    Date.parse("2026-10-21T01:02:03.004Z"));
  assert.equal(scan.sessions.find((session) => session.fileName === "empty.jsonl")?.header, undefined);
  assert.equal(await validateSessionFile(large.file), large.file, "metadata size is not an open limit");
  await assert.rejects(validateSessionFile(path.join(directory, "empty.jsonl")), /header/);
});

test("unsafe persistence and absent child directories fail without creating anything", async (t) => {
  const f = await withTempSessions(t);
  await assert.rejects(scanSubagentSessions("", f.parent.id, f.parent.file), /persistent/);
  await assert.rejects(scanSubagentSessions(f.sessionDir, "../unsafe", f.parent.file), /persistent/);
  await assert.rejects(scanSubagentSessions(f.sessionDir, f.parent.id, f.parent.file));
  await assert.rejects(fs.stat(path.join(f.sessionDir, "lite-subagent")), { code: "ENOENT" });
  await assert.rejects(scanSubagentSessions(f.sessionDir, "absent-storage-id", f.parent.file), { code: "ENOENT" });
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
  const scan = await scanSubagentSessions(f.sessionDir, f.parent.id, f.parent.file);
  assert.deepEqual(scan.sessions.map((session) => session.header?.id), ["ordinary"]);
  await assert.rejects(validateSessionFile(link), /ordinary/);
});

test("scanning resolves directory junctions and returns canonical file paths", async (t) => {
  const f = await withTempSessions(t);
  const outside = path.join(f.projectDir, "external-sessions");
  await fs.mkdir(outside);
  const file = path.join(outside, "external.jsonl");
  await fs.writeFile(file, sessionText("external", f.projectDir));
  await fs.mkdir(path.join(f.sessionDir, "lite-subagent"));
  const candidate = path.join(f.sessionDir, "lite-subagent", f.parent.id);
  await fs.symlink(outside, candidate, "junction");
  const scan = await scanSubagentSessions(f.sessionDir, f.parent.id, f.parent.file);
  assert.equal(scan.directory, await fs.realpath(outside));
  assert.deepEqual(scan.sessions.map((session) => session.file), [await fs.realpath(file)]);
  assert.equal(await validateSessionFile(path.join(candidate, "external.jsonl")), await fs.realpath(file));
});

test("session validation compares a supplied header id", async (t) => {
  const f = await withTempSessions(t);
  const child = await f.child();
  const scan = await scanSubagentSessions(f.sessionDir, f.parent.id, f.parent.file);
  const expected = scan.sessions[0].header;
  assert.ok(expected);
  assert.equal(await validateSessionFile(child.file, expected), await fs.realpath(child.file));
  await fs.writeFile(child.file, sessionText("changed-id", f.projectDir));
  await assert.rejects(validateSessionFile(child.file, expected), /expected session id/);
});

test("session validation rejects invalid headers and removed files", async (t) => {
  const f = await withTempSessions(t);
  const child = await f.child();
  await fs.writeFile(child.file, "bad header\n");
  await assert.rejects(validateSessionFile(child.file), /header/);
  await fs.unlink(child.file);
  await assert.rejects(validateSessionFile(child.file), { code: "ENOENT" });
});
