# dsh-llm-retry-upstream-400

当模型请求因为上游网关的 **400** 错误失败时，等待 **5 秒**自动重跑同一个步骤的 DSH 插件。

```
400: {"message":"Upstream error (request id: 20261105-...)"}
```

这类错误由 OpenAI 兼容网关在自身上游短暂不可用时返回。请求本身没有错，重发通常立刻成功；但适配器会把它归类为 `INVALID_REQUEST`（永久性错误），于是 `@deepseek-ai/dsh-llm-retry` 的默认重试策略直接放弃，整轮对话结束。本插件补上这一段恢复逻辑。

## 工作方式

`agent/request-error` 是 agent loop 在一步模型请求以失败终态结束时的瀑布流扩展点：监听器返回 `{ kind: 'retry' }` 且不调用 `next()`，loop 就会在同一个未关闭的轮次里重跑失败的步骤（沿用同一份持久化历史）。

本插件只注册一个监听器：

1. 匹配失败事实：消息命中 `matchPattern`（默认 `upstream\s+error\s*\(\s*request\s*id`），且失败码在 `codes` 中（默认 `INVALID_REQUEST`），且 HTTP 状态在 `statuses` 中（默认 `400`；状态取自失败事实，没有时从 `400: {...}` 这样的消息前缀里读，读不到则不因状态拒绝）。
2. 命中后先发一条 `warn` 日志，再等待 `delayMs`（默认 5000ms）；等待可被轮次取消或插件卸载立即打断。
3. 等待结束且未取消，返回 `{ kind: 'retry' }`。
4. 其余任何失败都原样交给下一个监听器（`next()`），不影响既有策略。

重试预算按 `会话:轮次:步骤` 计数，默认 `maxRetries: 12`（约 60 秒）。预算耗尽后插件把失败交回下游，由原来的错误处理路径收尾，不会无限重试。

插件不产生任何模型可见内容：没有提示词片段、没有工具、没有会话事件，重试对模型不可见，请求前缀保持可复用。

## 安装

### 方式一：写进 profile 的 patch 层（推荐，零依赖、零网络）

```powershell
# 先看会改成什么
node scripts/install.mjs --dry-run

# 写入 $DSH_PROFILE_DIR/cordis.patch.yml（自动备份原文件）
node scripts/install.mjs

# 调整延迟 / 预算
node scripts/install.mjs --delay-ms 3000 --max-retries 6

# 卸载
node scripts/install.mjs --uninstall
```

插件行以 `file:` URL 指向本仓库的 `lib/index.js`（`inserted plugin names may be absolute filesystem paths, file URLs, or package specifiers`），因此不需要 `pnpm`、不需要发布、移动仓库后需要重新执行安装脚本。

Desktop profile 默认开启 HMR，保存 patch 后运行中的实例会重新组合并加载该行；如果没生效，重启 DSH。

### 方式二：作为 profile bundle 安装

`cordis.patch.yml` 已按 bundle 规范声明了一份插入行：

```powershell
dsh plugin --profile desktop add link:E:\mygit\dsh-400
```

bundle 方式会在 profile 的 `package.json` 里留下依赖，适合长期分发；本机自用建议用方式一。

## 配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后插件只记一条 info 日志，不注册监听器。 |
| `delayMs` | `5000` | 重跑前的等待毫秒数，`0` 表示立即重跑。 |
| `maxRetries` | `12` | 每个 `会话:轮次:步骤` 的重试上限，`0` 表示不重试。 |
| `statuses` | `[400]` | 参与匹配的 HTTP 状态码；空数组表示不按状态过滤。 |
| `codes` | `['INVALID_REQUEST']` | 参与匹配的失败码；空数组表示不按失败码过滤。 |
| `matchPattern` | `upstream\s+error\s*\(\s*request\s*id` | 大小写不敏感的正则表达式源串，匹配失败消息。 |

未知键、越界数值、非法正则都会让插件在加载时报错，而不是静默忽略。

## 与 `dsh-llm-retry` 的关系

`dsh-llm-retry` 是 provider 路由上的重试执行器，策略写在每个 provider 的 `retryPolicy` 里。本插件是同一瀑布流里排在它之后的补充规则，专门覆盖它按设计放弃的 400 上游错误：

- 目标错误码不在 provider 的 `retryableCodes` 里 → `dsh-llm-retry` 调用 `next()`，本插件接手。
- provider 配置成 `mode: always` → `dsh-llm-retry` 先重试，本插件不会重复触发。
- 也可以不用本插件，直接把 provider 的 `retryableCodes` 加上 `INVALID_REQUEST`；代价是所有 400（模型不存在、参数错误等）都会被重试，且延迟走指数退避而不是固定 5 秒。

## 验证

```powershell
# 单元测试：匹配规则、预算、取消、卸载、非法配置（不依赖 DSH 运行实例）
node test/plugin.test.mjs

# 集成测试：在真实 Cordis 运行时上挂载插件并派发 agent/request-error 瀑布流
node test/integration.test.mjs

# 校验 patch 文件结构（需要 ref/js-yaml，随仓库提供）
node scripts/validate-patch.mjs "$env:DSH_PROFILE_DIR\cordis.patch.yml" --expect-row
```

`ref/` 是从本机 DeepSeek Harness 安装包里抽出的 Cordis / js-yaml 副本，只供离线测试使用，不参与插件运行；插件自身零运行时依赖。想重新抽取时用 `tools/asar.mjs`。

真实环境验证：出现该错误后，运行日志里会出现 `llm-retry-upstream-400: upstream 400 from provider "yjs" at turn 1 step 1; retry 1/12 in 5000ms`，同一轮次在 5 秒后重新发起请求。

## 文件结构

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 插件本体（纯 ESM，零依赖）：配置校验、匹配、可取消等待、重试决策 |
| `cordis.patch.yml` | 作为 profile bundle 安装时使用的插入行 |
| `scripts/install.mjs` | 把受管插入行写入/移除 profile 的 `cordis.patch.yml`，自动备份 |
| `scripts/validate-patch.mjs` | 离线校验 patch 结构与插件行 |
| `test/plugin.test.mjs` | 单元测试（14 项） |
| `test/integration.test.mjs` | 真实 Cordis 运行时集成测试（6 项） |
| `tools/asar.mjs` | 从 `app.asar` 列举/抽取参考文件的小工具 |


## 已知边界

- 只在 agent loop 的步骤边界重试；直接调用 `ctx.llm.stream()` 的消费者仍是单次尝试。
- 重启进程后重试预算清零（计数保存在内存里），一次崩溃的轮次本来也不会被恢复执行。
- 匹配的是消息文本和状态码；网关若改变错误文案，需要调整 `matchPattern`。
- `lib/index.js` 为纯 ESM、无运行时依赖；移动仓库后 `file:` 行会失效，重新执行安装脚本即可。
