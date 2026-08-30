# QQ 音乐音源

Twilight Echo 的 QQ 音乐 Provider 插件。

- 插件 ID：`com.twilightecho.provider.qqmusic`
- Provider ID：`qq`
- 当前版本：`0.2.0`

## 功能

- 搜索 QQ 音乐歌曲、歌手和歌单
- 首页新歌推荐和推荐歌单
- 发现歌单分类、最新/最热排序和分页加载
- 无需登录即可浏览公开歌单曲目
- 通过 QQ 音乐 vkey 获取已授权的播放地址
- 本机 `127.0.0.1` 流代理，支持 Range/seek，不向播放器暴露会话 Cookie
- 原文歌词、翻译歌词和专辑封面
- QQ 音乐原生扫码登录、用户资料、我喜欢歌单和用户歌单
- 受控设置表单中的免责声明确认

插件只实现只读 Provider 能力，不提供下载、收藏写入、歌单写入、MV 或任何绕过访问限制的功能。

## 使用

1. 在 Twilight Echo 设置中打开「插件设置 → QQ 音乐音源」。
2. 阅读免责声明并选择「我已阅读并同意免责声明」。
3. 在登录页选择 QQ 音乐并扫码。
4. 返回流媒体页浏览首页推荐、发现歌单、搜索歌曲或打开 QQ 音乐用户歌单。

从 `0.1.3` 升级时，请先在插件设置中退出登录，再重新扫码一次。此前版本可能保存了不完整的网页兼容会话；`0.1.4` 会为同一台原生设备完成凭据交换和验证，并以该会话读取音乐库及播放地址。

插件使用 QQ 音乐原生二维码登录。二维码出现后，请按页面提示使用支持的 QQ 或 QQ 音乐客户端扫码并确认；桌面端会自动更新登录状态。若二维码状态检查失败，请刷新获取新码后重试，不要重复使用旧码。

退出登录会清除插件私有认证数据、原生设备会话与缓存。插件不会将 Cookie 写入日志、曲目字段或错误信息。

## 免责声明

本插件及其上游接口仅供个人学习与研究使用。插件作者与腾讯、QQ 音乐没有隶属、代理或授权关系。用户须自行遵守适用法律、QQ 音乐服务条款和版权要求，并对自己的账号、请求和播放行为负责。上游 QQ 音乐接口字段、可用地区、登录策略和播放权限可能随时变化；插件不保证持续可用，也不收集遥测数据。

问题反馈请提交到 [GitHub Issues](https://github.com/asenyarzc-cpu/Twilight-Echo-plugins/issues/new)。请勿在 Issue、日志或截图中粘贴 Cookie、二维码签名或其他账号凭据。

## 上游与许可证

本插件的公开曲库、首页推荐和发现歌单请求适配基于 [Rain120/qq-music-api](https://github.com/Rain120/qq-music-api) `next@d05420bf098bd2769866eba81cfd48a6d0c6f50c`，原生二维码状态通道参考 [yakult-green-tea/qq-music-api](https://github.com/yakult-green-tea/qq-music-api)。上游项目以 MIT License 发布；完整归属信息见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。本插件自身以 Apache-2.0 发布。
