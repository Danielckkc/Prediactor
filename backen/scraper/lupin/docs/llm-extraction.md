# LLM Extraction

Extract structured data from any page using `--extract` (free-form prompt) or `--schema` (JSON Schema constrained output). Works with Ollama and remote OpenAI-compatible endpoints.

## Setup options

### Ollama (recommended)

Ollama keeps the model loaded in memory — every call is fast (~2-3s).

```bash
# Install Ollama (https://ollama.com)
ollama pull qwen3.5:4b

# Configure lupin
lupin llm add ollama \
  --base-url http://localhost:11434/v1 \
  --model qwen3.5:4b \
  --default

# Extract
lupin fetch https://example.com --extract "summarize this page"
lupin fetch https://example.com --schema '{"type":"object","properties":{"title":{"type":"string"},"links":{"type":"array","items":{"type":"string"}}},"required":["title"]}'
```

### OpenRouter (remote, no local GPU needed)

```bash
export OPENROUTER_API_KEY=sk-or-...

lupin llm add openrouter \
  --base-url https://openrouter.ai/api/v1 \
  --api-key '${OPENROUTER_API_KEY}' \
  --model qwen/qwen3.5-9b \
  --default
```

### Which setup to choose?

| Setup | Speed | Requires | Best for |
|---|---|---|---|
| Ollama | ~2-3s | Ollama installed, model pulled | CLI usage, frequent calls |
| OpenRouter | ~2-5s | API key, internet | No local GPU, large models |

## Usage

```bash
# Free-form extraction
lupin fetch <url> --extract "what are the prices?"

# Structured extraction (JSON Schema)
lupin fetch <url> --schema '{"type":"object","properties":{"title":{"type":"string"},"price":{"type":"number"}}}'

# Combined: schema defines structure, prompt guides what to look for
lupin fetch <url> --schema ./founders.schema.json --extract "only technical co-founders"

# Override provider for a single call
lupin fetch <url> --extract "summarize" --llm openrouter

# Works on platform providers too
lupin fetch reddit https://reddit.com/r/node/comments/abc --extract "summarize the top comments"
lupin fetch hn https://news.ycombinator.com/item?id=123 --schema '{"type":"object","properties":{"title":{"type":"string"}}}'

# Per-page extraction during crawls
lupin crawl https://docs.example.com --extract "summarize" --llm ollama
```

| Flag | Description |
|---|---|
| `--extract <prompt>` | Free-form LLM prompt against page content |
| `--schema <json\|file>` | JSON Schema for structured output (inline or file path) |
| `--llm <provider>` | Provider name (default from `~/.lupin/llm.json`) |
| `--llm-timeout <ms>` | Inference timeout (default: 180000) |

## Output format

Without `--format json`, LLM results are printed as raw text (extract) or raw JSON (schema). With `--format json`, the full metadata envelope is returned:

```json
{
  "provider": "page",
  "url": "https://example.com",
  "content": { "title": "Example Domain", "price": null },
  "llm": {
    "model": "qwen3.5:4b",
    "provider": "ollama",
    "prompt": "extract pricing",
    "durationMs": 2100
  },
  "extraction": { "method": "http", "confidence": "high" },
  "durationMs": 2400
}
```

## Provider management

```bash
lupin llm list                    # show configured providers
lupin llm add <name> --base-url <url> --model <model> [--api-key <key>] [--default]
lupin llm remove <name>           # remove a provider
lupin llm default <name>          # change default provider
```
