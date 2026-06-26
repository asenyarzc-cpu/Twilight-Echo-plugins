# Bilibili Favorites Provider

Twilight Echo provider plugin:

- plugin id: `com.twilightecho.provider.bilibili`
- provider id: `bili`
- type: `provider + ui`

## 功能

- Web QR 登录
- **独立 Bilibili 页** — 在 Twilight Echo 侧边栏拥有独立的「Bilibili」入口（不再并入流媒体页），页面内含搜索与收藏夹两个分区
- **搜索** — 在 Bilibili 页搜索 B 站视频，结果按视频首 P 映射为可播放曲目
- **收藏夹浏览** — 列出用户创建/收藏的视频收藏夹
- **多 P 展开** — 多 P 视频在收藏夹中展开为多条曲目（`视频标题 - 分P名`），不再只播首 P
- **置顶收藏夹** — 可固定一个或多个收藏夹置顶显示
- **Cookie 静默刷新** — 利用登录返回的 `refresh_token`，在 SESSDATA 即将轮换时通过
  `passport.bilibili.com/x/passport-login/web/cookie/refresh` 静默续期，无需重新扫码
- **收藏夹缓存 TTL** — 收藏夹曲目缓存 10 分钟后自动失效，B 站 App 新收藏的内容能被及时看到
- 仅音频播放 — 通过本地 `127.0.0.1` 代理转发 DASH 音频流，不下载或展示视频画面
- 封面与头像 — 经同一本地代理注入 B 站 CDN 所需的 Referer / User-Agent 头
- 私有 Cookie 存储 — 仅写入插件私有 settings 文件

## 依赖与边界

- 依赖 Twilight Echo 的 provider API 与 UI 集成点。
- 不携带宿主内部模块，不在运行时加载远程代码。
- 遵循 Twilight Echo 插件规范（见主仓库 `docs/twilight-echo-plugin-spec.md`）。

## 已知限制

- 搜索结果中每个视频需额外请求一次 `view` 接口解析 `cid`，已做并发（6）与 `limit` 截断控制。
- Cookie 静默刷新仅对「即将轮换但尚未失效」的 SESSDATA 生效；若 Cookie 已完全过期，仍需重新扫码。
- 收藏夹缓存 TTL 失效后下次访问会重新拉取（最多 50 页），可显式 `force=true` 立即刷新。
