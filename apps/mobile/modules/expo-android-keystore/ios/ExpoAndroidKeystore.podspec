Pod::Spec.new do |s|
  s.name           = 'ExpoAndroidKeystore'
  s.version        = '1.0.0'
  s.summary        = 'Stub for Android Hardware-Backed Keystore Attestation (Android-only) on iOS.'
  s.description    = 'Stub module so ExpoAndroidKeystore loads on iOS without crashing. Every command rejects with not_supported — Android Keystore Attestation is Android-only; iOS mint path lives in ExpoAppAttest.'
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
