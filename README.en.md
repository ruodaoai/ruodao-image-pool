# Image Account Pool

A local image generation pool with a pinned engine build and an isolated Python environment, supporting gpt-image-2.6 / 2 and native GIF output on the 2.6 series. Paste accounts to add them to the pool, and get call logs, an image library, usage stats and an OpenAI-compatible local API.

## What it does

- **Account pool** - paste credentials to enrol accounts; the plugin signs in automatically and manages rotation.
- **Pinned engine** - a fixed engine version and isolated Python environment, so upgrades of the system Python do not break generation.
- **Models** - gpt-image-2.6 and gpt-image-2 images, plus native animated GIFs on the 2.6 series.
- **Local API** - an OpenAI-compatible endpoint on localhost that other tools and plugins can call.
- **Library and stats** - every generated image is kept locally with prompt, cost and timing; usage is aggregated per account and per day.
- **Logs** - per-call request/response logs for debugging failures.

## Requirements

- Ruodao desktop host on Windows.
- The plugin provisions its own Python environment; no system Python setup is needed.
- Accounts you add must be one you are entitled to use.

## Permissions and privacy

- `network`, `process`, local storage.
- Credentials, logs and images stay on the local disk; the plugin does not send them anywhere except the upstream image service you configured.

## Links

- Marketplace: https://ruodao.com/plugin-market

## License

MIT
