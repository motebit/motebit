Pod::Spec.new do |s|
  s.name           = 'ExpoPlayIntegrity'
  s.version        = '1.0.0'
  s.summary        = 'Stub for Google Play Integrity (Android-only) on iOS.'
  s.description    = 'Stub module so ExpoPlayIntegrity loads on iOS without crashing. Every command rejects with not_supported — Play Integrity is Android-only; iOS mint path lives in ExpoAppAttest.'
  s.author         = ''
  s.homepage       = 'https://motebit.com'
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
