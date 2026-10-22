/** Process-local navigation transactions survive extension-runtime replacement through an injected env. */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RETURN_STACK_ENV } from "./env-vars.ts";
import { isPathSafeSessionId, sameSession, type SessionIdentity } from "./session-paths.ts";
import { singleLineLabel } from "./subagent-browser.ts";
import { showSubagentSessionSelector } from "./session-selector.ts";
import { readSessionIdentity, scanSubagentSessions } from "./subagent-sessions.ts";
import type { ProcessEnvLike } from "./types.ts";

export const MAX_RETURN_STACK_BYTES = 4096;
export const MAX_RETURN_STACK_DEPTH = 4;

export interface ReturnFrame {
  parent: SessionIdentity;
  child: SessionIdentity;
}

export interface NavigationPending {
  token: string;
  operation: "push" | "pop";
  from: SessionIdentity;
  to: SessionIdentity;
}

export interface NavigationState {
  version: 1;
  frames: ReturnFrame[];
  pending?: NavigationPending;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeIdentity(value: unknown): SessionIdentity {
  if (!record(value) || typeof value.file !== "string" || !path.isAbsolute(value.file) ||
    value.file.includes("\0") || path.normalize(value.file) !== value.file ||
    typeof value.id !== "string" || !isPathSafeSessionId(value.id)) throw new Error("Invalid navigation identity.");
  return { file: value.file, id: value.id };
}

export function currentSessionIdentity(ctx: ExtensionContext): SessionIdentity {
  return decodeIdentity({ file: ctx.sessionManager.getSessionFile(), id: ctx.sessionManager.getSessionId() });
}

function nextFrames(state: NavigationState, pending: NavigationPending): ReturnFrame[] {
  if (pending.operation === "push") {
    if (state.frames.length && !sameSession(state.frames.at(-1)!.child, pending.from)) {
      throw new Error("Navigation source does not match the return stack.");
    }
    return [...state.frames, { parent: pending.from, child: pending.to }];
  }
  const frame = state.frames.at(-1);
  if (!frame || !sameSession(frame.child, pending.from) || !sameSession(frame.parent, pending.to)) {
    throw new Error("Return transaction does not match the return stack.");
  }
  return state.frames.slice(0, -1);
}

function validateFrames(frames: ReturnFrame[]): void {
  if (frames.length > MAX_RETURN_STACK_DEPTH) throw new Error("Subagent navigation is limited to four layers.");
  const files: string[] = [];
  for (let index = 0; index < frames.length; index++) {
    const { parent, child } = frames[index];
    if (index === 0) files.push(parent.file);
    else if (!sameSession(frames[index - 1].child, parent)) throw new Error("Discontinuous return stack.");
    if (files.some((file) => path.relative(file, child.file) === "")) throw new Error("Cyclic return stack.");
    files.push(child.file);
  }
}

export function parseNavigationState(raw: string | undefined): NavigationState {
  if (raw === undefined) return { version: 1, frames: [] };
  if (Buffer.byteLength(raw, "utf8") > MAX_RETURN_STACK_BYTES) throw new Error("Return stack exceeds 4 KiB.");
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.version !== 1 || !Array.isArray(value.frames)) throw new Error("Invalid return stack.");
  const frames = value.frames.map((frame: unknown): ReturnFrame => {
    if (!record(frame)) throw new Error("Invalid return frame.");
    return { parent: decodeIdentity(frame.parent), child: decodeIdentity(frame.child) };
  });
  validateFrames(frames);
  const state: NavigationState = { version: 1, frames };
  if (value.pending !== undefined) {
    const pending = value.pending;
    if (!record(pending) || typeof pending.token !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(pending.token) ||
      (pending.operation !== "push" && pending.operation !== "pop")) throw new Error("Invalid navigation transaction.");
    state.pending = {
      token: pending.token, operation: pending.operation,
      from: decodeIdentity(pending.from), to: decodeIdentity(pending.to),
    };
    validateFrames(nextFrames(state, state.pending));
  }
  return state;
}

/** Encode before writing so rejected operations cannot overwrite a previously valid stack. */
export function serializeNavigationState(state: NavigationState): string | undefined {
  const raw = JSON.stringify(state);
  parseNavigationState(raw);
  return state.frames.length || state.pending ? raw : undefined;
}

export interface SessionNavigation {
  check(ctx: ExtensionContext): SessionIdentity;
  parent(ctx: ExtensionContext): SessionIdentity;
  switch(ctx: ExtensionCommandContext, operation: "push" | "pop", from: SessionIdentity,
    to: SessionIdentity): Promise<void>;
}

export function requireNavigationIdle(ctx: ExtensionContext): void {
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    throw new Error("Session navigation requires an idle agent with no pending messages.");
  }
}

export function registerSessionNavigation(pi: ExtensionAPI, env: ProcessEnvLike): SessionNavigation {
  let interactionActive = false;
  let retired = false;
  let permit: NavigationPending | undefined;

  const clear = () => { delete env[RETURN_STACK_ENV]; };
  const read = (): NavigationState => {
    try {
      return parseNavigationState(env[RETURN_STACK_ENV]);
    } catch {
      clear();
      throw new Error("Invalid subagent return stack; it has been cleared.");
    }
  };
  const write = (state: NavigationState) => {
    const raw = serializeNavigationState(state);
    if (raw === undefined) delete env[RETURN_STACK_ENV];
    else env[RETURN_STACK_ENV] = raw;
  };
  const checked = (ctx: ExtensionContext): { current: SessionIdentity; state: NavigationState } => {
    const state = read();
    let current: SessionIdentity;
    try {
      current = currentSessionIdentity(ctx);
    } catch (error) {
      if (state.frames.length || state.pending) clear();
      throw error;
    }
    if (state.frames.length && !sameSession(state.frames.at(-1)!.child, current)) {
      clear();
      throw new Error("Subagent return stack does not match this session; it has been cleared.");
    }
    if (state.pending) throw new Error("A subagent session switch is already pending.");
    return { current, state };
  };
  const rollback = (token: string) => {
    const state = read();
    if (state.pending?.token === token) write({ version: 1, frames: state.frames });
  };
  const blocked = (ctx: ExtensionContext) => {
    ctx.ui.notify("Return with /return-to-parent-session before replacing or forking this session.", "error");
    return { cancel: true as const };
  };

  // Reconcile the env in the fresh runtime before the session becomes interactive.
  pi.on("session_start", (_event, ctx) => {
    retired = false;
    permit = undefined;
    try {
      let state = read();
      if (!state.frames.length && !state.pending) { write(state); return; }
      const current = currentSessionIdentity(ctx);
      if (state.pending) {
        if (sameSession(current, state.pending.to)) {
          state = { version: 1, frames: nextFrames(state, state.pending) };
        } else if (sameSession(current, state.pending.from)) {
          state = { version: 1, frames: state.frames };
        } else {
          throw new Error("Subagent navigation transaction does not match this session.");
        }
      }
      if (state.frames.length && !sameSession(current, state.frames.at(-1)!.child)) {
        throw new Error("Subagent return stack does not match this session.");
      }
      write(state);
    } catch (error) {
      clear();
      ctx.ui.notify(`${error instanceof Error ? error.message : String(error)} Return navigation has been cleared.`, "error");
    }
  });
  pi.on("session_before_switch", (event, ctx) => {
    const credential = permit;
    permit = undefined;
    try {
      const state = read();
      if (!state.frames.length && !state.pending) return;
      const pending = state.pending;
      if (credential && pending && credential.token === pending.token && credential.operation === pending.operation &&
        event.reason === "resume" &&
        typeof event.targetSessionFile === "string" && path.isAbsolute(event.targetSessionFile) &&
        path.relative(event.targetSessionFile, credential.to.file) === "" &&
        sameSession(credential.from, pending.from) && sameSession(credential.to, pending.to) &&
        sameSession(currentSessionIdentity(ctx), credential.from)) {
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
    permit = undefined;
    try {
      const state = read();
      if (state.frames.length || state.pending) return blocked(ctx);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return { cancel: true };
    }
  });
  pi.on("session_shutdown", (event) => {
    retired = true;
    permit = undefined;
    if (event.reason === "quit") clear();
  });

  const navigation: SessionNavigation = {
    check: (ctx) => checked(ctx).current,
    parent: (ctx) => {
      const { state } = checked(ctx);
      const parent = state.frames.at(-1)?.parent;
      if (!parent) throw new Error("There is no parent session to return to.");
      return parent;
    },
    switch: async (ctx, operation, from, to) => {
      requireNavigationIdle(ctx);
      const { current, state } = checked(ctx);
      if (retired || !sameSession(current, from)) throw new Error("The active session changed before navigation.");
      const pending: NavigationPending = { token: randomUUID(), operation, from, to };
      write({ ...state, pending });
      permit = pending;
      try {
        const result = await ctx.switchSession(to.file);
        if (result.cancelled && !retired) rollback(pending.token);
      } catch (error) {
        // After teardown, the old context is unusable. Leave recovery to the next session_start.
        if (!retired) { rollback(pending.token); throw error; }
      } finally {
        permit = undefined;
      }
    },
  };

  const ensureCurrent = (ctx: ExtensionCommandContext, source: SessionIdentity) => {
    requireNavigationIdle(ctx);
    if (!sameSession(source, navigation.check(ctx))) throw new Error("The active session changed before navigation.");
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
    const source = navigation.check(ctx);
    const scan = await scanSubagentSessions(ctx.sessionManager.getSessionDir(), source);
    if (cancelled()) return;
    ensureCurrent(ctx, source);
    if (scan.skipped || scan.degraded) {
      ctx.ui.notify(`Subagent sessions: ${scan.skipped} skipped; ${scan.degraded} using incomplete metadata.`, "warning");
    }
    if (!scan.sessions.length) throw new Error("No persisted subagent sessions found for this session.");
    const file = await showSubagentSessionSelector(pi, ctx, scan.sessions);
    if (cancelled() || file === undefined) return;
    ensureCurrent(ctx, source);
    const selected = scan.sessions.find((session) => session.file === file);
    if (!selected?.header) throw new Error("The selected session has no valid session header.");
    const target = await readSessionIdentity(file, scan.directory);
    if (cancelled()) return;
    ensureCurrent(ctx, source);
    if (!sameSession(target, { file: selected.file, id: selected.header.id })) {
      throw new Error("The selected session changed after it was listed.");
    }
    await navigation.switch(ctx, "push", source, target);
  });
  registerCommand("return-to-parent-session", "Return to the parent session used for inspection.", async (ctx, cancelled) => {
    const source = navigation.check(ctx);
    const parent = navigation.parent(ctx);
    const target = await readSessionIdentity(parent.file);
    if (cancelled()) return;
    ensureCurrent(ctx, source);
    if (!sameSession(parent, target)) throw new Error("The parent session file no longer has the expected session id.");
    await navigation.switch(ctx, "pop", source, target);
  });
  return navigation;
}
