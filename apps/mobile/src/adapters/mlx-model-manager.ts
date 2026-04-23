/**
 * MLX model download manager — downloads and manages quantized models
 * from Hugging Face mlx-community for on-device inference.
 *
 * Apple Foundation Models need no download manager — baked into iOS.
 * This is MLX-only.
 */
import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";

export const DEFAULT_MLX_MODEL = "mlx-community/Llama-3.2-1B-Instruct-4bit";

const STORAGE_KEY = "@motebit/mlx_models";
const MODELS_DIR = `${FileSystem.documentDirectory}mlx-models/`;
const HF_BASE_URL = "https://huggingface.co";

export interface ModelState {
  status: "downloading" | "ready" | "error";
  progress: number;
  sizeBytes: number;
  path: string;
  modelId: string;
}

/** Required files for an MLX model to function. */
const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "model.safetensors"];

async function loadModelStates(): Promise<Record<string, ModelState>> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, ModelState>;
}

async function saveModelStates(states: Record<string, ModelState>): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(states));
}

export async function getDownloadedModels(): Promise<ModelState[]> {
  const states = await loadModelStates();
  return Object.values(states).filter((s) => s.status === "ready");
}

export async function getModelPath(modelId: string): Promise<string | null> {
  const states = await loadModelStates();
  const state = states[modelId];
  if (state?.status !== "ready") return null;
  return state.path;
}

export async function downloadModel(
  modelId: string = DEFAULT_MLX_MODEL,
  onProgress?: (progress: number) => void,
): Promise<string> {
  const modelDir = `${MODELS_DIR}${modelId.replace("/", "--")}/`;
  await FileSystem.makeDirectoryAsync(modelDir, { intermediates: true });

  const states = await loadModelStates();
  states[modelId] = { status: "downloading", progress: 0, sizeBytes: 0, path: modelDir, modelId };
  await saveModelStates(states);

  let totalDownloaded = 0;

  for (let i = 0; i < MODEL_FILES.length; i++) {
    const file = MODEL_FILES[i];
    const url = `${HF_BASE_URL}/${modelId}/resolve/main/${file}`;
    const dest = `${modelDir}${file}`;

    const downloadResumable = FileSystem.createDownloadResumable(url, dest, {}, (dlProgress) => {
      const fileProgress = dlProgress.totalBytesWritten / dlProgress.totalBytesExpectedToWrite;
      const overallProgress = (i + fileProgress) / MODEL_FILES.length;
      totalDownloaded = dlProgress.totalBytesWritten;
      onProgress?.(overallProgress);
    });

    const result = await downloadResumable.downloadAsync();
    if (!result) {
      states[modelId] = { ...states[modelId], status: "error", progress: 0 };
      await saveModelStates(states);
      throw new Error(`Failed to download ${file}`);
    }
  }

  states[modelId] = {
    status: "ready",
    progress: 1,
    sizeBytes: totalDownloaded,
    path: modelDir,
    modelId,
  };
  await saveModelStates(states);

  return modelDir;
}

export async function deleteModel(modelId: string): Promise<void> {
  const states = await loadModelStates();
  const state = states[modelId];
  if (state?.path) {
    await FileSystem.deleteAsync(state.path, { idempotent: true });
  }
  delete states[modelId];
  await saveModelStates(states);
}
