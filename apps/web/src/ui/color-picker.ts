import { COLOR_PRESETS, type InteriorColor } from "../web-app";
import type { WebContext } from "../types";

// === Pure Color Math ===

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else              { r = c; b = x; }
  return [r + m, g + m, b + m];
}

export function deriveInteriorColor(hue: number, saturation: number): InteriorColor {
  const tintL = 0.92 - saturation * 0.12;
  const tintS = saturation * 0.9;
  const tint = hslToRgb(hue, tintS, tintL);

  const glowL = 0.72 - saturation * 0.17;
  const glowS = saturation * 0.8 + 0.2;
  const glow = hslToRgb(hue, glowS, glowL);

  return { tint, glow };
}

export function swatchGradient(color: InteriorColor): string {
  const t = color.tint;
  const g = color.glow;
  return `radial-gradient(circle at 40% 40%, rgba(${Math.round(g[0] * 255)},${Math.round(g[1] * 255)},${Math.round(g[2] * 255)},0.6), rgba(${Math.round(t[0] * 200)},${Math.round(t[1] * 200)},${Math.round(t[2] * 200)},0.8))`;
}

// === Color Picker State ===

let selectedColorPreset = "moonlight";
let previousColorPreset = "moonlight";
let customHue = 220;
let customSaturation = 0.7;
let customInteriorColor: InteriorColor | null = null;
let previousCustomState: { hue: number; saturation: number; color: InteriorColor | null } | null = null;

// === DOM Refs ===

const colorPresetGrid = document.getElementById("color-preset-grid") as HTMLDivElement;
const customPicker = document.getElementById("custom-picker") as HTMLDivElement;
const hueStrip = document.getElementById("hue-strip") as HTMLDivElement;
const satStrip = document.getElementById("sat-strip") as HTMLDivElement;
const hueThumb = document.getElementById("hue-thumb") as HTMLDivElement;
const satThumb = document.getElementById("sat-thumb") as HTMLDivElement;
const pickerPreview = document.getElementById("picker-preview") as HTMLDivElement;

// === Color Picker API ===

export interface ColorPickerAPI {
  getActiveColor(): InteriorColor | null;
  getSelectedPreset(): string;
  setSelectedPreset(name: string): void;
  getCustomHue(): number;
  setCustomHue(h: number): void;
  getCustomSaturation(): number;
  setCustomSaturation(s: number): void;
  getCustomInteriorColor(): InteriorColor | null;
  setCustomInteriorColor(c: InteriorColor | null): void;
  buildColorSwatches(): void;
  savePreviousState(): void;
  restorePreviousState(): void;
}

export function initColorPicker(ctx: WebContext, onColorChanged: () => void): ColorPickerAPI {
  function updatePickerUI(): void {
    hueThumb.style.left = `${(customHue / 360) * 100}%`;
    hueThumb.style.background = `hsl(${customHue}, 85%, 60%)`;
    satThumb.style.left = `${customSaturation * 100}%`;
    satThumb.style.background = `hsl(${customHue}, ${Math.round(customSaturation * 100)}%, 70%)`;
    satStrip.style.background = `linear-gradient(to right, hsl(${customHue},0%,90%), hsl(${customHue},100%,60%))`;
    const color = deriveInteriorColor(customHue, customSaturation);
    pickerPreview.style.background = swatchGradient(color);
  }

  function applyCustomColor(): void {
    customInteriorColor = deriveInteriorColor(customHue, customSaturation);
    ctx.app.setInteriorColorDirect(customInteriorColor);
    onColorChanged();
    const customSwatch = document.querySelector('.color-swatch.custom');
    if (customSwatch != null && customInteriorColor != null) {
      (customSwatch as HTMLElement).style.background = swatchGradient(customInteriorColor);
    }
  }

  function initPickerDrag(strip: HTMLElement, onUpdate: (fraction: number) => void): void {
    const drag = (e: PointerEvent) => {
      const rect = strip.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      onUpdate(fraction);
      updatePickerUI();
      applyCustomColor();
    };
    strip.addEventListener("pointerdown", (e: PointerEvent) => {
      strip.setPointerCapture(e.pointerId);
      drag(e);
      const move = (ev: PointerEvent) => drag(ev);
      const up = () => {
        strip.removeEventListener("pointermove", move);
        strip.removeEventListener("pointerup", up);
      };
      strip.addEventListener("pointermove", move);
      strip.addEventListener("pointerup", up);
    });
  }

  initPickerDrag(hueStrip, (f) => { customHue = Math.round(f * 360); });
  initPickerDrag(satStrip, (f) => { customSaturation = f; });

  function selectColorPreset(name: string): void {
    selectedColorPreset = name;
    document.querySelectorAll(".color-swatch").forEach(el => {
      el.classList.toggle("selected", (el as HTMLElement).dataset.preset === name);
    });
    if (name === "custom") {
      customPicker.classList.add("open");
      if (!customInteriorColor) {
        customInteriorColor = deriveInteriorColor(customHue, customSaturation);
      }
      ctx.app.setInteriorColorDirect(customInteriorColor);
      updatePickerUI();
    } else {
      customPicker.classList.remove("open");
      ctx.app.setInteriorColor(name);
    }
    onColorChanged();
  }

  function buildColorSwatches(): void {
    colorPresetGrid.innerHTML = "";
    for (const [name, preset] of Object.entries(COLOR_PRESETS)) {
      const btn = document.createElement("button");
      btn.className = "color-swatch" + (name === selectedColorPreset ? " selected" : "");
      btn.dataset.preset = name;
      btn.style.background = swatchGradient(preset);
      const label = document.createElement("span");
      label.className = "swatch-name";
      label.textContent = name.charAt(0).toUpperCase() + name.slice(1);
      btn.appendChild(label);
      btn.addEventListener("click", () => selectColorPreset(name));
      colorPresetGrid.appendChild(btn);
    }
    const customBtn = document.createElement("button");
    customBtn.className = "color-swatch custom" + (selectedColorPreset === "custom" ? " selected" : "");
    customBtn.dataset.preset = "custom";
    if (customInteriorColor) {
      customBtn.style.background = swatchGradient(customInteriorColor);
    }
    const customLabel = document.createElement("span");
    customLabel.className = "swatch-name";
    customLabel.textContent = "Custom";
    customBtn.appendChild(customLabel);
    customBtn.addEventListener("click", () => selectColorPreset("custom"));
    colorPresetGrid.appendChild(customBtn);
    customPicker.classList.toggle("open", selectedColorPreset === "custom");
    if (selectedColorPreset === "custom") {
      updatePickerUI();
    }
  }

  return {
    getActiveColor() {
      return selectedColorPreset === "custom" ? customInteriorColor : (COLOR_PRESETS[selectedColorPreset] ?? null);
    },
    getSelectedPreset() { return selectedColorPreset; },
    setSelectedPreset(name: string) { selectedColorPreset = name; },
    getCustomHue() { return customHue; },
    setCustomHue(h: number) { customHue = h; },
    getCustomSaturation() { return customSaturation; },
    setCustomSaturation(s: number) { customSaturation = s; },
    getCustomInteriorColor() { return customInteriorColor; },
    setCustomInteriorColor(c: InteriorColor | null) { customInteriorColor = c; },
    buildColorSwatches,
    savePreviousState() {
      previousColorPreset = selectedColorPreset;
      previousCustomState = { hue: customHue, saturation: customSaturation, color: customInteriorColor ? { ...customInteriorColor } : null };
    },
    restorePreviousState() {
      if (selectedColorPreset !== previousColorPreset || selectedColorPreset === "custom") {
        selectedColorPreset = previousColorPreset;
        if (previousCustomState) {
          customHue = previousCustomState.hue;
          customSaturation = previousCustomState.saturation;
          customInteriorColor = previousCustomState.color;
        }
        if (selectedColorPreset === "custom" && customInteriorColor) {
          ctx.app.setInteriorColorDirect(customInteriorColor);
        } else {
          ctx.app.setInteriorColor(previousColorPreset);
        }
        onColorChanged();
      }
    },
  };
}
