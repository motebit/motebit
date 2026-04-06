package expo.modules.localinference

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android stub — on-device MLX/Apple FM inference is iOS-only.
 * All availability checks return false. Generate calls emit onError.
 */
class ExpoLocalInferenceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoLocalInference")

    Events("onToken", "onComplete", "onError")

    Function("getCapabilities") {
      mapOf(
        "appleFM" to false,
        "mlx" to false,
        "deviceMemoryGB" to (Runtime.getRuntime().maxMemory() / (1024 * 1024 * 1024)).toInt(),
        "platform" to "android"
      )
    }

    Function("fmIsAvailable") { false }
    Function("mlxIsAvailable") { false }

    AsyncFunction("fmGenerate") { _: String, _: String, _: Int ->
      sendEvent("onError", mapOf("message" to "Apple Foundation Models not available on Android"))
    }

    AsyncFunction("mlxLoadModel") { _: String -> }
    AsyncFunction("mlxGenerate") { _: String, _: String, _: Int, _: Double ->
      sendEvent("onError", mapOf("message" to "MLX not available on Android"))
    }
    AsyncFunction("mlxUnloadModel") { }

    Function("stopGeneration") { }
  }
}
