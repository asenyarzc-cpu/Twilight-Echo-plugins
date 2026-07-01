# YouTube Music 音源插件

在 Twilight Echo 流媒体区搜索和播放 YouTube Music 曲库。

基于 [ytmusicapi](https://github.com/sigma67/ytmusicapi) 的解析逻辑重构，使用纯 Node.js 内置模块实现，无外部依赖。

## 功能

- 🔍 **搜索** — 搜索 YouTube Music 曲库中的歌曲和视频
- 🎵 **播放** — 通过 InnerTube Player API 获取音频流并代理播放
- 📝 **歌词** — 获取 YouTube Music 提供的歌词
- 📋 **歌单** — 浏览用户创建/收藏的歌单
- 🖼️ **封面** — 自动加载歌曲封面
- 📚 **媒体库** — 浏览用户媒体库中的歌单

## 认证方式

本插件支持两种认证方式。OAuth 登录只用于识别账号资料；YouTube Music 私人音乐库必须使用浏览器 Cookie/SAPISID 认证。

### 方式一：浏览器 Google 登录（账号资料）

点击登录后，浏览器会自动打开 Google 授权页面。登录 Google 账号并授权后，插件可以显示账号资料。

1. 在登录页面点击「YouTube Music」
2. 浏览器自动打开 Google 登录页面
3. 登录 Google 账号并点击授权
4. 回到 Twilight Echo，自动完成登录

> 授权后插件会自动获取 access_token 和 refresh_token，令牌过期时自动刷新。由于 YouTube Music 当前会拒绝该 OAuth token 访问 `WEB_REMIX` InnerTube 私人资料库，OAuth 登录不会解锁音乐库。

### 方式二：Cookie 导入（音乐库）

如需读取 YouTube Music 私人音乐库，需要手动导入浏览器 Cookie：

1. 在浏览器中访问 [music.youtube.com](https://music.youtube.com) 并登录 Google 账号
2. 打开 Twilight Echo 侧边栏中的「YouTube Music 账号」页面
3. 粘贴原始 Cookie，或粘贴浏览器开发者工具中复制的完整请求头
4. 点击保存；内容必须包含 `SAPISID` 或 `__Secure-3PAPISID`

保存后插件只持久化 `settings.cookie`，不会在页面或日志中回显 Cookie。保存 Cookie 会清理已缓存的 InnerTube 配置，之后音乐库会使用 `SAPISIDHASH` 认证访问。

### 高级 OAuth client（可选）

账号设置页也支持填写用户自备的 Google Cloud OAuth `client_id` 和 `client_secret`，用于替代自动发现的 YouTube TV OAuth client。该选项只影响 OAuth 登录/刷新流程，不默认解锁 YouTube Music 私人音乐库。

> ⚠️ 需要 YouTube Premium 订阅才能播放部分受保护的内容。

## 技术实现

### 架构

- 通过 YouTube Music InnerTube API（`WEB_REMIX` 客户端）进行搜索和元数据获取
- 通过 InnerTube Player API 获取音频流 URL
- 使用 Node.js `vm` 模块处理签名解码（当需要时）
- 本地 HTTP 代理服务器转发音频流（同 Bilibili 插件模式）
- 纯 Node.js 内置模块实现，无外部依赖

### ytmusicapi 解析逻辑移植

本插件的搜索结果解析、歌单解析、媒体库解析逻辑移植自 [ytmusicapi](https://github.com/sigma67/ytmusicapi)（MIT License），包括：

- **导航工具** (`nav()`) — 安全访问嵌套 JSON 对象
- **搜索解析** — `parseSearchResult`, `parseTopResult`, `parseSearchResults`
- **歌曲解析** — `parseSongRuns`, `parseSongRun`, `parseArtistsRuns`
- **歌单解析** — `parsePlaylistItem`, `parsePlaylistItems`
- **媒体库解析** — `getLibraryContents`, `parseContentList`, `parsePlaylist`
- **续页处理** — `getContinuationToken`, `getContinuations2025`
- **歌词解析** — `getTabBrowseIds`
- **认证** — SAPISID Hash 生成 (`getAuthorization`)

### SAPISID 认证

插件使用 SAPISID Hash 进行认证（移植自 ytmusicapi 的 `helpers.py`）：

1. 从 Cookie 中提取 `__Secure-3PAPISID` 或 `SAPISID`
2. 生成 `SAPISIDHASH`：`SHA1(timestamp + " " + sapisid + " " + origin)`
3. 在请求头中添加 `Authorization: SAPISIDHASH timestamp_hash`

### InnerTube 配置

- **API Key**: 优先从 YouTube Music 首页抓取，回退到硬编码值
- **Client Version**: 优先从首页抓取，回退到动态生成 (`1.YYYYMMDD.01.00`)
- **Visitor Data**: 从首页 `ytcfg.set()` 中提取

## 音频质量

| itag | 格式 | 码率 | 说明 |
|------|------|------|------|
| 141 | m4a (AAC) | 256 kbps | Premium 高质量 |
| 251 | webm (Opus) | 160 kbps | 标准高质量 |
| 140 | m4a (AAC) | 128 kbps | 标准 |
| 250 | webm (Opus) | 70 kbps | 低质量 |

插件按上述优先级自动选择最佳可用格式。

## 限制

- YouTube Music API 为非官方私有 API，可能随时变更
- 签名解码机制可能随 YouTube 播放器更新而失效
- 部分地区可能需要代理访问 YouTube Music
- Cookie 有效期有限，需要定期更新
- OAuth 登录只用于账号资料识别；私人音乐库需要 Cookie/SAPISID
- 高级 OAuth client 只替代 OAuth 登录凭据，不承诺可读取私人音乐库
- 搜索结果仅返回可播放的歌曲和视频（不含专辑、艺术家等）

## 许可证

Apache-2.0

## 致谢

- [ytmusicapi](https://github.com/sigma67/ytmusicapi) — MIT License，本插件的解析逻辑基于此项目移植
