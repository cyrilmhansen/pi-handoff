/**
 * Mock harness: fake ExtensionAPI + ExtensionContext + in-memory fs.
 * No real pi runtime is loaded; only structural mocks of verified shapes.
 */

type Handler = (event: any, ctx: any) => any;

export interface MockPi {
  pi: any;
  handlers: Map<string, Handler[]>;
  commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  sentMessages: Array<{ message: any; options: any }>;
  entries: Array<{ type: string; data: unknown }>;
  emit: (event: { type: string; [k: string]: unknown }, ctx: any) => Promise<void>;
  runCommand: (name: string, args: string, ctx: any) => Promise<void>;
}

export function createMockPi(flags: Record<string, string> = {}): MockPi {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const sentMessages: Array<{ message: any; options: any }> = [];
  const entries: Array<{ type: string; data: unknown }> = [];

  const pi: any = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const l = handlers.get(event) ?? [];
        const i = l.indexOf(handler);
        if (i >= 0) l.splice(i, 1);
      };
    },
    registerCommand(name: string, opts: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, opts.handler);
    },
    registerFlag() {},
    getFlag(name: string): string | undefined {
      return flags[name];
    },
    registerTool() {},
    sendMessage(message: any, options: any) {
      sentMessages.push({ message, options });
    },
    appendEntry(type: string, data?: unknown) {
      entries.push({ type, data });
    },
    setActiveTools() {},
    getActiveTools() {
      return [];
    },
    setSessionName() {},
    getSessionName() {
      return undefined;
    },
  };

  async function emit(event: { type: string; [k: string]: unknown }, ctx: any): Promise<void> {
    for (const h of handlers.get(event.type) ?? []) await h(event, ctx);
  }

  async function runCommand(name: string, args: string, ctx: any): Promise<void> {
    const h = commands.get(name);
    if (!h) throw new Error(`command not registered: ${name}`);
    await h(args, ctx);
  }

  return { pi, handlers, commands, sentMessages, entries, emit, runCommand };
}

export interface UsageFixture {
  tokens: number | null;
  contextWindow: number;
}

export interface MockCtxOptions {
  cwd?: string;
  usage?: UsageFixture | undefined | null; // null => getContextUsage() returns undefined
  model?: { maxTokens: number; contextWindow: number } | undefined;
  sessionId?: string;
  mode?: string;
  hasUI?: boolean;
}

export interface MockCtx {
  ctx: any;
  notifications: Array<{ text: string; level: string | undefined }>;
  compactCalls: number;
  newSessionCalls: number;
  switchSessionCalls: number;
}

export function createMockCtx(options: MockCtxOptions = {}): MockCtx {
  const notifications: Array<{ text: string; level: string | undefined }> = [];
  const state = { compactCalls: 0, newSessionCalls: 0, switchSessionCalls: 0 };
  const usage = options.usage === undefined ? { tokens: 0, contextWindow: 220000 } : options.usage;
  const ctx: any = {
    mode: options.mode ?? "print",
    hasUI: options.hasUI ?? true,
    cwd: options.cwd ?? "/project",
    ui: {
      notify(text: string, level?: string) {
        notifications.push({ text, level });
      },
      setStatus() {},
    },
    getContextUsage: () => (usage === null ? undefined : { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: null }),
    model: options.model === undefined ? { maxTokens: 65536, contextWindow: 220000 } : options.model,
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-1",
      getBranch: () => [],
      getEntries: () => [],
    },
    isIdle: () => true,
    signal: undefined,
    abort() {},
    compact() {
      state.compactCalls += 1;
    },
    // command-only session ops (Phase 2 territory): must never be called in Phase 1
    newSession: async () => {
      state.newSessionCalls += 1;
      return { cancelled: false };
    },
    switchSession: async () => {
      state.switchSessionCalls += 1;
      return { cancelled: false };
    },
    waitForIdle: async () => {},
    shutdown() {},
    getSystemPrompt: () => "stable prompt",
  };
  return {
    ctx,
    notifications,
    get compactCalls() {
      return state.compactCalls;
    },
    get newSessionCalls() {
      return state.newSessionCalls;
    },
    get switchSessionCalls() {
      return state.switchSessionCalls;
    },
  };
}

/* ------------------------------------------------------------------ */
/* In-memory FsOps                                                     */
/* ------------------------------------------------------------------ */

import type { FsOps } from "../.pi/extensions/context-guard/checkpoint.ts";

export interface MemoryFs extends FsOps {
  files: Map<string, string>;
  failNext: Map<string, number>; // path -> number of failing writes remaining
  writes: string[];
}

export function createMemoryFs(initial: Record<string, string> = {}): MemoryFs {
  const files = new Map<string, string>(Object.entries(initial));
  const failNext = new Map<string, number>();
  const writes: string[] = [];
  const fs: MemoryFs = {
    files,
    failNext,
    writes,
    readFile(p) {
      return files.get(p);
    },
    writeFile(p, content) {
      const fails = failNext.get(p) ?? 0;
      if (fails > 0) {
        failNext.set(p, fails - 1);
        throw new Error(`simulated write failure for ${p}`);
      }
      files.set(p, content);
      writes.push(p);
    },
    exists(p) {
      return files.has(p);
    },
    mkdirRecursive() {
      /* memory fs: flat namespace */
    },
    listFiles(dir) {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).filter((k) => !k.includes("/"));
    },
    remove(p) {
      files.delete(p);
    },
  };
  return fs;
}

export const DEFAULT_FILES: Record<string, string> = {
  "/project/handoff.config.json": JSON.stringify({
    thresholds: { advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 },
    enforceClosing: true,
    closingAllowlist: ["write", "edit", "read"],
    protectGoal: true,
    autoCheckpointAtHandoffLevel: true,
    stateDir: ".pi-guard",
  }),
  "/project/GOAL.md": "# GOAL\n\n## Objective\nBuild a context guard prototype.\n\n## Acceptance criteria\n- Tests pass.\n",
  "/project/PROGRESS.md":
    "# PROGRESS\n\n## Current phase\nPhase 1\n\n## Completed\n- [x] inspect API\n\n## Pending\n- [ ] pass tests\n\n## Verified evidence\n(none)\n\n## Blockers\n(none)\n\n## Next action\nRun the test suite.\n",
  "/project/LEARNINGS.md":
    "# LEARNINGS\n\n## Accepted\n(none)\n\n## Proposed\n- [P-1] Use followUp delivery. evidence: docs. value: no interruption. cost: low. confidence: high. status: proposed\n\n## Falsified or superseded\n(none)\n",
  "/project/HANDOFF.md":
    "# HANDOFF\n\n## Recovery instructions\n- Read AGENTS.md, then PROGRESS.md.\n- Do not read raw transcripts.\n\n## Last verified state\nClean checkout.\n\n## Unfinished operations\n- [ ] pass tests\n\n## Next action\nRun the test suite.\n\n## Discoveries not yet incorporated\n- followUp deferral semantics.\n",
};
