import { describe, it, expect } from "vitest";
import { skillScriptEnv } from "../skill-env.js";

describe("skillScriptEnv — approval covers the script, not the operator's secrets", () => {
  it("drops every credential-shaped and motebit variable, keeps the interpreter basics", () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/op",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      TERM: "xterm-256color",
      TMPDIR: "/tmp",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENAI_API_KEY: "sk-secret",
      GROQ_API_KEY: "gsk_secret",
      MOTEBIT_API_TOKEN: "relay-master",
      MOTEBIT_AUTH_TOKEN: "inbound",
      MOTEBIT_SOLANA_RPC_URL: "https://rpc.example/?key=abc",
      MOTEBIT_PASSPHRASE: "hunter2",
      AWS_SECRET_ACCESS_KEY: "aws",
      GITHUB_TOKEN: "ghp_x",
      SSH_AUTH_SOCK: "/tmp/agent",
      NPM_TOKEN: "npm",
    };
    const env = skillScriptEnv(parent);
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/op",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      TERM: "xterm-256color",
      TMPDIR: "/tmp",
    });
    for (const k of Object.keys(env)) {
      expect(/KEY|TOKEN|SECRET|PASS|MOTEBIT/i.test(k)).toBe(false);
    }
  });

  it("is an allowlist, not a denylist — an unknown variable is absent even if it looks harmless", () => {
    expect(skillScriptEnv({ PATH: "/bin", FOO: "bar", EDITOR: "vim" })).toEqual({ PATH: "/bin" });
  });

  it("never includes undefined values", () => {
    expect(skillScriptEnv({ PATH: undefined, HOME: "/h" })).toEqual({ HOME: "/h" });
  });
});
