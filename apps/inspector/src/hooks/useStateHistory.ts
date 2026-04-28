import { useRef, useCallback } from "react";
import type { MotebitState } from "@motebit/sdk";

export interface StateSnapshot {
  timestamp: number;
  attention: number;
  processing: number;
  confidence: number;
  affect_valence: number;
  affect_arousal: number;
  social_distance: number;
  curiosity: number;
}

const MAX_HISTORY = 150; // 5 minutes at 2s polling

export function useStateHistory() {
  const historyRef = useRef<StateSnapshot[]>([]);

  const push = useCallback((state: MotebitState) => {
    const snapshot: StateSnapshot = {
      timestamp: Date.now(),
      attention: state.attention,
      processing: state.processing,
      confidence: state.confidence,
      affect_valence: state.affect_valence,
      affect_arousal: state.affect_arousal,
      social_distance: state.social_distance,
      curiosity: state.curiosity,
    };

    const buf = historyRef.current;
    buf.push(snapshot);
    if (buf.length > MAX_HISTORY) {
      buf.shift();
    }
  }, []);

  return { historyRef, push };
}
