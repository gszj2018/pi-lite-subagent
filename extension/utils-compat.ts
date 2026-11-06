/**
 * Compatibility helpers for host API changes.
 *
 * Pi 1.5.0's host `StringEnum` no longer returns a schema whose static type TypeBox can
 * derive, which broke the parameter types of the `subagent` tool. This local wrapper keeps
 * the same JSON Schema shape (`type: "string"` plus `enum`) and restores the literal-union
 * static type; it is the only place that needs revisiting if the host helper is fixed.
 */

import { Type } from "typebox";

/**
 * String enum schema with a literal-union static type.
 *
 * Built through `Type.Unsafe` so the schema still serializes as a plain string enum while
 * `Static<typeof schema>` resolves to `T[number]`.
 */
export function StringEnum<const T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}
