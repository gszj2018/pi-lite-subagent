import assert from "node:assert/strict";
import { test } from "node:test";
import { mapWithConcurrencyLimit } from "../extension/utils.ts";
import { flushPromises } from "./helpers/mocks.ts";

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
