import { AsyncLocalStorage } from 'node:async_hooks';
import { ChildProcess } from 'node:child_process';

/**
 * Tracks the child processes a tool call starts, so a timeout can kill them instead of leaving them running.
 * Every spawn (spawn, exec, execFile, fork) goes through ChildProcess.prototype.spawn; we note each child
 * in the calling tool's async context. Detached children are meant to outlive the call and are left alone.
 */
interface CallScope {
  children: Set<ChildProcess>;
  parent?: CallScope;
}

const scopes = new AsyncLocalStorage<CallScope>();
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  // `spawn` is a real method on ChildProcess.prototype, just not in Node's public typings.
  const proto = ChildProcess.prototype as unknown as { spawn: (this: ChildProcess, options: { detached?: boolean }) => unknown };
  const original = proto.spawn;
  proto.spawn = function patchedSpawn(this: ChildProcess, options: { detached?: boolean }) {
    const result = original.call(this, options);
    if (!options?.detached) {
      for (let s = scopes.getStore(); s; s = s.parent) {
        s.children.add(this);
        const scope = s;
        this.once('exit', () => scope.children.delete(this));
      }
    }
    return result;
  };
}

/** Runs `fn` in a scope that records the child processes it starts (including those of nested tool calls). */
export function withChildScope<T>(fn: () => Promise<T>): { promise: Promise<T>; killChildren: () => number } {
  install();
  const scope: CallScope = { children: new Set(), ...(scopes.getStore() ? { parent: scopes.getStore()! } : {}) };
  const promise = scopes.run(scope, fn);
  return {
    promise,
    killChildren: () => {
      const alive = [...scope.children].filter((c) => c.exitCode === null && c.signalCode === null);
      for (const c of alive) {
        c.kill('SIGTERM');
        // A child that ignores SIGTERM gets SIGKILL shortly after.
        const t = setTimeout(() => {
          if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
        }, 2000);
        t.unref?.();
      }
      scope.children.clear();
      return alive.length;
    },
  };
}
