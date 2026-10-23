# iOS 客户端

实现位置：`apps/ios/DSHBots.xcodeproj`，Swift 6、SwiftUI、最低 iOS 18。`apps/ios/Package.swift` 提供可独立测试的核心库；无第三方 Swift 依赖。根目录 `pnpm build:ios` 构建 App，`pnpm test:ios` 启动隔离 Host 并运行 Swift 测试。插件 npm 包仍只交付 Host/桌面 Bundle，App 单独构建。

## 本次确定的权限范围

按用户最终要求，**仅保留普通成员聊天邀请，不提供所有者配对**。从电脑 Bots 聊天输入框生成邀请，手机扫码或粘贴完整 `dshbots://invite?data=…` 链接；加入前展示完整历史可见规则及电脑证书指纹。昵称不会合并身份。再次扫描同一 Host 的邀请会复用已认证的 Person/Device；同一邀请请求的 challenge 和 requestId 存入 Keychain，响应丢失后可恢复。

手机显示获准访问的聊天和助理。普通成员可以发言、@获授权的助理、停止/重试自己的任务及回答自己的问题；群主管理操作按 Host 授权显示。Host 所有者的工具审批卡片会显示“等待有权限的成员处理”，由电脑处理。助理创建、Session/Workspace/Preset 配置及 Host 管理继续在桌面进行，手机不会通过普通邀请获得这些权限。

App 的授权条件直接采用 Host 返回的角色和 grants；实际鉴权仍由 Host 完成。SwiftUI 管理组件保留对协议角色的判断，普通成员没有操作 Host 的入口。没有所有者二维码、所有者兑换路由或所有者凭据发放功能。

## 实现

- 聊天、助理、设备三个入口；邀请扫码与 URL Scheme、离线阅读、聊天搜索、分页历史、草稿、回复引用、结构化多助理 @、未读和置顶。
- HTTPS + WSS、Bearer 认证、刷新凭据、候选地址回退、连接 generation、指数退避与抖动。前台恢复连接，后台关闭连接，由 Host 继续执行。
- 每台 Host 独立的 Keychain 凭据和 DER SHA-256 指纹。私有 URLSession 严格校验扫描得到的证书，禁用重定向与 cookie，不开放全局 ATS 任意加载。证书只作为该 Host 的单一 X.509 trust anchor；使用 Basic X.509 策略验证私有证书，兼容现有 Host 的十年自签名证书，不能改为信任任意自签名证书。错误指纹已在真实 URLSession 测试中验证拒绝。
- SQLite WAL/FULL 事务；Host/Person/storeEpoch 隔离缓存、游标、草稿和 outbox。发送先落盘再清输入；重试保留 clientMessageId。快照与已确认 outbox 删除同事务，提交后 ACK。成员撤销清除该群缓存、草稿和待发消息。SQLite 版本为 1，拒绝更高版本。
- 订阅持久事件、快照刷新、超过一页的离线缺口补齐，流式更新在等待快照时仍保留；已落盘的流式消息按 Binding 去重。未读只在前台且位于聊天底部时提交。
- 执行轮次、过程折叠、最终回复、工具摘要、附件名称、流式正文、任务状态、原生 Session 活动、取消/重试、问题及审批状态。协议未知字段无损缓存；不读取隐藏推理、原始工具参数或任意文件。
- Native Markdown 支持正文行内样式、标题、列表、引用、表格、围栏代码、复制、代码水平滚动及长文展开。动态字体、可选择文本、系统相机失败后的链接粘贴入口。

本次沿用仓库现有 Host 产品决策：已有 Session 的选择和管理在电脑完成；二维码候选地址直连，不增加 Bonjour 广播/浏览。系统推送、附件字节传输、Android 和公网中继不在本期范围。

## 与桌面的对应关系

`DSHTheme.swift` 映射 DSH `ui-theme/src/styles/design-platform.css` 的背景、文字、次级文字、强调蓝、用户气泡和圆角。头像直接引用已有 `packages/desktop-ui/src/assets/whale-avatars.png`，按桌面 `Avatar.tsx` 的同一裁剪区域展示，不复制生成新资源。

`Transcript.swift` 对应桌面 `transcript.ts` 的 Binding + Turn 分组、旧消息边界、过程/最终答案划分、任务恢复状态及流式去重。`Tests/DSHBotsCoreTests/Fixtures/transcript.json` 同时由 Swift 测试和 `tests/ios-parity.test.ts` 校验，覆盖多人/多助理交错、工具过程、旧消息、流式首条及恢复。

已通过电脑使用工具查看实际 DSH Bots 界面，并读取原生消息组件、主题 token 和头像源码。**未完成 iPhone 或模拟器截图逐项对比，不声称像素级一致**。SwiftUI 文字排版和 Native Markdown 不等同于 DSH 浏览器完整 Markdown 引擎；复杂数学公式、嵌套 Markdown 等仍需对照实测，原始正文保留且可复制。

## 构建和使用

1. 先构建/安装当前插件版本并重启 DSH，保留原有插件和设置，见仓库 README 的安装步骤。本次仅编译，未替用户安装或重启实际 Host。
2. 用 Xcode 打开 `apps/ios/DSHBots.xcodeproj`，Scheme 选择 `DSHBots`，选择自己的 Signing Team 和 Bundle Identifier。
3. 将 iPhone 连接到 Mac，启用开发者模式，选择真机运行。允许相机和局域网访问。电脑与手机处于可互通的 Wi-Fi/热点。
4. 在电脑 Bots 中邀请加入聊天，在手机“设备 → 扫描聊天邀请”扫码。邀请会授予该群完整显示历史的访问和已有助理的调用权限。

最低部署版本 iOS 18。源码实际以 Xcode 27.1 SDK（Swift 6 模式）完成无签名 arm64 iPhone 构建；核心测试使用 Xcode 26.6 的 Swift 工具链运行于 macOS。当前默认 Xcode 26.6 的平台注册无法提供有效通用目标；本机另一套 Xcode 可成功编译，未修改系统 xcode-select。

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm test:ios
# 若默认 Xcode 已有可用 iOS 平台：
pnpm build:ios
# 本次实际成功的编译命令：
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project apps/ios/DSHBots.xcodeproj -scheme DSHBots \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath .tmp/ios-derived CODE_SIGNING_ALLOWED=NO build
```

以上路径为 Xcode 标准安装位置示例，不记录个人工作区路径。日志和构建产物仅放 `.tmp/`，不提交。无签名构建输出不是可直接安装的 IPA。

## 2026-10-22 验证记录

| 验证 | 结果 |
|---|---|
| `pnpm build` | Host、桌面、协议与 Typert 构建通过 |
| `pnpm typecheck` | 严格 TypeScript 检查通过 |
| `pnpm test` | 11 个测试文件、153 项通过 |
| `pnpm test:ios` | 6 项 Swift Testing 测试通过，包括真实 Host TLS/WSS |
| `pnpm pack:plugin` | 本地插件 tgz 生成通过，未安装或发布 |
| 上述 `xcodebuild` arm64 iPhone 构建 | 通过，无签名 |

Swift 测试包括 Unicode/未知字段 round-trip、非法/过期/非 HTTPS 邀请拒绝、SQLite 关闭重开、事务回滚、身份隔离、成员撤销缓存清理、五组桌面消息分组对照、错误证书指纹拒绝、真实邀请兑换与响应重试、未经授权的历史拒绝、十次重复发送只产生一条消息、普通背景不产生 Invocation、WSS 订阅/断线续传及 token rotation。根目录测试保留现有非唤醒上下文、重启恢复、投影、交互仲裁和生命周期清理覆盖。

本次 Host 测试使用受控 adapter、临时数据库和 127.0.0.1 随机端口，不访问实际用户模型或 Session。Swift 核心 transport 测试运行于 macOS；**不能据此宣称 iOS ATS、真机网络和 App 前后台行为已通过**。

剩余平台验收：本机没有 iOS 模拟器 runtime，也未连接可用 iPhone，因此未执行模拟器/UI 自动化或真机截图；需验证 iPhone 扫码、局域网权限拒绝/恢复、ATS + TLS/WSS、中文输入、动态字体/VoiceOver、长历史与滚动保持、锁屏/杀进程后恢复、两台手机与桌面同步，以及 Windows/macOS × Wi-Fi/双向热点矩阵。尚未配置签名团队、App Store 图标与分发资料、Archive/TestFlight；未发布 App，也未进行真实手机授权。以上均为待验收项目，不报告为完成。
