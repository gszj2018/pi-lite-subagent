import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { truncateSubagentOutput } from "../extension/truncation.ts";
import { removeTruncationArtifact } from "./helpers/cleanup.ts";

const HINT = /\[Output truncated: showing (\d+) of (\d+) lines \((\d+) of (\d+) bytes\)\. Full output saved to: (.+)\]/;

function tempFileDirs(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("pi-lite-subagent-output-")));
}

/** A temp-file dir created during `fn` whose output.txt contains the marker (attribution is content-based). */
function createdDirsContaining(before: Set<string>, marker: string): string[] {
  return [...tempFileDirs()].filter((name) => {
    if (before.has(name)) return false;
    try {
      return readFileSync(join(tmpdir(), name, "output.txt"), "utf-8").includes(marker);
    } catch {
      return false;
    }
  });
}

test("truncateSubagentOutput returns small output unchanged and writes no file", async () => {
  const before = tempFileDirs();
  const marker = `small-output-${Date.now()}-${Math.random()}`;
  const output = `${marker}\nsecond line`;

  const result = await truncateSubagentOutput(output);

  assert.equal(result, output);
  assert.deepEqual(createdDirsContaining(before, marker), [], "no temp file may be produced for small output");
});

test("truncateSubagentOutput over the byte limit saves the full output and reports stats", async (t) => {
  const line = "x".repeat(1024);
  const output = Array.from({ length: 100 }, () => line).join("\n");
  assert.ok(Buffer.byteLength(output, "utf-8") > DEFAULT_MAX_BYTES, "fixture exceeds the byte limit");

  const result = await truncateSubagentOutput(output);
  const match = result.match(HINT);
  assert.ok(match, "the truncation hint is present");
  const [, shownLines, totalLines, shownBytes, totalBytes, filePath] = match;
  t.after(() => removeTruncationArtifact(filePath));

  assert.ok(result.startsWith(line.slice(0, 64)), "truncated content keeps the beginning");
  assert.ok(Number(shownBytes) <= DEFAULT_MAX_BYTES);
  assert.ok(Number(shownLines) <= Number(totalLines));
  assert.ok(Number(shownBytes) < Number(totalBytes));
  assert.equal(Number(totalBytes), Buffer.byteLength(output, "utf-8"));
  assert.equal(await readFile(filePath, "utf-8"), output, "the temp file holds the complete output");
});

test("truncateSubagentOutput over the line limit saves the full output and reports stats", async (t) => {
  const totalLineCount = DEFAULT_MAX_LINES + 500;
  const output = Array.from({ length: totalLineCount }, (_, i) => `line-${i}`).join("\n");

  const result = await truncateSubagentOutput(output);
  const match = result.match(HINT);
  assert.ok(match, "the truncation hint is present");
  const [, shownLines, totalLines, shownBytes, totalBytes, filePath] = match;
  t.after(() => removeTruncationArtifact(filePath));

  assert.ok(Number(shownLines) <= DEFAULT_MAX_LINES);
  assert.equal(Number(totalLines), totalLineCount);
  assert.ok(Number(shownBytes) < Number(totalBytes));
  assert.equal(await readFile(filePath, "utf-8"), output, "the temp file holds the complete output");
});
