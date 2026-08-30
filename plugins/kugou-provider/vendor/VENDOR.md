# 内嵌 KuGouMusicApi vendor

- 上游：https://github.com/MakcRe/KuGouMusicApi
- pin commit：`2e2bcba4bf81c0833b44aad566c9a7edaba9c8cd`
- 许可：MIT（完整文本见插件根目录 THIRD_PARTY_NOTICES.md）
- 产物：`kugouApi.vendor.cjs`（esbuild 自包含单文件，运行期不依赖 node_modules 与上游目录）
- 导出：`createKugouApiServer({ host, port })` → Express app（`app.service` 为 http.Server）
- 构建期改动：server.js 导出行追加 `consturctServer` 导出并脱敏错误日志；不把插件回环地址伪装成上游客户端 IP；将上游通用 `platform` 环境变量改为插件私有 `KUGOU_API_PLATFORM`；移除 generate_simulate.js 的明文指纹日志；运行期不改上游任何文件
- 上游 public/ 与 docs/ 静态资源未随包分发（仅影响浏览器辅助页与文档站，API 不受影响）

## 重新构建

```shell
git -C D:\KuGouMusicApi fetch && git -C D:\KuGouMusicApi checkout <新commit>
# 审核上游 diff 后更新 scripts/build-kugou-vendor.mjs 的 PINNED_COMMIT
pnpm run build:kugou-vendor
```
