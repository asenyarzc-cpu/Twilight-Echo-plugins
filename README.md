# Twilight Echo Plugins

This repository hosts Twilight Echo plugins and the static plugin index used by
the app's plugin marketplace.

## Repository Layout

```text
plugins/
  bilibili-provider/
    plugin.json
    index.mjs
    index.test.mjs
packages/
  com.twilightecho.provider.bilibili-0.1.0.tep
plugins.json
```

- `plugins/<name>/` contains plugin source code.
- `packages/` contains installable `.tep` packages.
- `plugins.json` is the schemaVersion 1 plugin index consumed by Twilight Echo.

## Current Plugins

### Bilibili Favorites Provider

Plugin id: `com.twilightecho.provider.bilibili`

Provider id: `bili`

This plugin lets a signed-in user browse Bilibili video favorite folders and
play video audio in Twilight Echo. It uses Bilibili Web QR login, stores cookies
only in the plugin private settings file, maps tracks as `bili:<bvid>:<cid>`,
and returns local `127.0.0.1` loopback proxy URLs for audio playback.

## Build And Test

The pack script reuses the Twilight Echo app repository tooling. By default it
expects the app repository at `D:\Twilight_Echo-main`. Override that path with
`TWILIGHT_ECHO_ROOT` when needed.

```powershell
$env:TWILIGHT_ECHO_ROOT="D:\Twilight_Echo-main"
npm test
npm run pack
```

`npm run pack` creates or updates:

- `packages/com.twilightecho.provider.bilibili-0.1.0.tep`
- `plugins.json`

The generated package intentionally includes only runtime files such as
`plugin.json` and `index.mjs`; tests and development files are excluded.

## Use From GitHub

After pushing this repository, use the raw `plugins.json` URL:

```powershell
$env:TWILIGHT_PLUGIN_INDEX_URL="https://raw.githubusercontent.com/asenyarzc-cpu/Twilight-Echo-plugins/main/plugins.json"
npm run dev
```

The index uses relative package URLs such as
`packages/com.twilightecho.provider.bilibili-0.1.0.tep`, so Twilight Echo
resolves the package from the same GitHub raw base URL.

## Use From Your Own Server

You can host the same files on any HTTPS server:

```text
https://plugins.example.com/twilight/plugins.json
https://plugins.example.com/twilight/packages/com.twilightecho.provider.bilibili-0.1.0.tep
```

Then point Twilight Echo at your server:

```powershell
$env:TWILIGHT_PLUGIN_INDEX_URL="https://plugins.example.com/twilight/plugins.json"
npm run dev
```

If your package files live under another base URL, regenerate the index:

```powershell
$env:PLUGIN_BASE_URL="https://cdn.example.com/twilight/packages"
npm run pack
```

Twilight Echo validates the `.tep` SHA-256 from `plugins.json` before
installing. Regenerate and commit `plugins.json` every time a package changes.

## License

Apache-2.0. See [LICENSE](LICENSE).
