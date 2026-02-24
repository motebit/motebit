import type { ChatAPI } from "./chat";

// === Web Speech API Types ===

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

declare const webkitSpeechRecognition: { new(): SpeechRecognition } | undefined;

// === DOM Refs ===

const micBtn = document.getElementById("mic-btn") as HTMLButtonElement | null;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const inputBarWrapper = document.getElementById("input-bar-wrapper") as HTMLDivElement | null;
const voiceTranscript = document.getElementById("voice-transcript") as HTMLDivElement | null;

// === Voice Init ===

export function initVoice(chatAPI: ChatAPI): void {
  if (!micBtn || !inputBarWrapper) return;

  // Check for Web Speech API support
  const SpeechRecognitionCtor =
    (typeof window !== "undefined" && "SpeechRecognition" in window)
      ? (window as unknown as Record<string, { new(): SpeechRecognition }>)["SpeechRecognition"]
      : (typeof webkitSpeechRecognition !== "undefined" ? webkitSpeechRecognition : null);

  if (!SpeechRecognitionCtor) {
    // No speech recognition support — hide mic button
    micBtn.style.display = "none";
    return;
  }

  // Show mic button and flag wrapper for layout adjustment
  micBtn.style.display = "flex";
  inputBarWrapper.classList.add("has-mic");

  let recognition: SpeechRecognition | null = null;
  let isListening = false;

  function startListening(): void {
    if (isListening) return;

    recognition = new SpeechRecognitionCtor!();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onstart = () => {
      isListening = true;
      micBtn!.classList.add("active");
      inputBarWrapper!.classList.add("listening");
      if (voiceTranscript) {
        voiceTranscript.innerHTML = '<span class="recording-dot"></span>Listening...';
        voiceTranscript.classList.remove("has-text");
      }
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let final = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!;
        if (result.isFinal) {
          final += result[0]!.transcript;
        } else {
          interim += result[0]!.transcript;
        }
      }

      // Show interim transcript
      if (voiceTranscript) {
        const text = final || interim;
        if (text) {
          voiceTranscript.textContent = text;
          voiceTranscript.classList.add("has-text");
        }
      }

      // When we get a final result, fill the input
      if (final) {
        chatInput.value = final.trim();
        stopListening();
        // Auto-send after voice input
        void chatAPI.handleSend();
      }
    };

    recognition.onerror = () => {
      stopListening();
    };

    recognition.onend = () => {
      stopListening();
    };

    recognition.start();
  }

  function stopListening(): void {
    if (!isListening) return;
    isListening = false;
    micBtn!.classList.remove("active");
    inputBarWrapper!.classList.remove("listening");
    if (voiceTranscript) {
      voiceTranscript.textContent = "";
      voiceTranscript.classList.remove("has-text");
    }
    if (recognition) {
      try { recognition.abort(); } catch { /* ignore */ }
      recognition = null;
    }
  }

  micBtn.addEventListener("click", () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  });
}
