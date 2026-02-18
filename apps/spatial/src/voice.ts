/**
 * Ambient voice interface — Web Speech API.
 *
 * No chat UI in spatial. The interaction is ambient: the user speaks,
 * the creature listens, processes, and responds through voice and body language.
 *
 * SpeechRecognition for continuous listening.
 * SpeechSynthesis for spoken responses.
 * State tags are stripped before speaking — the creature's body language
 * conveys what the tags encode.
 */

import { stripTags } from "@motebit/ai-core";

// === Web Speech API type declarations ===
// These aren't in all TS lib versions. Declare what we need.

interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  readonly isFinal: boolean;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionErrorEvent {
  error: string;
  message: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export class VoiceInterface {
  private recognition: SpeechRecognitionInstance | null = null;
  private synthesis: SpeechSynthesis | null = null;
  private _isListening = false;
  private _isSpeaking = false;
  private shouldRestart = false;

  /** Called when a final transcript is recognized. */
  onTranscript: ((text: string) => void) | null = null;

  /** Called when listening state changes. */
  onListeningChange: ((listening: boolean) => void) | null = null;

  /** Called when speaking state changes. */
  onSpeakingChange: ((speaking: boolean) => void) | null = null;

  get isListening(): boolean {
    return this._isListening;
  }

  get isSpeaking(): boolean {
    return this._isSpeaking;
  }

  /** Check if Web Speech API is available. */
  static isSupported(): boolean {
    return !!(
      (typeof window !== "undefined") &&
      (window.SpeechRecognition || window.webkitSpeechRecognition) &&
      window.speechSynthesis
    );
  }

  /** Start continuous voice recognition. */
  start(): boolean {
    if (this._isListening) return true;

    const SpeechRecognitionCtor =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) return false;

    this.synthesis = window.speechSynthesis;

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      // Process only new final results
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i] as SpeechRecognitionResult | undefined;
        if (result?.isFinal) {
          const alt = result[0] as SpeechRecognitionAlternative | undefined;
          const transcript = alt?.transcript.trim();
          if (transcript && this.onTranscript) {
            this.onTranscript(transcript);
          }
        }
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // "no-speech" and "aborted" are expected — not errors
      if (event.error === "no-speech" || event.error === "aborted") return;
      console.warn("[voice] recognition error:", event.error);
    };

    recognition.onend = () => {
      // Continuous mode: restart if we haven't explicitly stopped
      if (this.shouldRestart && this._isListening) {
        try {
          recognition.start();
        } catch {
          // Already started or disposed — ignore
        }
      }
    };

    this.recognition = recognition;
    this.shouldRestart = true;

    try {
      recognition.start();
      this._isListening = true;
      this.onListeningChange?.(true);
      return true;
    } catch {
      return false;
    }
  }

  /** Stop voice recognition. */
  stop(): void {
    this.shouldRestart = false;
    this._isListening = false;
    this.onListeningChange?.(false);

    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // Already stopped
      }
      this.recognition = null;
    }
  }

  /**
   * Speak text aloud. Strips state/action/memory tags first —
   * the creature's body language conveys what the tags encode.
   */
  speak(text: string): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.synthesis) {
        resolve();
        return;
      }

      // Strip all motebit tags — only speak the display text
      const clean = stripTags(text);
      if (!clean.trim()) {
        resolve();
        return;
      }

      // Cancel any ongoing speech
      this.synthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 0.9;

      utterance.onstart = () => {
        this._isSpeaking = true;
        this.onSpeakingChange?.(true);
      };

      utterance.onend = () => {
        this._isSpeaking = false;
        this.onSpeakingChange?.(false);
        resolve();
      };

      utterance.onerror = () => {
        this._isSpeaking = false;
        this.onSpeakingChange?.(false);
        resolve();
      };

      this.synthesis.speak(utterance);
    });
  }

  /** Cancel any ongoing speech. */
  cancelSpeech(): void {
    if (this.synthesis) {
      this.synthesis.cancel();
      this._isSpeaking = false;
      this.onSpeakingChange?.(false);
    }
  }

  /** Clean up all resources. */
  dispose(): void {
    this.stop();
    this.cancelSpeech();
    this.onTranscript = null;
    this.onListeningChange = null;
    this.onSpeakingChange = null;
  }
}
