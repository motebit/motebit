Pod::Spec.new do |s|
  s.name           = 'ExpoLocalInference'
  s.version        = '1.0.0'
  s.summary        = 'A sample project summary'
  s.description    = 'A sample project description'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
  # Package.swift is the SPM manifest for the MLX-swift integration —
  # it imports PackageDescription, which is only resolvable during SPM's
  # manifest parse, not during CocoaPods' iOS target compile. The glob
  # above catches it alongside the real sources; exclude it so the pod
  # builds cleanly. MLX stays loaded via SPM at the Xcode-project level
  # and is runtime-guarded via #canImport in ExpoLocalInferenceModule.swift.
  s.exclude_files = "Package.swift"
end
