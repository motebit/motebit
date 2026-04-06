import type { NativeModule } from "expo";

export interface DeviceCapabilities {
  appleFM: boolean;
  mlx: boolean;
  deviceMemoryGB: number;
  platform: "ios" | "android";
}

export interface TokenEvent {
  text: string;
}

export interface CompleteEvent {
  fullText: string;
  tokensGenerated: number;
  backend: "apple-fm" | "mlx";
}

export interface ErrorEvent {
  message: string;
}

export type ExpoLocalInferenceModuleEvents = {
  onToken: (event: TokenEvent) => void;
  onComplete: (event: CompleteEvent) => void;
  onError: (event: ErrorEvent) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- required by Expo EventsMap constraint
  [key: string]: (event: any) => void;
};

export declare class ExpoLocalInferenceModuleType extends NativeModule<ExpoLocalInferenceModuleEvents> {
  getCapabilities(): DeviceCapabilities;
  fmIsAvailable(): boolean;
  mlxIsAvailable(): boolean;
  fmGenerate(prompt: string, systemPrompt: string, maxTokens: number): Promise<void>;
  mlxLoadModel(path: string): Promise<void>;
  mlxGenerate(
    prompt: string,
    systemPrompt: string,
    maxTokens: number,
    temperature: number,
  ): Promise<void>;
  mlxUnloadModel(): Promise<void>;
  stopGeneration(): void;
}
