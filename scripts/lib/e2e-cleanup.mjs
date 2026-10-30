/**
 * e2e-cleanup.mjs — shared temporary-artifact lifecycle for the out-of-band e2e
 * scripts (D7). Used by scripts/e2e-renew.mjs, scripts/e2e-rpc-two-process.mjs and
 * scripts/check-skill-discovery.mjs.
 *
 * Guarantees (all zero-inference, test-owned):
 *   - EVERY temp directory this invocation creates is registered AT CREATION
 *     (ArtifactTracker.createTempDir), before any further setup can throw;
 *   - cleanup runs on the successful path, on failed assertions, on thrown
 *     timeouts, on uncaught setup errors (process 'exit' safety net) and on
 *     SIGINT/SIGTERM/SIGHUP (signal handlers);
 *   - tracked child processes are shut down BEFORE their workspaces are removed;
 *   - removal is restricted to the EXACT directories this invocation created:
 *     only paths returned by createTempDir (an exclusive mkdtemp, which proves
 *     this process created them), each directly under os.tmpdir() and starting
 *     with this tracker's prefix. Unregistered paths are never removed, and a
 *     registration attempt for any other path THROWS. There is deliberately NO
 *     global /tmp/guard-* sweeper: pre-existing foreign artifacts are not this
 *     script's to delete.
 *   - retention: GUARD_E2E_KEEP === "1" is the ONLY value that keeps artifacts
 *     (forensics). "0", "true", "" or anything else means REMOVE (the old
 *     truthiness check in check-skill-discovery.mjs treated "0" as keep — defect).
 *
 * NOT guaranteed (stated honestly): SIGKILL (kill -9) and machine crashes cannot
 * be handled by any in-process code — they leave artifacts and, depending on the
 * OS, possibly live children. Nothing here pretends otherwise; on the next
 * invocation, leaked directories from a SIGKILLed run stay where they are (no
 * sweep). Cleaning /tmp of such leftovers is an operator decision, not script
 * behavior.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Retention is requested ONLY by the exact value "1". */
export function keepRequested(env = process.env) {
  return env.GUARD_E2E_KEEP === "1";
}

const GUARD_PREFIX = "guard-"; // hard floor: nothing outside <tmpdir>/guard-* is ever removable
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export class ArtifactTracker {
  /**
   * @param {object} opts
   * @param {string} opts.prefix    required basename prefix for owned dirs (must start with "guard-")
   * @param {object} [opts.env]     environment (default process.env)
   * @param {object} [opts.deps]    injectable seams for tests: { mkdtemp, rm, log }
   */
  constructor({ prefix, env = process.env, deps = {} } = {}) {
    if (typeof prefix !== "string" || !prefix.startsWith(GUARD_PREFIX)) {
      throw new Error(`ArtifactTracker prefix must start with "${GUARD_PREFIX}" (got ${JSON.stringify(prefix)})`);
    }
    this.prefix = prefix;
    this.keep = keepRequested(env);
    this.tmpRoot = path.resolve(os.tmpdir());
    this.deps = {
      mkdtemp: (tpl) => fs.mkdtempSync(tpl),
      rm: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
      log: (msg) => console.log(`[e2e-cleanup] ${msg}`),
      exit: (code) => process.exit(code),
      ...deps,
    };
    this._dirs = []; // creation order
    this._owned = new Set();
    this._children = new Set();
    this._spawnErrors = new Map();
    this._done = false;
    this._promise = null;
    this._lastReport = null;
    this._handlersInstalled = false;
  }

  /** Create a temp dir OWNED BY THIS INVOCATION and register it immediately. */
  createTempDir(tag = "") {
    const template = tag ? path.join(this.tmpRoot, `${this.prefix}${tag}-`) : path.join(this.tmpRoot, this.prefix);
    const dir = this.deps.mkdtemp(template); // exclusive creation: this process owns the name
    this._register(dir);
    return dir;
  }

  _register(dir) {
    const abs = path.resolve(dir);
    const base = path.basename(abs);
    const parent = path.dirname(abs);
    if (!base.startsWith(this.prefix) || parent !== this.tmpRoot) {
      throw new Error(
        `refusing to own ${dir}: cleanup may only remove ${this.prefix}* directories directly under ${this.tmpRoot} that this invocation created (no sweeper, no foreign paths)`,
      );
    }
    if (this._owned.has(abs)) return abs;
    this._owned.add(abs);
    this._dirs.push(abs);
    return abs;
  }

  ownsDir(dir) {
    return this._owned.has(path.resolve(dir));
  }

  /** Directories created and owned by this invocation, in creation order. */
  ownedDirs() {
    return [...this._dirs];
  }

  /** Track a spawned child so shutdown and signal cleanup can reach it. */
  trackChild(child) {
    this._children.add(child);
    // A spawn error (e.g. binary missing) must never become an uncaught throw
    // nor hang an exit-wait: record it and treat the child as dead.
    child.once("error", (err) => {
      this._spawnErrors.set(child, err);
    });
    return child;
  }

  _isDead(child) {
    return child.exitCode != null || child.signalCode != null || this._spawnErrors.has(child);
  }

  _kill(child, signal) {
    if (this._isDead(child)) return false;
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
    return true;
  }

  /** Graceful child shutdown: close stdin, wait, escalate SIGTERM -> SIGKILL. */
  async _shutdownChildren(graceMs) {
    const live = [...this._children].filter((ch) => !this._isDead(ch));
    await Promise.all(
      live.map(
        (ch) =>
          new Promise((resolve) => {
            let settled = false;
            let termTimer = null;
            let killTimer = null;
            const fin = () => {
              if (settled) return;
              settled = true;
              if (termTimer) clearTimeout(termTimer);
              if (killTimer) clearTimeout(killTimer);
              resolve();
            };
            try {
              ch.once("exit", fin);
            } catch {}
            try {
              ch.stdin?.end();
            } catch {
              /* already closed */
            }
            termTimer = setTimeout(() => this._kill(ch, "SIGTERM"), graceMs);
            killTimer = setTimeout(() => {
              this._kill(ch, "SIGKILL");
              fin();
            }, graceMs + 1000);
            termTimer.unref?.();
            killTimer.unref?.();
          }),
      ),
    );
    for (const ch of this._children) if (!this._isDead(ch)) this._kill(ch, "SIGKILL");
  }

  /**
   * Normal-path cleanup (awaited from the script's finally): children first,
   * then owned directories, newest first. Idempotent (memoized promise); a
   * concurrent cleanupSync() from a signal handler still performs the removal.
   */
  cleanup({ graceMs = 2000 } = {}) {
    if (this._done) return Promise.resolve(this._lastReport);
    if (!this._promise) {
      this._promise = this._doCleanup(graceMs).then((report) => {
        this._done = true;
        this._lastReport = report;
        return report;
      });
    }
    return this._promise;
  }

  async _doCleanup(graceMs) {
    await this._shutdownChildren(graceMs);
    const report = { kept: this.keep, removed: [], retained: [], killed: 0, errors: [] };
    for (const dir of [...this._dirs].reverse()) {
      if (this.keep) {
        report.retained.push(dir);
        continue;
      }
      try {
        this.deps.rm(dir);
        report.removed.push(dir);
      } catch (e) {
        report.errors.push(`rm ${dir}: ${e?.message ?? e}`);
      }
    }
    return report;
  }

  /**
   * Abrupt-path cleanup (signal handlers, process 'exit' safety net): fully
   * synchronous. Children get SIGTERM immediately followed by SIGKILL — no wait
   * is possible here — and workspaces are removed only AFTER the kill calls,
   * so a removed directory is never still a live process's workspace.
   */
  cleanupSync() {
    if (this._done) return this._lastReport;
    this._done = true;
    let killed = 0;
    for (const ch of this._children) {
      if (this._isDead(ch)) continue;
      this._kill(ch, "SIGTERM");
      this._kill(ch, "SIGKILL");
      killed++;
    }
    const report = { kept: this.keep, removed: [], retained: [], killed, errors: [], sync: true };
    for (const dir of [...this._dirs].reverse()) {
      if (this.keep) {
        report.retained.push(dir);
        continue;
      }
      try {
        this.deps.rm(dir);
        report.removed.push(dir);
      } catch (e) {
        report.errors.push(`rm ${dir}: ${e?.message ?? e}`);
      }
    }
    this._lastReport = report;
    return report;
  }

  /**
   * Install the safety nets: SIGINT/SIGTERM/SIGHUP -> cleanup + 128+n exit, and
   * an 'exit' safety net covering uncaught setup throws and process.exit().
   * Call this BEFORE creating the first artifact. SIGKILL and machine crashes
   * cannot be handled — no in-process code runs for them (see header).
   */
  installHandlers() {
    if (this._handlersInstalled) return;
    this._handlersInstalled = true;
    process.on("exit", () => this.cleanupSync());
    for (const sig of Object.keys(SIGNAL_EXIT)) {
      process.on(sig, () => {
        try {
          this.deps.log(`${sig}: shutting down tracked children, then removing owned artifacts${this.keep ? " (GUARD_E2E_KEEP=1: kept)" : ""}`);
        } catch {}
        this.cleanupSync();
        this.deps.exit(SIGNAL_EXIT[sig]);
      });
    }
  }
}

/** Resolve when the child is gone OR its spawn failed — never hangs on ENOENT. */
export function onceExited(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) return resolve();
    child.once("exit", resolve);
    child.once("error", resolve);
  });
}
