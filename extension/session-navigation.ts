/** Process-local navigation transactions survive extension-runtime replacement through shared memory. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sameSessionFile } from "./session-paths.ts";
import { showSubagentSessionSelector } from "./session-selector.ts";
import { singleLineLabel } from "./subagent-browser.ts";
import { scanSubagentSessions, validateSessionFile } from "./subagent-sessions.ts";
import type { NavigationState, NavigationPending } from "./types.ts";

export function currentSessionFile(ctx: ExtensionContext): string {
  const file = ctx.sessionManager.getSessionFile();
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) {
    throw new Error("Invalid session file path.");
  }
  return fs.realpathSync(file);
}

function requireNavigationIdle(ctx: ExtensionContext): void {
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    throw new Error("Session navigation requires an idle agent with no pending messages.");
  }
}

export function registerSessionNavigation(pi: ExtensionAPI, state: NavigationState): void {
  let interactionActive = false;
  let retired = false;

  const clear = () => { state.frames.length = 0; delete state.pending; };
  const checked = (ctx: ExtensionContext): string => {
    if (state.pending) throw new Error("A subagent session switch is already pending.");
    return currentSessionFile(ctx);
  };
  const rollback = (pending: NavigationPending) => {
    if (state.pending === pending) delete state.pending;
  };
  const commit = (ctx: ExtensionContext) => {
    if (!state.pending) return;
    const current = currentSessionFile(ctx);
    if (!sameSessionFile(current, state.pending.to)) {
      throw new Error("Subagent navigation transaction does not match this session.");
    }
    if (state.pending.operation === "push") {
      state.frames.push(state.pending.from);
    } else {
      const parent = state.frames.at(-1);
      if (!parent || !sameSessionFile(parent, state.pending.to)) {
        throw new Error("Return transaction does not match the return stack.");
      }
      state.frames.pop();
    }
    delete state.pending;
  }
  const blocked = (ctx: ExtensionContext) => {
    ctx.ui.notify("Return with /return-to-parent-session before replacing or forking this session.", "error");
    return { cancel: true as const };
  };

  // Reconcile shared state in the fresh runtime before the session becomes interactive.
  pi.on("session_start", (_event, ctx) => {
    retired = false;
    try {
      commit(ctx);
    } catch (error) {
      clear();
      ctx.ui.notify(`${error instanceof Error ? error.message : String(error)} Return navigation has been cleared.`, "error");
    }
  });
  pi.on("session_before_switch", (event, ctx) => {
    try {
      if (!state.frames.length && !state.pending) return;
      const pending = state.pending;
      if (pending && event.reason === "resume" &&
        typeof event.targetSessionFile === "string" && path.isAbsolute(event.targetSessionFile) &&
        sameSessionFile(fs.realpathSync(event.targetSessionFile), pending.to) &&
        sameSessionFile(currentSessionFile(ctx), pending.from)) {
        requireNavigationIdle(ctx);
        return;
      }
      return blocked(ctx);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return { cancel: true };
    }
  });
  pi.on("session_before_fork", (_event, ctx) => {
    if (state.frames.length || state.pending) return blocked(ctx);
  });
  pi.on("session_shutdown", (event) => {
    retired = true;
    if (event.reason === "quit") clear();
  });

  const parentSessionFile = (ctx: ExtensionContext): string => {
    checked(ctx);
    const parent = state.frames.at(-1);
    if (!parent) throw new Error("There is no parent session to return to.");
    return parent;
  };
  const switchSession = async (
    ctx: ExtensionCommandContext, operation: "push" | "pop", from: string, to: string,
  ): Promise<void> => {
    requireNavigationIdle(ctx);
    const current = checked(ctx);
    if (retired || !sameSessionFile(current, fs.realpathSync(from))) {
      throw new Error("The active session changed before navigation.");
    }
    const pending: NavigationPending = { operation, from: current, to: fs.realpathSync(to) };
    state.pending = pending;
    try {
      const result = await ctx.switchSession(pending.to);
      if (result.cancelled && !retired) rollback(pending);
    } catch (error) {
      // After teardown, the old context is unusable. Leave recovery to the next session_start.
      if (!retired) { rollback(pending); throw error; }
    }
  };

  const ensureCurrent = (ctx: ExtensionCommandContext, source: string) => {
    requireNavigationIdle(ctx);
    if (!sameSessionFile(source, checked(ctx))) throw new Error("The active session changed before navigation.");
  };
  const registerCommand = (
    name: string, description: string,
    run: (ctx: ExtensionCommandContext, cancelled: () => boolean) => Promise<void>,
  ) => {
    pi.registerCommand(name, {
      description,
      handler: async (_args, ctx) => {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(`${name} requires interactive TUI mode.`, "error");
          return;
        }
        if (interactionActive) {
          ctx.ui.notify("Subagent session navigation is already active.", "error");
          return;
        }
        interactionActive = true;
        let cancelled = false;
        const unsubscribe = pi.on("session_shutdown", () => { cancelled = true; });
        try {
          requireNavigationIdle(ctx);
          await run(ctx, () => cancelled);
        } catch (error) {
          if (!cancelled) ctx.ui.notify(singleLineLabel(error instanceof Error ? error.message : String(error)), "error");
        } finally {
          cancelled = true;
          unsubscribe();
          interactionActive = false;
        }
      },
    });
  };
  registerCommand("switch-to-subagent-session", "Select a persisted child session to inspect.", async (ctx, cancelled) => {
    const source = checked(ctx);
    const scan = await scanSubagentSessions(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId(), source);
    if (cancelled()) return;
    ensureCurrent(ctx, source);
    if (!scan.sessions.length) throw new Error("No persisted subagent sessions found for this session.");
    const file = await showSubagentSessionSelector(pi, ctx, scan.sessions);
    if (cancelled() || file === undefined) return;
    ensureCurrent(ctx, source);
    const selected = scan.sessions.find((session) => session.file === file);
    if (!selected?.header) throw new Error("The selected session has no valid session header.");
    const target = await validateSessionFile(file, selected.header);
    if (cancelled()) return;
    ensureCurrent(ctx, source);
    await switchSession(ctx, "push", source, target);
  });
  registerCommand("return-to-parent-session", "Return to the parent session used for inspection.", async (ctx, cancelled) => {
    const source = checked(ctx);
    const parent = parentSessionFile(ctx);
    const target = await validateSessionFile(parent);
    if (cancelled()) return;
    ensureCurrent(ctx, source);
    await switchSession(ctx, "pop", source, target);
  });
}
