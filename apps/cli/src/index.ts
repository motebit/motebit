import * as readline from "node:readline";
import { CloudProvider, runTurn } from "@mote/ai-core";
import type { MoteLoopDependencies } from "@mote/ai-core";
import { EventStore, InMemoryEventStore } from "@mote/event-log";
import { MemoryGraph, InMemoryMemoryStorage } from "@mote/memory-graph";
import { StateVectorEngine } from "@mote/state-vector";
import { BehaviorEngine } from "@mote/behavior-engine";

// --- Configuration ---

const MOTE_ID = "mote-cli";

function getApiKey(): string {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key) {
    console.error(
      "Error: ANTHROPIC_API_KEY environment variable is not set.\n" +
        "Set it with: export ANTHROPIC_API_KEY=sk-ant-...",
    );
    process.exit(1);
  }
  return key;
}

// --- Bootstrap dependencies ---

function createDependencies(apiKey: string): MoteLoopDependencies {
  const eventStore = new EventStore(new InMemoryEventStore());
  const memoryStorage = new InMemoryMemoryStorage();
  const memoryGraph = new MemoryGraph(memoryStorage, eventStore, MOTE_ID);
  const stateEngine = new StateVectorEngine();
  const behaviorEngine = new BehaviorEngine();
  const cloudProvider = new CloudProvider({
    provider: "anthropic",
    api_key: apiKey,
    model: "claude-sonnet-4-5-20250514",
    max_tokens: 1024,
    temperature: 0.7,
  });

  return {
    moteId: MOTE_ID,
    eventStore,
    memoryGraph,
    stateEngine,
    behaviorEngine,
    cloudProvider,
  };
}

// --- REPL ---

async function main(): Promise<void> {
  const apiKey = getApiKey();
  const deps = createDependencies(apiKey);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Mote CLI — type a message, or 'quit' to exit\n");

  const prompt = (): void => {
    rl.question("you> ", (line) => {
      void handleLine(line);
    });
  };

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();

    if (trimmed === "quit" || trimmed === "exit") {
      console.log("Goodbye!");
      rl.close();
      return;
    }

    if (trimmed === "") {
      prompt();
      return;
    }

    try {
      const result = await runTurn(deps, trimmed);

      console.log(`\nmote> ${result.response}\n`);

      if (result.memoriesFormed.length > 0) {
        console.log(
          `  [memories formed: ${result.memoriesFormed.map((m) => m.content).join(", ")}]`,
        );
      }

      const s = result.stateAfter;
      console.log(
        `  [state: attention=${s.attention.toFixed(2)} confidence=${s.confidence.toFixed(2)} valence=${s.affect_valence.toFixed(2)} curiosity=${s.curiosity.toFixed(2)}]`,
      );
      console.log();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  [error: ${message}]\n`);
    }

    prompt();
  };

  prompt();
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
