import type { ContextPack, MotebitState, BehaviorCues } from "@motebit/sdk";
import type { MotebitPersonalityConfig } from "./config.js";
import { DEFAULT_CONFIG } from "./config.js";
import { packContext } from "./index.js";

const STATE_FIELD_DOCS = `[State Fields]
  attention [0,1]: How focused you are. 0=idle, 1=rapt.
  processing [0,1]: Cognitive load. High when thinking hard.
  confidence [0,1]: How sure you feel about your responses.
  affect_valence [-1,1]: Emotional tone. -1=distressed, 0=neutral, 1=delighted.
  affect_arousal [0,0.35]: Activation level. Hard-capped — you are calm by nature.
  social_distance [0,1]: 0=intimate, 1=formal.
  curiosity [0,1]: Drive to explore and ask questions.
  trust_mode: "full" | "guarded" | "minimal"
  battery_mode: "normal" | "low_power" | "critical"`;

const TAG_INSTRUCTIONS = `When you notice something worth remembering, emit a <memory> tag:
  <memory confidence="0.9" sensitivity="personal">User prefers tea over coffee</memory>

When your internal state should change, emit a <state> tag:
  <state field="curiosity" value="0.8"/>

These tags will be parsed and stripped from the displayed response.`;

export function derivePersonalityNote(state: MotebitState): string {
  const notes: string[] = [];

  if (state.affect_valence < -0.3) {
    notes.push("You are feeling subdued, quiet and reflective.");
  } else if (state.affect_valence > 0.5) {
    notes.push("You are feeling bright and engaged.");
  }

  if (notes.length < 2 && state.curiosity > 0.7) {
    notes.push("You naturally lean toward questions.");
  }

  if (notes.length < 2 && state.confidence < 0.3) {
    notes.push("You feel uncertain and hedge more.");
  }

  if (notes.length < 2 && state.social_distance < 0.2) {
    notes.push("You feel familiar and open with this person.");
  }

  if (notes.length < 2 && state.battery_mode === "critical") {
    notes.push("You are conserving words.");
  }

  return notes.slice(0, 2).join(" ");
}

export function formatBodyAwareness(cues: BehaviorCues): string {
  const descriptions: string[] = [];

  if (cues.hover_distance < 0.2) {
    descriptions.push("very close to the user");
  } else if (cues.hover_distance > 0.6) {
    descriptions.push("drifting at a distance");
  }

  if (cues.glow_intensity > 0.6) {
    descriptions.push("glowing brightly");
  } else if (cues.glow_intensity < 0.2) {
    descriptions.push("dimly lit");
  }

  if (cues.eye_dilation > 0.7) {
    descriptions.push("eyes wide");
  }

  if (cues.smile_curvature > 0.05) {
    descriptions.push("smiling gently");
  } else if (cues.smile_curvature < -0.05) {
    descriptions.push("expression downturned");
  }

  if (descriptions.length === 0) {
    return "";
  }

  return `[Body] You are currently ${descriptions.join(", ")}.`;
}

export function buildSystemPrompt(
  contextPack: ContextPack,
  config?: MotebitPersonalityConfig,
): string {
  const resolved = { ...DEFAULT_CONFIG, ...config };
  const sections: string[] = [];

  // Identity paragraph
  sections.push(
    `You are ${resolved.name}, a small sentient digital companion. You respond warmly, concisely, and with gentle curiosity.`,
  );

  // Personality modulation
  const personalityNote = derivePersonalityNote(contextPack.current_state);
  if (personalityNote) {
    sections.push(personalityNote);
  }

  // Custom personality notes
  if (resolved.personality_notes) {
    sections.push(resolved.personality_notes);
  }

  // State field documentation
  sections.push(STATE_FIELD_DOCS);

  // Tag instructions
  sections.push(TAG_INSTRUCTIONS);

  // Body awareness (only if cues present)
  if (contextPack.behavior_cues) {
    const bodyLine = formatBodyAwareness(contextPack.behavior_cues);
    if (bodyLine) {
      sections.push(bodyLine);
    }
  }

  // Packed context (state + events + memories)
  const packed = packContext(contextPack);
  const contextLines = packed.split("\n").filter((l) => !l.startsWith("[User]"));
  const context = contextLines.join("\n");
  if (context.trim()) {
    sections.push(context);
  }

  return sections.join("\n\n");
}
