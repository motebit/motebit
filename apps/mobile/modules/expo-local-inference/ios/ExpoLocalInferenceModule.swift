import ExpoModulesCore
import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

#if canImport(MLXLMCommon)
import MLXLLM
import MLXLMCommon
#endif

/// On-device inference module exposing two backends:
/// 1. Apple Foundation Models (iOS 26+) — zero-config, Apple's built-in ~3B model
/// 2. MLX (iOS 16+) — any open model via mlx-swift-lm
///
/// Token streaming uses Expo events: onToken, onComplete, onError.
/// Uses #canImport so the module compiles whether or not the optional
/// frameworks are linked — availability is resolved at runtime.
public class ExpoLocalInferenceModule: Module {
  private var isGenerating = false

  #if canImport(MLXLMCommon)
  private var mlxContainer: ModelContainer? = nil
  #endif

  public func definition() -> ModuleDefinition {
    Name("ExpoLocalInference")

    Events("onToken", "onComplete", "onError")

    // MARK: - Capability Detection

    Function("getCapabilities") { () -> [String: Any] in
      let totalMemory = ProcessInfo.processInfo.physicalMemory
      let totalMemoryGB = Int(totalMemory / (1024 * 1024 * 1024))

      return [
        "appleFM": self.isAppleFMAvailable(),
        "mlx": self.isMLXAvailable(),
        "deviceMemoryGB": totalMemoryGB,
        "platform": "ios",
      ]
    }

    Function("fmIsAvailable") { () -> Bool in
      return self.isAppleFMAvailable()
    }

    Function("mlxIsAvailable") { () -> Bool in
      return self.isMLXAvailable()
    }

    // MARK: - Apple Foundation Models (iOS 26+)

    AsyncFunction("fmGenerate") { (prompt: String, systemPrompt: String, maxTokens: Int) in
      guard self.isAppleFMAvailable() else {
        self.sendEvent("onError", ["message": "Apple Foundation Models not available"])
        return
      }
      self.isGenerating = true

      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        await self.runFMGeneration(prompt: prompt, systemPrompt: systemPrompt, maxTokens: maxTokens)
        return
      }
      #endif
      self.sendEvent("onError", ["message": "FoundationModels not available in this build"])
      self.isGenerating = false
    }

    // MARK: - MLX

    AsyncFunction("mlxLoadModel") { (path: String) in
      guard self.isMLXAvailable() else {
        throw NSError(domain: "ExpoLocalInference", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "MLX not available"])
      }
      #if canImport(MLXLMCommon)
      try await self.loadMLXModel(path: path)
      #else
      throw NSError(domain: "ExpoLocalInference", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "mlx-swift-lm not linked"])
      #endif
    }

    AsyncFunction("mlxGenerate") { (prompt: String, systemPrompt: String, maxTokens: Int, temperature: Double) in
      guard self.isMLXAvailable() else {
        self.sendEvent("onError", ["message": "MLX not available"])
        return
      }
      self.isGenerating = true

      #if canImport(MLXLMCommon)
      await self.runMLXGeneration(prompt: prompt, systemPrompt: systemPrompt, maxTokens: maxTokens, temperature: temperature)
      #else
      self.sendEvent("onError", ["message": "mlx-swift-lm not linked"])
      self.isGenerating = false
      #endif
    }

    AsyncFunction("mlxUnloadModel") {
      #if canImport(MLXLMCommon)
      self.mlxContainer = nil
      #endif
    }

    // MARK: - Shared

    Function("stopGeneration") {
      self.isGenerating = false
    }
  }

  // MARK: - Availability

  private func isAppleFMAvailable() -> Bool {
    #if canImport(FoundationModels)
    if #available(iOS 26.0, *) { return true }
    #endif
    return false
  }

  private func isMLXAvailable() -> Bool {
    #if canImport(MLXLMCommon)
    let totalMemory = ProcessInfo.processInfo.physicalMemory
    return totalMemory / (1024 * 1024 * 1024) >= 3
    #else
    return false
    #endif
  }

  // MARK: - Apple Foundation Models

  #if canImport(FoundationModels)
  @available(iOS 26.0, *)
  private func runFMGeneration(prompt: String, systemPrompt: String, maxTokens: Int) async {
    do {
      let session = LanguageModelSession(instructions: systemPrompt)
      var fullText = ""
      var tokenCount = 0

      let stream = session.streamResponse(to: prompt)
      for try await partial in stream {
        guard self.isGenerating else { break }
        let content = partial.content
        if content.count > fullText.count {
          let newText = String(content.suffix(content.count - fullText.count))
          fullText = content
          tokenCount += 1
          self.sendEvent("onToken", ["text": newText])
        }
      }

      self.sendEvent("onComplete", [
        "fullText": fullText,
        "tokensGenerated": tokenCount,
        "backend": "apple-fm",
      ])
    } catch {
      self.sendEvent("onError", ["message": error.localizedDescription])
    }
    self.isGenerating = false
  }
  #endif

  // MARK: - MLX

  #if canImport(MLXLMCommon)
  private func loadMLXModel(path: String) async throws {
    let modelURL = URL(filePath: path)
    let container = try await LLMModelFactory.shared.loadContainer(
      configuration: ModelConfiguration(directory: modelURL)
    )
    self.mlxContainer = container
  }

  private func runMLXGeneration(prompt: String, systemPrompt: String, maxTokens: Int, temperature: Double) async {
    guard let container = self.mlxContainer else {
      self.sendEvent("onError", ["message": "No MLX model loaded. Call mlxLoadModel first."])
      self.isGenerating = false
      return
    }

    do {
      var fullText = ""
      var tokenCount = 0

      try await container.perform { context in
        let input = try await context.processor.prepare(
          input: .init(
            messages: [
              ["role": "system", "content": systemPrompt],
              ["role": "user", "content": prompt],
            ]
          )
        )

        try MLXLMCommon.generate(
          input: input,
          parameters: .init(temperature: Float(temperature)),
          context: context
        ) { tokens in
          guard self.isGenerating else { return .stop }

          if let last = tokens.last {
            let text = context.tokenizer.decode(tokens: [last])
            fullText += text
            tokenCount += 1
            self.sendEvent("onToken", ["text": text])
          }

          return tokenCount >= maxTokens ? .stop : .more
        }
      }

      self.sendEvent("onComplete", [
        "fullText": fullText,
        "tokensGenerated": tokenCount,
        "backend": "mlx",
      ])
    } catch {
      self.sendEvent("onError", ["message": error.localizedDescription])
    }
    self.isGenerating = false
  }
  #endif
}
