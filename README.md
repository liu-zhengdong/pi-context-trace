# pi-context-trace

Pi 的本地上下文快照与可视化插件。通过官方 `before_provider_request` 事件捕获 provider 已组装的请求内容；界面参考 [claude-tap](https://github.com/liaohch3/claude-tap) 的请求列表、折叠卡片和相邻请求比较方式，独立实现。

## 使用

需要 Node.js 24+ 和 Pi 0.85.1+。

```bash
pi install npm:pi-context-trace
```

本地开发安装：`npm ci --ignore-scripts && npm run build && pi install .`；修改源码后重新构建并 `/reload`。

重启 Pi（或 `/reload`）后：

- `/trace on`：开启监听，启动本地查看器并自动打开浏览器，同时显示地址。
- `/trace off`：停止接收新快照，等待已捕获内容保存完成。查看器保持可用。
- `/trace ui`：启动或复用查看服务并打开浏览器，不改变监听开关。
- `/trace path`：显示 SQLite 路径。
- `/trace`：查看状态与帮助。

默认关闭监听。退出、重载或切换 Session 时释放服务并关闭监听；需要时再次 `/trace on`。查看器优先使用固定地址 `http://127.0.0.1:4318`；只有端口被占用时，才改用系统分配的空闲端口，并显示、打开实际地址。服务存续期间复用同一地址，始终只绑定 `127.0.0.1`。

自动打开浏览器仅在交互式 TUI 模式执行，支持 macOS、Windows 和 Linux；失败时提示手动访问地址，监听继续运行。RPC、JSON 和 print 模式仅启动服务，不打开宿主机浏览器。

默认数据：`~/.pi/context-trace/trace.sqlite`。可用 `pi --context-trace-dir /absolute/path` 修改。快照跨重启保留；不会自动删除历史。

## 查看内容

- 按 Session 浏览请求；请求时间、模型、消息数和原始 JSON 字节数。
- 顶部标签直接切换：**消息（默认）**、系统指令、工具、生成参数、本次输出、与上次比较、原始 JSON。消息保留请求中的顺序及字段路径；查看消息无需经过工具列表。
- 分类标签显示项数，搜索时显示「匹配项 / 总项数」，切换分类继续查看结果。导航吸顶，窄屏可横向滚动；标签支持左右方向键、Home / End 切换。切换请求保留当前分类，全部展开/收起只作用于当前视图。
- 折叠/展开原文和完整原始字段，全文搜索当前请求，复制/导出完整 payload。原始 JSON 采用类似浏览器开发者工具的对象树，支持对象/数组逐层展开、类型着色、批量展开/收起、长字符串展开及搜索自动展开。大对象按需加载，每次展示 100 项，可继续展开全部内容。
- 与**同一 Session 上一条捕获请求**比较：系统指令、工具与参数的前后对照；消息的新增、移除、未变项。修改表示为移除旧项、增加新项，不推断变更原因。
- 浅色/深色主题、键盘上下切换请求、跟随最新请求、历史分页。
- `message_end` 提供的最终 AssistantMessage 与 usage。它是 Pi 的逻辑输出，界面明确注明来源；不是原始响应流。

上下文组成条按各部分序列化内容的字符数计算，用来观察体积比例；不是 token 估算。Token 数字只取自 Pi 的 usage，不凭字符猜测。

## 捕获边界

`context` → provider 组装 payload → **`before_provider_request`** → 传输。

因此能观察 experience 等上下文插件处理后的内容。插件监听只读，返回 `undefined`；不会修改模型请求、添加 Agent 工具或调用模型，也不修改 `fetch`、代理、TLS 或 WebSocket。

监听器按插件加载顺序运行。如果其他插件在后面的 `before_provider_request` 中重写 payload，本快照不包含后续重写；请将本插件放在这些插件之后。HTTP 重试可能复用同一 payload，不一定每次重试都触发事件。WebSocket 传输层的增量缓存编码也不属于此快照。自定义 provider 必须遵守 Pi 的 onPayload 约定。

只记录 `/trace on` 期间发生的事件，不能还原安装前或未监听时的实际请求。`/trace off` 后不再记录输出；在请求中途关闭时，已保存请求可能没有对应输出。

## 实现

TypeScript 扩展 + Node 原生 HTTP/SQLite/zlib + 原生浏览器 UI。新增运行时依赖为零，Pi 本身为 peer dependency。前端使用 esbuild 打包。

在事件回调中立即 JSON 序列化，冻结观察时刻；随后串行执行异步 gzip 和 SQLite 保存。不会截断原文。记录失败会暂停捕获并显示错误，不中断正常模型调用。后台任务不持有 Pi ctx，避免 session 更换后使用失效上下文。

数据仅保存在本机，文件权限为 0600；查看器只读并校验 Host/Origin。界面用文本节点显示捕获内容，payload 中的 HTML 不会执行。完整 payload 含对话与代码，按原文保存，不承诺自动识别其中的敏感文本。

## 发布维护

自动发布与首次 OIDC 配置见 [npm 发布](docs/publishing.md)。

## 开发与验证

```bash
npm install
npm run check   # 全量类型检查、测试、构建、Biome、Knip
npm run preview # 临时示例库；退出时清理，不混入用户历史

# 浏览器回归（仅开发依赖，不影响插件运行）
npx playwright install chromium # 首次安装测试浏览器
npm run test:ui
# 也可复用本机 Chrome：PI_CONTEXT_TRACE_BROWSER_CHANNEL=chrome npm run test:ui
```

浏览器自动回归使用临时 SQLite 示例库，覆盖大量工具下的默认消息视图、分类切换、跨分类搜索计数、输出到达更新、折叠状态、键盘导航、差异与导出，以及窄屏深浅主题布局。

测试使用本地模拟 API 与真实 Pi SDK，对照实际收到的 HTTP body 和保存的快照；覆盖 context 注入、开关、重载、输出关联、原文完整性、消息 diff、分页、存储失败和本地访问边界。浏览器人工验收覆盖展开/收起、搜索、差异、JSON、深浅主题。
