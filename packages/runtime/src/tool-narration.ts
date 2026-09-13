/**
 * Band narration for tool acts — the runtime-PRODUCED line the slab's
 * chrome band shows while a `band`-projected tool runs ("Searching
 * "dreamversal"", "Reading robots.txt").
 *
 * Produced, never authored: the string is derived from the tool name
 * and ai-core's `context` (already a bounded, human-shaped excerpt of
 * the arguments), not from the model — so it carries the truth-grade
 * of a receipted act, not of narration. It therefore sits in the same
 * chrome register as the model's `task_step_narration` but never
 * competes with it on authority. The tool's internal name is never
 * shown: `web_search` is the model's vocabulary, "Searching" is the
 * motebit's.
 */

const VERBS: Readonly<Record<string, string>> = {
  web_search: "Searching",
  read_file: "Reading",
  write_file: "Writing",
  read_url: "Reading",
  fetch_url: "Reading",
  read_page: "Reading",
  shell_exec: "Running",
  bash: "Running",
  shell: "Running",
  exec: "Running",
  run_command: "Running",
  recall_memories: "Recalling",
  search_memories: "Recalling",
  delegate_to_agent: "Asking a peer",
  computer: "Looking",
};

/** `some_tool_name` → `some tool name`; MCP `server__tool` → `tool`. */
function humanize(name: string): string {
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return bare.replace(/[_-]+/g, " ").trim().toLowerCase();
}

/** Trim a path or URL to the part a person recognises. */
function shortObject(name: string, context: string): string {
  if (name === "read_file" || name === "write_file") {
    const base = context.split(/[\\/]/).filter(Boolean).pop();
    return base ?? context;
  }
  if (name === "read_url" || name === "fetch_url" || name === "read_page") {
    try {
      const u = new URL(context);
      return u.pathname && u.pathname !== "/" ? `${u.hostname}${u.pathname}` : u.hostname;
    } catch {
      return context;
    }
  }
  return context;
}

/**
 * One line for the band. Always returns a non-empty sentence fragment;
 * never the raw tool identifier in isolation.
 */
export function describeToolStep(name: string, context?: string): string {
  const verb = VERBS[name];
  const object = context != null && context.trim() !== "" ? shortObject(name, context.trim()) : "";
  if (verb != null) return object ? `${verb} ${object}` : verb;
  const human = humanize(name);
  return object ? `Using ${human} ${object}` : `Using ${human}`;
}
