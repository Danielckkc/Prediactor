# Hello Example Platform

Minimal installable Lupin platform package used as a reference for custom providers.

## Try It

```bash
lupin platform install ./examples/platforms/hello-platform
lupin search hello-example "release notes"
lupin fetch hello-example https://example.com/posts/launch-day
```

## Files

- `lupin.platform.json`: manifest that declares tool names, aliases, and handlers
- `index.js`: ESM entry module with named exports that use `context.sdk`

See `docs/platforms.md` for the full authoring guide.
