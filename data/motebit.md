---
spec: "motebit/identity@1.0"
motebit_id: "c4593c33-1f74-81f9-92c6-62bbe5d26356"
created_at: "2026-08-05T00:19:55.846Z"
owner_id: "motebit-web-search"
type: "service"
service_name: "Web Search"
service_description: "Brave/DuckDuckGo web search + multi-hop delegation to read-url"
capabilities:
  - "web_search"
  - "read_url"
identity:
  algorithm: "Ed25519"
  public_key: "db02a82c735a5fad2d4625a447a2c17d4134104a48c2849eab4a2758139d83a3"
governance:
  trust_mode: "guarded"
  max_risk_auto: "R1_DRAFT"
  require_approval_above: "R1_DRAFT"
  deny_above: "R4_MONEY"
  operator_mode: false
privacy:
  default_sensitivity: "personal"
  retention_days:
    none: 365
    personal: 90
    medical: 30
    financial: 30
    secret: 7
  fail_closed: true
memory:
  half_life_days: 7
  confidence_threshold: 0.3
  per_turn_limit: 5
devices:
  - device_id: "25964d32-7562-48dd-9bcc-f3c1b9f164b1"
    name: "motebit-web-search"
    public_key: "db02a82c735a5fad2d4625a447a2c17d4134104a48c2849eab4a2758139d83a3"
    registered_at: "2026-08-05T00:19:55.844Z"
---
<!-- motebit:sig:motebit-jcs-ed25519-hex-v1:45f663a3467a50d0deba3f5f47dc30c9bffa1440143afa34f985aaf58fd562a7676bf3188d6637e141b29ca9e5c2d4f7b6635e3db41aea8f29f251959495100e -->
