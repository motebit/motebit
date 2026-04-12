import { describe, it, expect, vi } from "vitest";
import {
  initRenderer,
  resizeRenderer,
  renderFrame,
  setInteriorColor,
  setInteriorColorDirect,
  setDarkEnvironment,
  setLightEnvironment,
  setAudioReactivity,
} from "../renderer-commands";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRenderer(): any {
  return {
    init: vi.fn(async (_c: unknown) => {}),
    setLightEnvironment: vi.fn(),
    enableOrbitControls: vi.fn(),
    resize: vi.fn(),
    render: vi.fn(),
    setInteriorColor: vi.fn(),
    setDarkEnvironment: vi.fn(),
    setAudioReactivity: vi.fn(),
  };
}

describe("renderer-commands.initRenderer", () => {
  it("initializes renderer, sets lights, enables controls", async () => {
    const r = makeRenderer();
    await initRenderer(r, null);
    expect(r.init).toHaveBeenCalledWith(null);
    expect(r.setLightEnvironment).toHaveBeenCalled();
    expect(r.enableOrbitControls).toHaveBeenCalled();
  });
});

describe("renderer-commands.resizeRenderer", () => {
  it("forwards dimensions", () => {
    const r = makeRenderer();
    resizeRenderer(r, 800, 600);
    expect(r.resize).toHaveBeenCalledWith(800, 600);
  });
});

describe("renderer-commands.renderFrame", () => {
  it("delegates to runtime.renderFrame when runtime is present", () => {
    const r = makeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runtime: any = { renderFrame: vi.fn() };
    renderFrame(r, runtime, 0.016, 1000);
    expect(runtime.renderFrame).toHaveBeenCalledWith(0.016, 1000);
    expect(r.render).not.toHaveBeenCalled();
  });

  it("renders default cues when runtime is null", () => {
    const r = makeRenderer();
    renderFrame(r, null, 0.016, 1000);
    expect(r.render).toHaveBeenCalledOnce();
    const call = r.render.mock.calls[0][0];
    expect(call.cues).toBeDefined();
    expect(call.cues.hover_distance).toBe(0.4);
    expect(call.delta_time).toBe(0.016);
    expect(call.time).toBe(1000);
  });
});

describe("renderer-commands.setInteriorColor", () => {
  it("applies a known preset", () => {
    const r = makeRenderer();
    // moonlight exists in COLOR_PRESETS
    setInteriorColor(r, "moonlight");
    expect(r.setInteriorColor).toHaveBeenCalled();
  });

  it("no-ops on unknown preset", () => {
    const r = makeRenderer();
    setInteriorColor(r, "nonexistent-preset");
    expect(r.setInteriorColor).not.toHaveBeenCalled();
  });
});

describe("renderer-commands.setInteriorColorDirect", () => {
  it("forwards color to renderer", () => {
    const r = makeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const color: any = { r: 0.5, g: 0.5, b: 0.5 };
    setInteriorColorDirect(r, color);
    expect(r.setInteriorColor).toHaveBeenCalledWith(color);
  });
});

describe("renderer-commands environment toggles", () => {
  it("setDarkEnvironment forwards", () => {
    const r = makeRenderer();
    setDarkEnvironment(r);
    expect(r.setDarkEnvironment).toHaveBeenCalled();
  });

  it("setLightEnvironment forwards", () => {
    const r = makeRenderer();
    setLightEnvironment(r);
    expect(r.setLightEnvironment).toHaveBeenCalled();
  });
});

describe("renderer-commands.setAudioReactivity", () => {
  it("forwards energy", () => {
    const r = makeRenderer();
    const energy = { rms: 0.1, low: 0.2, mid: 0.3, high: 0.4 };
    setAudioReactivity(r, energy);
    expect(r.setAudioReactivity).toHaveBeenCalledWith(energy);
  });

  it("forwards null to clear", () => {
    const r = makeRenderer();
    setAudioReactivity(r, null);
    expect(r.setAudioReactivity).toHaveBeenCalledWith(null);
  });
});
