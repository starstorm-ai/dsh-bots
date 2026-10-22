# DSH Bots

在现有 DeepSeek Harness 内提供单聊、多人群聊、具名鲸鱼助理和局域网聊天邀请。桌面聊天、助理管理及输入框中的邀请二维码都属于同一个 `dsh-bots` 插件。Host 复用 DSH 已有 Workspace、Session 和 Agent Runtime，不启动第二个模型运行时。

本仓库实现非 iOS 的 MVP：共享协议、持久化业务层、Host 插件和嵌入 DSH 的桌面聊天界面。`apps/ios` 与 Android 不在本次实现范围内。LAN API 可用于后续移动客户端及本期自动化集成测试。

创建助理只需名称、头像和一个已有 DSH Session；工作区由 Session 确定，沿用其预设、模型和权限。助理加入单聊或群聊时使用选中的 Session，不再创建新会话。一个 Session 同时只能绑定一个聊天；加入群聊前需确认共享它已有的模型上下文。创建页面不提供额外的工作区或预设选择、配置摘要和“在 DSH 中打开”入口。

会话选项显示 DSH 原生名称、所属工作区和最近活动时间；未命名或仍然重名的会话附加短编号区分。

“助理”页的卡片提供“删除助理”，确认后从聊天中移除助理并取消其排队任务，保留原 DSH Session、聊天记录和其他助理；释放的 Session 可以重新选择。正在执行或状态待确认的任务需先停止或确认状态。删除后的历史消息保留作者名称，已失效的任务不再提供重试入口。

Bots 直接使用 DSH 的 `ConversationSessionHeader`，把原生“对话／轨迹”位置替换为聊天、助理两个 Tab；未选择聊天时标题留空。横向聊天栏直接使用轨迹工具栏的 CSS module：栏高 32px、按钮高 20px，头像加文字，选中灰底、未选中透明，群头像最多叠放三位成员。输入框使用原生 `DraftEditor` 和 `InputBar` 样式，房间草稿独立保存。页面没有整体挂载只能关联单个 Session 的 `ChatView`。

消息按 Binding + 原生 Turn 归组，每轮仅展示一个过程入口和最终回复。用户气泡、助理正文、完成用时、过程分组、运行状态、复制及时间使用实际的 `UserMessageNodeView`、`AssistantMarkdown`、`TurnProcessNodeView`、`ChatGroupSeat`、`RunningStatus` 和 `MessageIconActions`。完成后默认折叠过程，保留最终回复；展开后查看本轮中间消息和工具摘要。旧记录没有轮次元数据时，根据任务 ID 和原生用户输入边界归组，不重写聊天历史。

聊天页的原生任务状态仅对应本聊天绑定的 Session，不再展示同工作区其他运行中会话的列表及跳转入口。每位助理仍绑定一个独立 Session，多个助理不能共用同一个 Session。

单聊和群聊都只有结构化 @ 才触发任务。单聊默认选中自己的助理，移除标签后仅注入上下文；群聊默认不选助理。输入 `@` 或点击输入框下方 `@助理`，可搜索并通过方向键、Enter 选择，Escape 关闭；可选中多位助理。新建单聊默认导入绑定 Session 的可见历史，群聊须单独勾选导入，已有绑定的历史截止位置不变。原生消息保留 Session、消息和来源序号，工具开始/结束更新同一条折叠行，任务回显与非唤醒上下文不重复展示。

创建助理直接复用 DSH `@` 的 `MenuView`、菜单 reducer 和原生候选项样式，支持搜索、方向键、Enter 和 Escape，显示标题、位置和相对时间。所有工作区的已有 Session 都可参与选择，已被其他助理占用的会话除外；没有工作区白名单或单独的 Session 授权记录，也没有连接设置 Tab。

每个聊天输入框提供邀请二维码。首次生成时自动启动独立 HTTPS/WSS 服务，优先使用 49210 或上次端口，占用时自动改用可用端口，保存实际端口供重启恢复。二维码是 `dshbots://invite?data=…`，包含聊天、局域网候选地址、短期邀请和 TLS 指纹，由未来 iOS 客户端处理。邀请有效期 10 分钟，可供多人加入；刷新使旧码失效，关闭弹窗不关闭服务。首次加入的新成员会让单聊原地转为群聊，保留历史和 Session；新成员默认可调用聊天里的助理，后续显式撤销仍生效。未增加浏览器加入页或聊天客户端。

## 开发环境

- Node.js 22.19+ 或 24+，pnpm 11.7.0。
- 已构建的 DeepSeek Harness `0.2.0-rc.2`（commit 见 [compatibility.json](compatibility.json)）。默认复用同级 `../dsh-embedded-codex/upstream/deepseek-harness`。
- `pnpm install --frozen-lockfile` 安装本插件依赖；`pnpm setup:dsh` 只在本仓库的 `node_modules` 创建 SDK 链接，不修改 DSH 源码或其他仓库的工作区。

```powershell
pnpm install --frozen-lockfile
pnpm setup:dsh
pnpm typecheck
pnpm test
pnpm build
```

DSH 位于其他路径时设置 `$env:DSH_SOURCE_ROOT='D:\path\deepseek-harness'`。构建产物为 `lib/index.js`（Host）、`lib/client.js`（DSH 动态客户端模块）、共享协议与生成的 Typert Remote 合约。SDK 通过现有宿主提供；浏览器使用宿主的 React 和 Cordis。

二维码库 `qrcode` 已打包进客户端，只需要作为构建依赖安装。`zod` 被生成的 Typert Host/客户端合约使用，须保留为运行时依赖；检查依赖用途时需同时检查生成产物。

## 添加到本地 Embedded Codex Dev DSH

```powershell
pnpm dev:embedded-codex --dry-run
pnpm dev:embedded-codex
```

默认执行构建、打包和安装，目标为同级 `dsh-embedded-codex/.tmp/dsh-home/profiles/desktop`。不会自动打开 Electron。安装完成后重启正在运行的 DSH Host；也可以显式执行 `pnpm dev:embedded-codex --launch` 启动已有桌面开发环境。快捷命令 `pnpm dev:install` 等同于仅安装，`pnpm dev:remove` 仅卸载 Bots 插件，聊天数据库保留。

安装通过目标 DSH 的已构建 CLI 和其桌面 profile carrier 完成，保留现有插件、Bundle 顺序、个人设置和 `cordis.patch.yml`。不会删除或重建整个 `node_modules`。安装前将 profile 配置备份到本仓库 `.tmp/profile-backups/`，安装后校验其他插件和设置未被改动。目标 profile 必须已经存在；脚本不会初始化或清空用户环境。

```powershell
pnpm dev:embedded-codex --embedded-root D:\another\dsh-embedded-codex --install-only
pnpm dev:embedded-codex --profile web --install-only
pnpm dev:embedded-codex --home D:\custom\dev-home --cli D:\custom\bin.js --install-only
```

环境变量对应 `DSH_EMBEDDED_CODEX_ROOT`、`DSH_BOTS_DSH_HOME`、`DSH_BOTS_PROFILE` 和 `DSH_BOTS_DSH_CLI`。只有明确指定 `--launch` 才启动可见桌面窗口。`--skip-build` 只适用于已经验证且未过期的本地构建产物，脚本会验证源码和产物摘要，防止打包失败构建留下的混合文件。依赖均已缓存时可加 `--offline`，避免已有 Codex 插件的其他系统可选包触发网络下载；正常安装的网络超时与重试也有上限。

## 打包和迁移

`pnpm pack:plugin` 生成 `.tmp/packs/dsh-bots-0.1.0-<内容摘要>.tgz`。将该文件带到匹配版本的 DSH 后，通过其插件管理界面或受支持的 `dsh plugin add <tgz>` 安装。插件为 additive Bundle，不替换现有 Session Controller，也不更改 Runtime 配置。

源码可独立提交与迁移；新机器需安装依赖并配置匹配 DSH SDK。不要迁移 `node_modules`、本地 SDK 链接或 `.tmp`。聊天数据与设备凭据位于宿主的 DSH home，迁移源码或卸载插件不会自动携带这些私有数据。

## 架构

| 路径 | 职责 |
|---|---|
| `packages/protocol/src` | 版本化 JSON 协议、DTO、校验、跨客户端契约 |
| `packages/core/src` | SQLite 持久化、身份/群成员权限、消息与任务队列、上下文注入记录、重连恢复 |
| `packages/dsh-plugin/src` | Cordis Host 服务、DSH Session 适配、自动 HTTPS/WSS 监听、TLS 身份及 iOS 邀请 |
| `packages/desktop-ui/src` | Bots 桌面聊天、助理、原生 Session 选择菜单和聊天邀请 |
| `scripts` | SDK 连接、构建、打包、现有 dev DSH 安装/移除 |
| `tests` | 业务与传输集成测试、开发安装保护检查 |

完整产品边界见 [设计文档](docs/design.md)。iOS 前台双向同步的后端接口在本仓库提供；iOS App、系统通知/APNs、跨公网中继、文件附件与 Android 客户端均需后续交付。

## 验证范围

2026-10-22 已通过 `pnpm typecheck`、`pnpm test`（10 个文件、144 项测试）、`pnpm build`、实际 profile 安装，以及隔离真实 Host 的 12 项检查和桌面界面的 13 项交互流程。测试覆盖显式 @ 路由、历史导入与隔离、轮次归组与最终回复边界、上下文收据、去重、跨工作区 Session 选择、废弃授权数据迁移、自动监听与端口回退、邀请刷新/撤销、重复扫码与凭据轮换、草稿恢复、输入法、窄屏和深色主题。桌面回归使用原生 Session 候选菜单，并比较原生 DSH 与 Bots 的页头、Tab 和轨迹工具栏按钮尺寸；通过一次真实工具调用检查过程折叠与最终回复，通过聊天输入框验证邀请二维码，并验证引用回复在聊天和历史搜索中的显示。UI 回归结果写入 `.tmp/ui-smoke-results.json`。未新增浏览器客户端，iOS 真机扫码进群留待客户端完成后验证。

删除助理新增 `bot.delete` 命令，协议次版本升至 1.2，数据库版本不变。回归覆盖权限校验、重复删除、运行中任务拦截、排队派发竞争、观察器停止、历史保留、重启恢复与 Session 释放；真实桌面流程验证确认/取消删除、草稿保留、刷新后状态，以及原 Session 重新用于创建助理。

此前代码清理保留协议、数据库版本及已有功能：删除无引用的文案和样式，启用未使用变量/参数检查；Session 候选与聊天轮次使用索引查找，数据库最多复用 64 条预编译查询，查询结果仍实时读取。新增用例覆盖事务回滚后的读取、记录隔离、流式消息去重和原生轮次边界。另以 1,000 组生成的会话快照对照重构前后实现，消息归组及最终回复输出一致。

交付前运行 `pnpm typecheck`、`pnpm test`、`pnpm build` 和实际 profile 安装检查。自动化测试使用隔离临时数据库和受控 DSH 适配器，不访问用户的真实模型或会话。

执行 `pnpm dev:embedded-codex` 安装后，可运行 `pnpm test:profile`。它复制已安装的桌面 profile 到本仓库 `.tmp/profile-smoke-*`，启动无窗口 Host，先通过原生 Controller 创建标准与 Embedded Codex Session，再验证助理及聊天复用选中的会话，并使用本地模型夹具检查非唤醒上下文注入、@ 任务、结果回流和交互问答。测试数据与用户的 DSH home 分开，也不会调用收费模型。`pnpm test:profile --serve` 可保留隔离 Host 供浏览器检查；连接信息写入 `.tmp/profile-smoke-latest.json`，在其中 `home` 指向的目录创建空文件 `stop` 后退出。自定义桌面 checkout 使用 `DSH_DESKTOP_SOURCE_ROOT`，待测已安装 profile 的 home 使用 `DSH_BOTS_DEV_HOME`（未设置时兼容安装脚本的 `DSH_BOTS_DSH_HOME`）。

实际 Windows/macOS 防火墙、同 Wi-Fi/热点连通性和移动客户端真机测试需在对应设备上完成；不将这些设备测试等同于 Node 集成测试。

运行 `pnpm test:profile --serve` 后，在另一终端执行 `pnpm test:ui`，使用 Windows Edge 的无窗口模式检查真实界面。其他系统可通过 `DSH_BOTS_BROWSER` 指定兼容 Chromium 的浏览器路径。原生历史附件本期显示名称，聊天不提供文件内容传输；工具展示开始/结束和摘要，不向群聊复制原始工具参数、文件字节或隐藏推理。

本次数据库升级到版本 3：清理废弃的工作区/Session 授权、旧邀请、配对收据和远端凭据，保留聊天、人员、设备记录、消息、任务、Session 绑定及旧截止位置。原远端凭据需要通过新邀请重新获取。旧版插件不能读取升级后的数据库。
