// noinspection JSPrimitiveTypeWrapperUsage

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asRecord, asString, isRecord, isValidDateString, mapWithConcurrencyLimit, parseFiniteNumber,
} from "../extension/utils.ts";
import { flushPromises } from "./helpers/mocks.ts";

test("record helpers accept non-null non-array objects without cloning or validating fields", () => {
  const values: unknown[] = [{}, { name: 42, nested: { value: "kept" } }, Object.create(null), new Date(0)];
  for (const value of values) {
    assert.ok(isRecord(value));
    assert.equal(asRecord(value), value);
  }
});

test("record helpers reject null, arrays and non-object values", () => {
  const values: unknown[] = [undefined, null, false, true, 0, 42, "", "text", 1n, Symbol("value"), () => {}, [], [{}]];
  for (const value of values) {
    assert.equal(isRecord(value), false);
    assert.equal(asRecord(value), undefined);
  }
});

test("string conversion preserves primitive strings without trimming or coercing other values", () => {
  for (const value of ["", " \n\t ", "text", "中文🙂"]) assert.equal(asString(value), value);
  const nonStrings = [undefined, null, true, 0, 1n, Symbol("value"), [], new String("text"), {
    toString() { throw new Error("must not coerce objects"); },
  }];
  for (const value of nonStrings) assert.equal(asString(value), undefined);
});

test("finite-number parsing accepts numbers and non-blank numeric strings without integer or sign restrictions", () => {
  const cases: [unknown, number][] = [
    [0, 0], [-0, -0], [-2.5, -2.5], [Number.MAX_VALUE, Number.MAX_VALUE],
    ["0", 0], [" -2.5 ", -2.5], ["1e3", 1000], ["0x10", 16],
  ];
  for (const [value, expected] of cases) assert.equal(parseFiniteNumber(value), expected);
});

test("finite-number parsing rejects blank, non-finite and non-numeric values without coercing objects", () => {
  const values = [undefined, null, true, false, "", " \n\t ", "invalid", "NaN", "Infinity", "1e999",
    NaN, Infinity, -Infinity, 1n, Symbol("value"), [], [1], new Number(1), {
      valueOf() { throw new Error("must not coerce objects"); },
    }];
  for (const value of values) assert.equal(parseFiniteNumber(value), undefined);
});

test("date-string validation accepts parseable strings without requiring ISO and rejects invalid or non-string values", () => {
  for (const value of ["2026-10-20T10:00:00.000Z", "2026-10-20", "Tue, 20 Oct 2026 10:00:00 GMT"]) {
    assert.equal(isValidDateString(value), true);
  }
  const invalid = [undefined, null, true, 0, "", " ", "not a date", "2026-99-99T00:00:00Z", new Date(0),
    new String("2026-10-20"), { toString() { throw new Error("must not coerce objects"); } }];
  for (const value of invalid) assert.equal(isValidDateString(value), false);
});

test("concurrent mapping returns an empty result without calling the mapper for empty input", async () => {
  const results = await mapWithConcurrencyLimit([], 4, async () => {
    assert.fail("the mapper must not run for empty input");
  });
  assert.deepEqual(results, []);
});

test("concurrent mapping refills free workers and preserves input order and indexes", async (t) => {
  const items = [10, 20, 30, 40, 50];
  const releases: (() => void)[] = [];
  const gates = items.map(() => new Promise<void>((resolve) => { releases.push(resolve); }));
  const started: number[] = [];
  let active = 0;
  let maxActive = 0;
  const mapping = mapWithConcurrencyLimit(items, 2, async (item, index) => {
    started.push(index);
    maxActive = Math.max(maxActive, ++active);
    await gates[index];
    active--;
    return { item, index };
  });
  t.after(async () => {
    for (const release of releases) release();
    await mapping;
  });

  assert.deepEqual(started, [0, 1]);
  releases[1]();
  await flushPromises();
  assert.deepEqual(started, [0, 1, 2]);
  releases[2]();
  await flushPromises();
  assert.deepEqual(started, [0, 1, 2, 3]);
  releases[3]();
  await flushPromises();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  releases[4]();
  releases[0]();

  assert.deepEqual(await mapping, items.map((item, index) => ({ item, index })));
  assert.equal(maxActive, 2);
  assert.equal(active, 0);
});

test("concurrent mapping clamps non-positive limits to one and oversized limits to the input length", async () => {
  const items = [1, 2, 3];
  for (const limit of [-1, 0, 8]) {
    let active = 0;
    let maxActive = 0;
    const results = await mapWithConcurrencyLimit(items, limit, async (item) => {
      maxActive = Math.max(maxActive, ++active);
      await Promise.resolve();
      active--;
      return item * 2;
    });
    assert.deepEqual(results, [2, 4, 6]);
    assert.equal(maxActive, limit <= 0 ? 1 : items.length);
    assert.equal(active, 0);
  }
});

test("concurrent mapping propagates synchronous mapper throws and rejected promises", async () => {
  const error = new Error("mapper failed");
  for (const mapper of [() => { throw error; }, () => Promise.reject(error)]) {
    await assert.rejects(mapWithConcurrencyLimit([1], 1, mapper), (caught) => caught === error);
  }
});
