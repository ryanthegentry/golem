# Spec 16: Directory, Registry & Discovery

## Purpose
Three sub-modules: (1) Directory client for querying 402index.io, (2) Registry client for auto-registering gateways, (3) Service discovery for local upstream detection.

## 1. Directory Client (402index.io Query)

```rust
pub struct DirectoryService {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub url: String,
    pub protocol: String,          // "L402" | "x402" | "both"
    pub price_sats: Option<u64>,
    pub price_usd: Option<f64>,
    pub category: Option<String>,
    pub provider: Option<String>,
    pub health_status: Option<String>,
    pub uptime_30d: Option<f64>,
    pub latency_p50_ms: Option<u64>,
    pub registered_at: Option<String>,
}

pub struct DirectoryQuery {
    pub q: Option<String>,
    pub protocol: Option<String>,
    pub category: Option<String>,
    pub health: Option<String>,
    pub max_price_usd: Option<f64>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub sort: Option<String>,
    pub order: Option<String>,
}

/// Query 402index.io directory. Timeout: 15s.
pub async fn query_directory(
    query: &DirectoryQuery,
    base_url: &str,  // Default: "https://402index.io"
) -> Result<Vec<DirectoryService>, Error>;
```

## 2. Registry Client (Auto-Registration)

```rust
pub struct RegistrationParams {
    pub registry_url: String,
    pub public_url: String,
    pub service_name: String,
    pub description: Option<String>,
    pub price_sats: u64,
    pub category: Option<String>,
    pub contact_email: Option<String>,
    pub probe_body: Option<String>,
}

pub enum RegistrationStatus {
    Pending,           // 201 — Queued for probe
    AlreadyRegistered, // 409 — URL already known
    ProbeFailed,       // 422 — Probe didn't get expected 402
    Failed(String),    // Other error
    Skipped,           // No publicUrl configured
}

/// Register gateway with 402index.io. Non-blocking, fire-and-forget.
/// POST /api/v1/register with 5s timeout.
pub async fn register_with_index(
    params: &RegistrationParams,
) -> RegistrationStatus;
```

**POST body:**
```json
{
    "url": "https://example.com",
    "name": "My Gateway",
    "protocol": "L402",
    "description": "AI inference endpoint",
    "provider": "golem-gateway",
    "category": "ai",
    "http_method": "POST",
    "contact_email": "user@example.com",
    "probe_body": "{\"model\":\"llama3\"}"
}
```

**Integration:** Called fire-and-forget on gateway startup. Registration failure NEVER prevents gateway from starting.

## 3. Service Discovery

```rust
/// Probe for local Ollama instance.
/// GET http://localhost:11434/api/tags with 2s timeout.
/// Returns None if service unavailable.
pub async fn discover_ollama() -> Option<OllamaInfo>;

pub struct OllamaInfo {
    pub url: String,         // "http://localhost:11434"
    pub models: Vec<String>, // Available model names
}
```

Used by `golem gateway init` for auto-populating upstream URL.

## Test Specifications (~24 tests across 3 files)

### Directory Client (12 tests)
| Test | Assert |
|---|---|
| Basic query | Returns services array |
| Query parameters passed | q, protocol, category in URL |
| Filtering by protocol | Only matching services |
| Filtering by category | Only matching category |
| Error handling: network | Returns error, doesn't crash |
| Error handling: invalid JSON | Returns error |
| Pagination | limit + offset passed correctly |
| Null fields handled | Optional fields can be null |
| Empty results | Returns empty vec |
| Timeout | 15s timeout triggers error |

### Registry (9 tests)
| Test | Assert |
|---|---|
| Successful registration | 201 → Pending |
| Already registered | 409 → AlreadyRegistered |
| Probe failed | 422 → ProbeFailed |
| Network error | Returns Failed |
| Timeout (5s) | Returns Failed |
| JSON parsing error | Returns Failed |
| Skipped without publicUrl | Returns Skipped |
| POST body format | Correct fields sent |
| Provider always "golem-gateway" | Hardcoded |

### Discovery (3 tests)
| Test | Assert |
|---|---|
| Ollama found | Returns url + models |
| Ollama not running | Returns None |
| Timeout (2s) | Returns None |
