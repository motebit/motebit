Pod::Spec.new do |s|
  s.name           = 'ExpoAppAttest'
  s.version        = '1.0.0'
  s.summary        = 'Apple App Attest hardware-attestation bridge for motebit.'
  s.description    = 'Generates an App Attest key via DCAppAttestService and returns the CBOR attestation object that @motebit/crypto-appattest chain-verifies.'
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

  # DeviceCheck.framework provides DCAppAttestService.
  s.frameworks = 'DeviceCheck', 'CryptoKit'

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
