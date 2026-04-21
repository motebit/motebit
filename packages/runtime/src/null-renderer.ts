// === Null Renderer (for CLI / headless) ===

import { CANONICAL_SPEC } from "@motebit/render-engine/spec";
import type {
  RenderAdapter,
  RenderFrame,
  InteriorColor,
  AudioReactivity,
} from "@motebit/render-engine/spec";
import type { RenderSpec } from "@motebit/sdk";

export class NullRenderer implements RenderAdapter {
  init(_target: unknown): Promise<void> {
    return Promise.resolve();
  }
  render(_frame: RenderFrame): void {}
  getSpec(): RenderSpec {
    return CANONICAL_SPEC;
  }
  resize(_w: number, _h: number): void {}
  setBackground(_color: number | null): void {}
  setDarkEnvironment(): void {}
  setLightEnvironment(): void {}
  setInteriorColor(_color: InteriorColor): void {}
  setAudioReactivity(_energy: AudioReactivity | null): void {}
  setTrustMode(_mode: import("@motebit/sdk").TrustMode): void {}
  setListeningIndicator(_active: boolean): void {}
  getCreatureGroup(): unknown {
    return null;
  }
  dispose(): void {}
}
