/**
 * Test doubles for the Pi extension runtime.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => unknown;

// noinspection JSUnusedGlobalSymbols
export class MockPi {
  readonly handlers = new Map<string, Set<LifecycleHandler>>();
  readonly tools = new Map<string, any>();
  readonly entryRenderers = new Map<string, (entry: any, options: any, theme: any) => unknown>();
  readonly appendedEntries: { customType: string; data?: unknown }[] = [];

  readonly api = {
    on: (event: string, handler: LifecycleHandler) => {
      let entries = this.handlers.get(event);
      if (!entries) {
        entries = new Set();
        this.handlers.set(event, entries);
      }
      entries.add(handler);
      const registered = entries;
      return () => {
        registered.delete(handler);
      };
    },
    registerTool: (tool: { name: string }) => {
      this.tools.set(tool.name, tool);
    },
    registerEntryRenderer: (customType: string, renderer: (entry: any, options: any, theme: any) => unknown) => {
      this.entryRenderers.set(customType, renderer);
    },
    appendEntry: (customType: string, data?: unknown) => {
      this.appendedEntries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;

  async emitLifecycle(
    event: string,
    ctx: ExtensionContext,
    detail: string | Record<string, unknown> = "startup",
  ): Promise<unknown[]> {
    const payload = typeof detail === "string" ? { type: event, reason: detail } : { type: event, ...detail };
    const results: unknown[] = [];
    for (const handler of [...(this.handlers.get(event) ?? [])]) results.push(await handler(payload, ctx));
    return results;
  }

  count(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

export interface ContextOptions {
  sessionId?: string;
  sessionDir?: string;
  entries?: unknown[];
  cwd?: string;
  trusted?: boolean;
  mode?: ExtensionContext["mode"];
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
}

export interface MockContext {
  ctx: ExtensionToolContext;
  notifications: { message: string; type?: string }[];
}

export function createContext(options: ContextOptions = {}): MockContext {
  const notifications: { message: string; type?: string }[] = [];
  const mode = options.mode ?? "tui";
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: options.cwd ?? "/workspace",
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-1",
      getSessionDir: () => options.sessionDir ?? "",
      getEntries: () => options.entries ?? [],
    },
    isProjectTrusted: () => options.trusted ?? false,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionToolContext;
  return { ctx, notifications };
}

/** Drain the deterministic promise chain used by the mock adapters; never sleep or start a timer. */
export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
