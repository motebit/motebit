import { requireNativeModule } from "expo";

import type { ExpoLocalInferenceModuleType } from "./ExpoLocalInference.types";

// This call loads the native module object from the JSI.
export default requireNativeModule<ExpoLocalInferenceModuleType>("ExpoLocalInference");
