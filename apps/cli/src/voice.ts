// ---------------------------------------------------------------------------
// Voice — CLI-native TTS provider chain (ElevenLabs → OpenAI → system)
// ---------------------------------------------------------------------------
//
// Ring 1 parity with desktop/mobile/spatial: the CLI expresses the same TTS
// capability, but through a medium-native form. The Web Audio API and
// HTMLAudioElement the platform-agnostic providers in `@motebit/voice` rely
// on don't exist in Node, so this module implements CLI-native adapters that
// satisfy the same `TTSProvider` interface — REST call → write MP3 to a temp
// file → hand off to the OS audio player (`afplay` on macOS, `mpg123`/`ffplay`
// on Linux).
//
// The implementations here wrap the same ElevenLabs and OpenAI HTTP endpoints
// that the `@motebit/voice` platform-agnostic adapters hit. We re-export
// `ELEVENLABS_VOICES` and consume `FallbackTTSProvider` from the package, so
// the chaining semantics are identical — only the output sink differs.
//
// Opt-in only. `VoiceController.enabled` starts false; `/voice on`, `/voice
// off`, `/say <text>`, or `--voice` flip it. We never auto-speak — only on
// explicit opt-in AND only for task completions or explicit `/say`. This
// matches "calm software": the terminal already shows the text; voice is
// additive, never a substitute.

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ELEVENLABS_VOICES,
  FallbackTTSProvider,
  type ElevenLabsVoiceName,
  type TTSProvider,
  type TTSOptions,
} from "@motebit/voice";

import { dim, warn } from "./colors.js";

// ---------------------------------------------------------------------------
// ElevenLabs (CLI-native — writes MP3 to tmp and plays via system player)
// ---------------------------------------------------------------------------

export interface CliElevenLabsConfig {
  apiKey: string;
  voice?: string;
  model?: string;
  baseUrl?: string;
}

export class CliElevenLabsTTSProvider implements TTSProvider {
  private _speaking = false;
  private _currentChild: ReturnType<typeof spawn> | null = null;
  private _cancelled = false;
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(config: CliElevenLabsConfig) {
    this.apiKey = config.apiKey;
    const requested = config.voice ?? "Rachel";
    this.voiceId =
      requested in ELEVENLABS_VOICES
        ? ELEVENLABS_VOICES[requested as ElevenLabsVoiceName]
        : requested;
    this.model = config.model ?? "eleven_flash_v2_5";
    this.baseUrl = config.baseUrl ?? "https://api.elevenlabs.io";
  }

  get speaking(): boolean {
    return this._speaking;
  }

  async speak(text: string, _options?: TTSOptions): Promise<void> {
    this._cancelled = false;
    this._speaking = true;
    let tmpFile: string | null = null;
    try {
      const url = `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(this.voiceId)}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: this.model,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            use_speaker_boost: true,
          },
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`ElevenLabs TTS error: ${resp.status}${body ? ` — ${body}` : ""}`);
      }
      if (this._cancelled) return;
      const buf = Buffer.from(await resp.arrayBuffer());
      tmpFile = await writeTempMp3(buf);
      if (this._cancelled) return;
      await playMp3(tmpFile, (child) => {
        this._currentChild = child;
      });
    } finally {
      this._speaking = false;
      this._currentChild = null;
      if (tmpFile) await unlink(tmpFile).catch(() => {});
    }
  }

  cancel(): void {
    this._cancelled = true;
    if (this._currentChild) {
      try {
        this._currentChild.kill();
      } catch {
        // Already exited — ignore.
      }
      this._currentChild = null;
    }
    this._speaking = false;
  }
}

// ---------------------------------------------------------------------------
// OpenAI (CLI-native)
// ---------------------------------------------------------------------------

export interface CliOpenAiConfig {
  apiKey: string;
  voice?: string;
  model?: string;
  baseUrl?: string;
}

export class CliOpenAiTTSProvider implements TTSProvider {
  private _speaking = false;
  private _currentChild: ReturnType<typeof spawn> | null = null;
  private _cancelled = false;
  private readonly apiKey: string;
  private readonly voice: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(config: CliOpenAiConfig) {
    this.apiKey = config.apiKey;
    this.voice = config.voice ?? "alloy";
    this.model = config.model ?? "tts-1";
    this.baseUrl = config.baseUrl ?? "https://api.openai.com";
  }

  get speaking(): boolean {
    return this._speaking;
  }

  async speak(text: string, _options?: TTSOptions): Promise<void> {
    this._cancelled = false;
    this._speaking = true;
    let tmpFile: string | null = null;
    try {
      const url = `${this.baseUrl}/v1/audio/speech`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          voice: this.voice,
          input: text,
          response_format: "mp3",
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`OpenAI TTS error: ${resp.status}${body ? ` — ${body}` : ""}`);
      }
      if (this._cancelled) return;
      const buf = Buffer.from(await resp.arrayBuffer());
      tmpFile = await writeTempMp3(buf);
      if (this._cancelled) return;
      await playMp3(tmpFile, (child) => {
        this._currentChild = child;
      });
    } finally {
      this._speaking = false;
      this._currentChild = null;
      if (tmpFile) await unlink(tmpFile).catch(() => {});
    }
  }

  cancel(): void {
    this._cancelled = true;
    if (this._currentChild) {
      try {
        this._currentChild.kill();
      } catch {
        // Already exited — ignore.
      }
      this._currentChild = null;
    }
    this._speaking = false;
  }
}

// ---------------------------------------------------------------------------
// System fallback — `say` on macOS, `espeak` on Linux. No network required.
// No-op with a single warn on first use if the platform has no TTS.
// ---------------------------------------------------------------------------

export class SystemTTSProvider implements TTSProvider {
  private _speaking = false;
  private _currentChild: ReturnType<typeof spawn> | null = null;
  private _unsupportedWarned = false;

  get speaking(): boolean {
    return this._speaking;
  }

  async speak(text: string, _options?: TTSOptions): Promise<void> {
    this._speaking = true;
    try {
      const cmd = systemSpeakCommand();
      if (!cmd) {
        if (!this._unsupportedWarned) {
          this._unsupportedWarned = true;
          console.warn(
            warn(
              "[voice] no system TTS binary found (say / espeak). Install one or set an API key to enable voice.",
            ),
          );
        }
        return;
      }
      await runCommand(cmd.bin, [...cmd.args, text], (child) => {
        this._currentChild = child;
      });
    } finally {
      this._speaking = false;
      this._currentChild = null;
    }
  }

  cancel(): void {
    if (this._currentChild) {
      try {
        this._currentChild.kill();
      } catch {
        // Already exited — ignore.
      }
      this._currentChild = null;
    }
    this._speaking = false;
  }
}

// ---------------------------------------------------------------------------
// Playback helpers
// ---------------------------------------------------------------------------

async function writeTempMp3(buf: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "motebit-tts-"));
  const path = join(dir, "out.mp3");
  await writeFile(path, buf);
  return path;
}

function mp3PlayerCommand(path: string): { bin: string; args: string[] } | null {
  if (process.platform === "darwin") return { bin: "afplay", args: [path] };
  // Linux/BSD: try common MP3 players. Order favors ubiquity.
  // The caller will fail fast if none exist — the fallback chain then steps
  // down to system `say`/`espeak`, which doesn't route through MP3 at all.
  return { bin: "mpg123", args: ["-q", path] };
}

function systemSpeakCommand(): { bin: string; args: string[] } | null {
  if (process.platform === "darwin") return { bin: "say", args: [] };
  if (process.platform === "linux") return { bin: "espeak", args: [] };
  return null;
}

function playMp3(path: string, onSpawn: (child: ReturnType<typeof spawn>) => void): Promise<void> {
  const cmd = mp3PlayerCommand(path);
  if (!cmd) {
    return Promise.reject(new Error(`No MP3 player available on ${process.platform}`));
  }
  return runCommand(cmd.bin, cmd.args, onSpawn);
}

function runCommand(
  bin: string,
  args: string[],
  onSpawn: (child: ReturnType<typeof spawn>) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    onSpawn(child);
    child.on("error", (err) => {
      reject(err);
    });
    child.on("exit", (code, signal) => {
      if (signal != null) {
        // Killed by cancel() — resolve; the caller sees the cancellation.
        resolve();
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`${bin} exited with code ${code ?? "unknown"}`));
    });
  });
}

// ---------------------------------------------------------------------------
// VoiceController — opt-in state + provider chain owner
// ---------------------------------------------------------------------------

export interface VoiceControllerOptions {
  /** Start enabled. Default false. */
  enabled?: boolean;
  /** Override API keys for testing; production reads from env. */
  elevenLabsApiKey?: string;
  openaiApiKey?: string;
  /** Override provider for testing — skips env/key detection. */
  provider?: TTSProvider;
}

/**
 * The CLI-side voice manager. Owns the enabled flag and the provider chain.
 * Does NOT auto-speak — callers decide when to invoke `speakIfEnabled`.
 */
export class VoiceController {
  private _enabled: boolean;
  private _provider: TTSProvider;

  constructor(opts: VoiceControllerOptions = {}) {
    this._enabled = opts.enabled ?? false;
    this._provider = opts.provider ?? buildProviderChain(opts);
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get speaking(): boolean {
    return this._provider.speaking;
  }

  enable(): void {
    this._enabled = true;
  }

  disable(): void {
    this._enabled = false;
    this.cancel();
  }

  /**
   * Speak the given text only when `enabled`. Best-effort — swallows errors
   * with a dim warning so voice never blocks the REPL. Returns a `spoke`
   * flag callers can use to decide on user-visible feedback.
   */
  async speakIfEnabled(text: string): Promise<{ spoke: boolean; error?: string }> {
    if (!this._enabled) return { spoke: false };
    return this.speak(text);
  }

  /**
   * Always speak — used by the explicit `/say <text>` affordance. Still
   * best-effort on error so a bad key doesn't crash the REPL.
   */
  async speak(text: string): Promise<{ spoke: boolean; error?: string }> {
    if (!text.trim()) return { spoke: false };
    try {
      await this._provider.speak(text);
      return { spoke: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(dim(`[voice] ${message}`));
      const ret: { spoke: boolean; error?: string } = { spoke: false };
      ret.error = message;
      return ret;
    }
  }

  cancel(): void {
    this._provider.cancel();
  }
}

function buildProviderChain(opts: VoiceControllerOptions): TTSProvider {
  const providers: TTSProvider[] = [];
  const elevenKey = opts.elevenLabsApiKey ?? process.env["ELEVENLABS_API_KEY"];
  const openaiKey = opts.openaiApiKey ?? process.env["OPENAI_API_KEY"];

  if (elevenKey) {
    providers.push(new CliElevenLabsTTSProvider({ apiKey: elevenKey }));
  }
  if (openaiKey) {
    providers.push(new CliOpenAiTTSProvider({ apiKey: openaiKey }));
  }
  providers.push(new SystemTTSProvider());

  return providers.length === 1 ? providers[0]! : new FallbackTTSProvider(providers);
}
