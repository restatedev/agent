// Adapted from the deterministic QuickJS handoff. Only the host scheduler may
// deliver tool completions; asynchronous tool bodies never touch this runtime.
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | {[key: string]: Json};
type Failure = {name: string; message: string};
export type Outcome = {ok: true; value: Json} | {ok: false; error: Failure};
export type Request = {id: string; name: string; args: Json[]};
type State =
  | {status: "pending"}
  | {status: "fulfilled"; value: Json}
  | {status: "rejected"; error: Failure};

// Embedded WASM also works in the endpoint's single-file esbuild deployment.
// Initialization failures fail startup, never become model observations.
const engine = await newQuickJSWASMModuleFromVariant(variant.default);

/** Only known, deterministic guest failures may become model feedback. */
export class ProgramError extends Error {}

export type GuestLimits = {
  maxInterruptChecks?: number;
  maxJobsPerDrain?: number;
  maxToolCalls?: number;
};
export const MAX_SOURCE_LENGTH = 64_000;
const MAX_RESULT_LENGTH = 64_000;

export class Guest {
  private readonly rt: QuickJSRuntime;
  private readonly vm: QuickJSContext;
  private readonly requests: Request[] = [];
  private readonly maxJobsPerDrain: number;
  private readonly bridge: QuickJSHandle[] = [];
  private readonly deliverHandle: QuickJSHandle;
  private readonly snapshotHandle: QuickJSHandle;
  private budgetExceeded = false;

  constructor(source: string, toolNames: string[], limits: GuestLimits = {}) {
    if (source.length > MAX_SOURCE_LENGTH)
      throw new ProgramError("Program source exceeds 64,000 characters");
    this.maxJobsPerDrain = limits.maxJobsPerDrain ?? 10_000;
    this.rt = engine.newRuntime();
    this.rt.setMemoryLimit(32 * 1024 * 1024);
    this.rt.setMaxStackSize(512 * 1024);
    let interruptChecks = 0;
    this.rt.setInterruptHandler(() => {
      if (++interruptChecks > (limits.maxInterruptChecks ?? 10_000))
        this.budgetExceeded = true;
      return this.budgetExceeded;
    });
    try {
      this.vm = this.rt.newContext();
    } catch (error) {
      this.rt.dispose();
      throw error;
    }
    try {
      const request = this.vm.newFunction("request", (id, name, args) => {
        this.requests.push({
          id: this.vm.getString(id),
          name: this.vm.getString(name),
          args: JSON.parse(this.vm.getString(args)),
        });
      });
      this.vm.setProp(this.vm.global, "__request", request);
      request.dispose();
      const setup = this.evaluate(`(() => {
        const request = globalThis.__request;
        delete globalThis.__request;
        globalThis.Date = undefined;
        Math.random = () => { throw new Error("Use a tool for randomness"); };
        Object.freeze(Math);
        const stringify = JSON.stringify, parse = JSON.parse, toString = String;
        const GuestError = Error, NativePromise = Promise;
        const resolve = Promise.resolve.bind(Promise);
        const then = Function.prototype.call.bind(Promise.prototype.then);
        const pending = new Map();
        const get = pending.get.bind(pending), set = pending.set.bind(pending), remove = pending.delete.bind(pending);
        let sequence = 0;
        let snapshot = '{"status":"pending"}';
        const tools = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(
          ${JSON.stringify(toolNames)}.map(name => [name, (...args) => new NativePromise((resolve, reject) => {
            if (sequence >= ${limits.maxToolCalls ?? 128}) throw new GuestError("Program tool-call limit exceeded (128 calls)");
            const id = "call-" + sequence++;
            const encoded = stringify(args);
            set(id, {resolve, reject});
            request(id, name, encoded);
          })])
        )));
        return {
          start(program) {
            return then(then(resolve(), () => program(tools)), value => {
              // toJSON may throw or emit tools. Serialize once, during the drain.
              const encoded = stringify(value);
              if (encoded === undefined) throw new GuestError("Program must return JSON");
              if (encoded.length > ${MAX_RESULT_LENGTH}) throw new GuestError("Program result exceeds 64,000 characters; return a smaller summary");
              snapshot = '{"status":"fulfilled","value":' + encoded + '}';
            });
          },
          deliver(id, encoded) {
            const p = get(id);
            if (!p) throw new GuestError("Unknown completion: " + id);
            remove(id);
            const outcome = parse(encoded);
            if (outcome.ok) p.resolve(outcome.value);
            else p.reject(new GuestError(outcome.error.message));
          },
          snapshot() { return snapshot; },
          fail(error) {
            let name = "Error", message = "Unprintable guest error";
            try { name = toString(error?.name ?? "Error"); } catch {}
            try { message = toString(error?.message ?? error); } catch {}
            snapshot = '{"status":"rejected","error":{"name":' + stringify(name) + ',"message":' + stringify(message) + '}}';
          }
        };
      })()`);
      // Keep bridge functions in host handles, outside the program's globals and
      // lexical scope. Guest code cannot forge completions or read host state.
      const start = this.vm.getProp(setup, "start");
      this.deliverHandle = this.vm.getProp(setup, "deliver");
      this.snapshotHandle = this.vm.getProp(setup, "snapshot");
      const fail = this.vm.getProp(setup, "fail");
      this.bridge.push(start, this.deliverHandle, this.snapshotHandle, fail);
      setup.dispose();
      // Install the root rejection handler before running user code. The wrapper
      // itself is compiled independently, so program source cannot close over it.
      const launch = this.evaluate(
        "(() => { const then = Function.prototype.call.bind(Promise.prototype.then); return (start, fail, program) => then(start(program), undefined, fail); })()",
      );
      this.bridge.push(launch);
      const program = this.evaluate(`(${source}\n)`);
      try {
        this.checkResult(
          this.vm.callFunction(launch, this.vm.undefined, start, fail, program),
        ).dispose();
      } finally {
        program.dispose();
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private checkBudget(): void {
    if (this.budgetExceeded)
      throw new ProgramError("Guest execution budget exceeded");
  }

  private failGuest(error: QuickJSHandle): never {
    let detail = "Unprintable guest exception";
    try {
      const value = this.vm.dump(error);
      detail =
        typeof value?.message === "string"
          ? value.message
          : (JSON.stringify(value) ?? detail);
    } catch {
      /* Error rendering must not replace the original guest failure. */
    } finally {
      error.dispose();
    }
    this.checkBudget();
    throw new ProgramError(`Guest evaluation failed: ${detail}`);
  }

  private checkResult(
    result: ReturnType<QuickJSContext["evalCode"]>,
  ): QuickJSHandle {
    if (result.error) this.failGuest(result.error);
    if (this.budgetExceeded) {
      result.value.dispose();
      this.checkBudget();
    }
    return result.value;
  }

  private evaluate(code: string): QuickJSHandle {
    // Host/WASM exceptions propagate unchanged; only returned VM errors are
    // classified as deterministic program failures.
    return this.checkResult(this.vm.evalCode(code));
  }

  /** Never yield to Node while draining the guest microtask queue. */
  drain(): void {
    let jobs = 0;
    while (this.rt.hasPendingJob()) {
      if (++jobs > this.maxJobsPerDrain)
        throw new ProgramError("Guest microtask budget exceeded");
      const result = this.rt.executePendingJobs(1);
      if (result.error) this.failGuest(result.error);
      this.checkBudget();
    }
  }

  takeRequests(): Request[] {
    return this.requests.splice(0);
  }

  deliver(id: string, outcome: Outcome): void {
    const key = this.vm.newString(id);
    const encoded = this.vm.newString(JSON.stringify(outcome));
    try {
      this.checkResult(
        this.vm.callFunction(
          this.deliverHandle,
          this.vm.undefined,
          key,
          encoded,
        ),
      ).dispose();
    } finally {
      key.dispose();
      encoded.dispose();
    }
  }

  state(): State {
    const result = this.checkResult(
      this.vm.callFunction(this.snapshotHandle, this.vm.undefined),
    );
    try {
      return JSON.parse(this.vm.getString(result));
    } finally {
      result.dispose();
    }
  }

  dispose(): void {
    for (const handle of this.bridge) handle.dispose();
    this.vm.dispose();
    this.rt.dispose();
  }
}
