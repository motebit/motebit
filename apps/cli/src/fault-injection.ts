/**
 * Test-only fault injection for delegation result polling — the #433
 * acceptance run.
 *
 * #433: a transient relay 503 then 404 on the result poll made the agent
 * re-hire and pay again, and a "no" at the second payment prompt did not end
 * it. The production relay cannot be faulted on demand, so this makes the
 * CLIENT see that failure: with `MOTEBIT_FAULT_TASK_POLL` set, the global
 * `fetch` answers the delegator's result poll (`GET /agent/:id/task/:taskId`)
 * with a synthetic failure. Nothing else is touched — submit, payment, the
 * worker's `/result` POST and every other request pass through — so the
 * runtime's real poll loop (`pollForReceipt`) meets a real HTTP failure.
 *
 *   MOTEBIT_FAULT_TASK_POLL=503x<N>  the first N polls of each task get 503,
 *                                    then the real relay answers (transient)
 *   MOTEBIT_FAULT_TASK_POLL=lost     every poll gets 404 TASK_NOT_FOUND (the
 *                                    #433 shape: the result is unretrievable)
 *
 * Off unless the variable is set; announced on stderr when on. Never set it
 * outside a deliberate test run.
 */

export type TaskPollFault = { kind: "transient"; count: number } | { kind: "lost" };

/** `undefined`/empty → no fault; anything unparseable throws (a typo must not run a real hire unfaulted). */
export function parseTaskPollFault(spec: string | undefined): TaskPollFault | null {
  if (spec == null || spec.trim() === "") return null;
  const s = spec.trim();
  if (s === "lost") return { kind: "lost" };
  const m = /^503x([1-9]\d{0,2})$/.exec(s);
  if (m) return { kind: "transient", count: Number(m[1]) };
  throw new Error(
    `MOTEBIT_FAULT_TASK_POLL="${spec}" is not a fault — use 503x<N> (N = 1..999) or lost, or unset it.`,
  );
}

/** The task id when `url` is a delegator result poll (`/agent/:id/task/:taskId`, nothing after). */
export function taskPollId(url: string, method: string): string | null {
  if (method.toUpperCase() !== "GET") return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = /^\/agent\/[^/]+\/task\/([^/]+)$/.exec(path);
  return m?.[1] != null ? decodeURIComponent(m[1]) : null;
}

/** Wrap `base` so result polls fail per `fault`; returns the wrapped fetch. */
export function faultingFetch(base: typeof fetch, fault: TaskPollFault): typeof fetch {
  const seen = new Map<string, number>();
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method =
      init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    const taskId = taskPollId(url, method);
    if (taskId != null) {
      const n = (seen.get(taskId) ?? 0) + 1;
      seen.set(taskId, n);
      if (fault.kind === "lost") {
        return new Response(
          JSON.stringify({ error: "TASK_NOT_FOUND", message: "fault injection: result lost" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      if (n <= fault.count) {
        return new Response("fault injection: transient 503", { status: 503 });
      }
    }
    return base(input, init);
  };
}

/**
 * Install the fault from `env` onto `globalThis.fetch`. Returns the active
 * fault (and announces it on stderr), or null when the variable is unset.
 */
export function installTaskPollFault(
  env: NodeJS.ProcessEnv = process.env,
  announce: (line: string) => void = (line) => console.error(line),
): TaskPollFault | null {
  const fault = parseTaskPollFault(env.MOTEBIT_FAULT_TASK_POLL);
  if (fault == null) return null;
  globalThis.fetch = faultingFetch(globalThis.fetch.bind(globalThis), fault);
  announce(
    `⚠ FAULT INJECTION ON — MOTEBIT_FAULT_TASK_POLL=${env.MOTEBIT_FAULT_TASK_POLL}: delegation result polls ` +
      (fault.kind === "lost"
        ? "all return 404 TASK_NOT_FOUND (#433 shape)."
        : `get 503 for the first ${fault.count} poll(s) of each task.`) +
      " Test runs only.",
  );
  return fault;
}
