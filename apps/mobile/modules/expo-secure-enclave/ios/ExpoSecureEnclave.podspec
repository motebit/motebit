Pod::Spec.new do |s|
  s.name           = 'ExpoSecureEnclave'
  s.version        = '1.0.0'
  s.summary        = 'Apple Secure Enclave hardware-attestation bridge for motebit.'
  s.description    = 'Mints ECDSA P-256 signatures over a JCS-canonicalized hardware-attestation body, with the private key bound to the Secure Enclave.'
  s.author         = ''
  s.homepage       = 'https://motebit.com'
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

  # Link against Security.framework for SecKey / kSecAttrTokenIDSecureEnclave.
  s.frameworks = 'Security', 'CryptoKit'

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
