# Bilibili Favorites Provider

Twilight Echo provider plugin:

- plugin id: `com.twilightecho.provider.bilibili`
- provider id: `bili`
- type: `provider + ui`

Features:

- Web QR login
- Bilibili favorite folders
- Pin one favorite folder so it stays at the top of the Bilibili library
- Audio-only playback through a local `127.0.0.1` proxy
- Cover and avatar loading through the same local proxy with Bilibili headers
- Private cookie storage in plugin settings

The plugin depends on Twilight Echo's provider API and UI integration points.
It does not ship host internals and does not load remote code at runtime.
