# Third-party notices

## MakcRe/KuGouMusicApi

This plugin embeds a build of MakcRe/KuGouMusicApi as `vendor/kugouApi.vendor.cjs` so the compatible API service runs inside the plugin host process (loopback only, lifecycle bound to the app). The bundle is produced by `scripts/build-kugou-vendor.mjs` from the pinned upstream commit; see `vendor/VENDOR.md` for the exact commit and rebuild instructions. Build-time modifications add a `consturctServer` export on `server.js`, prevent the plugin loopback address from being forwarded upstream as a client IP, scope the upstream platform selector to `KUGOU_API_PLATFORM`, redact request query data and upstream response bodies from server error logs, and remove the `generate_simulate.js` plaintext device-fingerprint log; no upstream file is modified at runtime. The embedded server does not ship the upstream `public/` or `docs/` static assets (browser helper pages and the doc site only).

Upstream repository: https://github.com/MakcRe/KuGouMusicApi

Pinned upstream commit: 2e2bcba4bf81c0833b44aad566c9a7edaba9c8cd

The upstream project is distributed under the MIT License:

```text
MIT License

Copyright (c) 2022 Lines

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
