import { describe, it, expect } from "vitest";
import { classifyTool, isToolAllowed } from "../risk-model.js";
import { RiskLevel, DataClass, SideEffect } from "@motebit/protocol";
import type { ToolDefinition } from "@motebit/protocol";

function makeTool(name: string, description = "", extra?: Partial<ToolDefinition>): ToolDefinition {
  return { name, description, inputSchema: { type: "object" }, ...extra };
}

describe("classifyTool", () => {
  describe("risk level from name/description patterns", () => {
    it("classifies payment tools as R4_MONEY", () => {
      const profile = classifyTool(makeTool("stripe_charge", "Charge a credit card"));
      expect(profile.risk).toBe(RiskLevel.R4_MONEY);
      expect(profile.sideEffect).toBe(SideEffect.IRREVERSIBLE);
    });

    it("classifies shell/exec tools as R3_EXECUTE", () => {
      const profile = classifyTool(makeTool("shell_exec", "Run a shell command"));
      expect(profile.risk).toBe(RiskLevel.R3_EXECUTE);
      expect(profile.sideEffect).toBe(SideEffect.IRREVERSIBLE);
    });

    it("classifies write/create tools as R2_WRITE", () => {
      const profile = classifyTool(makeTool("file_write", "Write to a file"));
      expect(profile.risk).toBe(RiskLevel.R2_WRITE);
      expect(profile.sideEffect).toBe(SideEffect.REVERSIBLE);
    });

    it("classifies draft/compose tools as R1_DRAFT", () => {
      const profile = classifyTool(makeTool("draft_email", "Compose an email draft"));
      expect(profile.risk).toBe(RiskLevel.R1_DRAFT);
      expect(profile.sideEffect).toBe(SideEffect.NONE);
    });

    it("classifies read/search tools as R0_READ", () => {
      const profile = classifyTool(makeTool("web_search", "Search the web"));
      expect(profile.risk).toBe(RiskLevel.R0_READ);
      expect(profile.sideEffect).toBe(SideEffect.NONE);
    });

    it("defaults unknown tools to R0_READ", () => {
      const profile = classifyTool(makeTool("mystery_thing", "Does something unknown"));
      expect(profile.risk).toBe(RiskLevel.R0_READ);
    });

    it("matches from description when name is generic", () => {
      const profile = classifyTool(makeTool("tool_a", "Deploy the application to production"));
      expect(profile.risk).toBe(RiskLevel.R3_EXECUTE);
    });

    it("first matching rule wins (payment before write)", () => {
      // "refund" matches R4_MONEY even though it could be seen as a write
      const profile = classifyTool(makeTool("process_refund", "Process a customer refund"));
      expect(profile.risk).toBe(RiskLevel.R4_MONEY);
    });
  });

  describe("data class from name/description patterns", () => {
    it("classifies secret/credential tools as SECRET", () => {
      const profile = classifyTool(makeTool("get_secret", "Retrieve a stored secret"));
      expect(profile.dataClass).toBe(DataClass.SECRET);
    });

    it("classifies personal/memory tools as PRIVATE", () => {
      const profile = classifyTool(makeTool("recall_memory", "Recall a stored memory"));
      expect(profile.dataClass).toBe(DataClass.PRIVATE);
    });

    it("defaults to PUBLIC for unmatched tools", () => {
      const profile = classifyTool(makeTool("web_search", "Search the web"));
      expect(profile.dataClass).toBe(DataClass.PUBLIC);
    });
  });

  describe("explicit riskHint overrides inference", () => {
    it("uses explicit risk level from riskHint", () => {
      const tool = makeTool("search", "Search the web", {
        riskHint: { risk: RiskLevel.R4_MONEY },
      });
      const profile = classifyTool(tool);
      expect(profile.risk).toBe(RiskLevel.R4_MONEY);
    });

    it("uses explicit dataClass from riskHint", () => {
      const tool = makeTool("public_list", "List public items", {
        riskHint: { dataClass: DataClass.SECRET },
      });
      const profile = classifyTool(tool);
      expect(profile.dataClass).toBe(DataClass.SECRET);
    });

    it("uses explicit sideEffect from riskHint", () => {
      const tool = makeTool("shell_exec", "Run a shell command", {
        riskHint: { sideEffect: SideEffect.NONE },
      });
      const profile = classifyTool(tool);
      expect(profile.sideEffect).toBe(SideEffect.NONE);
    });
  });

  describe("requiresApproval", () => {
    it("requires approval for R2+ tools", () => {
      const profile = classifyTool(makeTool("file_write", "Write to a file"));
      expect(profile.requiresApproval).toBe(true);
    });

    it("does not require approval for R0/R1 tools by default", () => {
      const r0 = classifyTool(makeTool("web_search", "Search the web"));
      expect(r0.requiresApproval).toBe(false);
      const r1 = classifyTool(makeTool("draft_email", "Draft an email"));
      expect(r1.requiresApproval).toBe(false);
    });

    it("respects explicit requiresApproval on tool definition", () => {
      const tool = makeTool("safe_search", "Search safely");
      tool.requiresApproval = true;
      const profile = classifyTool(tool);
      expect(profile.requiresApproval).toBe(true);
    });
  });

  describe("risk level ordering", () => {
    it("R0 < R1 < R2 < R3 < R4", () => {
      expect(RiskLevel.R0_READ).toBeLessThan(RiskLevel.R1_DRAFT);
      expect(RiskLevel.R1_DRAFT).toBeLessThan(RiskLevel.R2_WRITE);
      expect(RiskLevel.R2_WRITE).toBeLessThan(RiskLevel.R3_EXECUTE);
      expect(RiskLevel.R3_EXECUTE).toBeLessThan(RiskLevel.R4_MONEY);
    });
  });
});

describe("isToolAllowed", () => {
  it("allows tool at or below max risk", () => {
    expect(
      isToolAllowed(
        {
          risk: RiskLevel.R0_READ,
          dataClass: DataClass.PUBLIC,
          sideEffect: SideEffect.NONE,
          requiresApproval: false,
        },
        RiskLevel.R2_WRITE,
      ),
    ).toBe(true);
    expect(
      isToolAllowed(
        {
          risk: RiskLevel.R2_WRITE,
          dataClass: DataClass.PUBLIC,
          sideEffect: SideEffect.REVERSIBLE,
          requiresApproval: true,
        },
        RiskLevel.R2_WRITE,
      ),
    ).toBe(true);
  });

  it("denies tool above max risk", () => {
    expect(
      isToolAllowed(
        {
          risk: RiskLevel.R3_EXECUTE,
          dataClass: DataClass.PUBLIC,
          sideEffect: SideEffect.IRREVERSIBLE,
          requiresApproval: true,
        },
        RiskLevel.R2_WRITE,
      ),
    ).toBe(false);
  });

  it("denies R4 tool when max is R3", () => {
    expect(
      isToolAllowed(
        {
          risk: RiskLevel.R4_MONEY,
          dataClass: DataClass.PUBLIC,
          sideEffect: SideEffect.IRREVERSIBLE,
          requiresApproval: true,
        },
        RiskLevel.R3_EXECUTE,
      ),
    ).toBe(false);
  });
});
