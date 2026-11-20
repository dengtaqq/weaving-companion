# 源码导航

找功能时先从业务名称进入：商家资料看 `merchants`，研究与选题看 `research`，图文创作与审核看 `publication`。只有排查 Agent 执行、上下文和工具调用时，才进入 `runtime`。

研究子专家入口是 `runtime/delegation/delegation-service.ts` 的 `researcher` V3委派，固定契约 `researcher.report.v1`；资产与工具上限在 `assets/experts/merchant-content-team/researcher.md` 和 `group-v2.json`。`research-memory.ts` 负责证据观察、版本化笔记和mixed请求投影，SQLite Worker校验父子尝试与取消后持久化，独立于商家记忆。

小红书研究按 `payload.focusAreas` 指定话题样本、文案或图片风格。`public-page-collector.ts` 从实际内容图片元素截取当前显示的像素；`public-page-images.ts` 保存Blob，经证据事务登记 `public_reference_image` 素材并在模型支持视觉时发送有界图片回执。`research-memory.ts` 只接纳真实送达截图的引用，`IMAGE_STYLE` 结论缺少已看图引用时拒绝提交。有限样本、截图和用户采用分别处理，采集不授予原图使用权、不自动写入商家记忆。

后台研究沿 `delegate_task → research-agent-store.createBackgroundResearch → TextGenerationService → SessionService → 正式研究委派 → completeResearchJob → RESEARCH_CONTINUATION Run` 执行。受理、原结果和续执行任务均持久化，同会话串行；原用户代际、原能力快照及来源在受理、外发和提交时复核。续执行保留主历史，通过 `publication_task` 进入既有图文链路，研究判断作为资料传递，不改写原用户事实；根任务预算沿研究和后续业务继承。

当前采用 **按业务模块组织的单体架构，并逐步明确轻量 DDD 边界**。这份文档说明现有代码的位置与职责；安装配置见[项目 README](../README.md)，开发约定见[AGENTS.md](../AGENTS.md)，功能与运行行为以当前实现为准。

## 先认识三层

配置入口：`scripts/start-host.mjs` 先读取根目录 `.env`，补齐系统用户密钥后进入 Host；`main.ts` 经 `loadConfig` 合并本机加密模型配置。`model/save-model.ts` 同样读取 `.env`，取得写租约后加密保存；显式进程变量优先。直接执行 `dist/host/main.js` 不经过启动脚本的配置加载链。

| 目录 | 负责什么 | 从哪里开始 |
| --- | --- | --- |
| [host](./host/) | 本机执行、授权、归属校验、持久化及外部能力接入 | [main.ts](./host/main.ts) 组装依赖和启动服务；[config.ts](./host/config.ts) 读取配置 |
| [renderer](./renderer/) | Web 展示、输入、状态恢复和 API 调用 | [index.html](./renderer/index.html) → [app/main.tsx](./renderer/app/main.tsx) |
| [shared](./shared/) | Host 与 Web 共用的接口数据、状态、Schema 及必要的契约辅助方法 | [contracts.ts](./shared/contracts.ts) 及按业务命名的契约文件 |

`shared` 的定位是跨端契约。Host 的数据库访问、权限判断、任务推进和内部领域规则应留在所属 Host 模块；页面不能以共享类型或提示词代替 Host 的真实校验。

```text
src/
├─ host/
│  ├─ main.ts / config.ts       启动与配置
│  ├─ http/                    HTTP 服务、配对、事件推送
│  ├─ model/                   本机模型配置命令
│  ├─ modules/                 按业务组织的代码
│  │  ├─ sessions/             会话受理、清理、任务与历史持久化
│  │  ├─ merchants/            商家记忆与归档总结
│  │  ├─ research/             公开取证、研究报告、采用库与选题
│  │  ├─ publication/          文案、图文编排、审核、返修与导出
│  │  ├─ media/                图片任务与 Provider 接入
│  │  ├─ capabilities/         Skill、专家资产与版本配置
│  │  └─ workbench/            排期、素材、工作台汇总与发布登记
│  ├─ runtime/                 Agent 执行底座
│  │  ├─ execution/            Run 调度、冻结计划、异步结果解析
│  │  ├─ context/              输入、提示词和任务要求装配
│  │  ├─ history/              历史投影、工具正文清理、token 计量
│  │  ├─ tools/                工具目录与重放规则
│  │  ├─ delegation/           子 Agent 委派及提交契约
│  │  ├─ ports/                调度器使用的运行接口
│  │  └─ adapters/pi/          Pi SDK 的具体适配
│  └─ infrastructure/          跨业务使用的基础设施
│     ├─ sqlite/               Worker 通信、连接、事务和迁移
│     ├─ files/                受管文件、Blob 和运行快照
│     ├─ security/             本机密钥存储
│     └─ audit/                审计日志
├─ renderer/
│  ├─ index.html               Web 入口，加载 /app/main.tsx
│  ├─ app/                     页面组装、主工作台及全局样式
│  ├─ features/                chat、merchants、research、publication、settings、dashboard
│  ├─ components/              通用 UI 和 Markdown 展示
│  └─ api/                     Host API 客户端
└─ shared/                     两端共用契约
```

## 按业务找 Host 代码

| 要修改的业务 | 主要入口与相关文件 | 当前边界 |
| --- | --- | --- |
| 会话与 Run 受理、归档清理、接续和任务额度 | [session-service.ts](./host/modules/sessions/application/session-service.ts)、[session-purge-service.ts](./host/modules/sessions/application/session-purge-service.ts)、[sessions/infrastructure](./host/modules/sessions/infrastructure/) | 受理层协调数据库、工作区和队列；Run 实际执行在 `runtime/execution`；部分基础 CRUD 与事务仍在 `db-worker.ts` |
| 商家记忆、归档总结及人工确认 | [memory-service.ts](./host/modules/merchants/application/memory-service.ts)、[memory-store.ts](./host/modules/merchants/infrastructure/memory-store.ts) | 此模块当前聚合记忆相关实现；商家档案、商品、链接的基础 CRUD 仍在 `server.ts` 和 `db-worker.ts`，并未全部迁入 |
| 商家记忆检索与可选向量 | [memory-retrieval.ts](./host/modules/merchants/domain/memory-retrieval.ts)、[memory-search-service.ts](./host/modules/merchants/application/memory-search-service.ts)、[memory-embedding-store.ts](./host/modules/merchants/infrastructure/memory-embedding-store.ts) | 冻结集合内 BM25；可选兼容 Embedding 接口、余弦排序及 RRF 融合；SQLite 缓存精确版本，服务异常回退，取消及额度错误传播 |
| 记忆审核、商品范围与历史正文过滤 | [memory-scope.ts](./host/modules/merchants/domain/memory-scope.ts)、[memory-panel.tsx](./renderer/features/merchants/memory-panel.tsx) | 人工审核与归属明确后可用；商品 ID 和可选精确依据版本在快照冻结前过滤，模型请求及压缩前过滤旧工具正文 |
| 公开采集、登录续采、研究报告与选题 | [public-page-collector.ts](./host/modules/research/infrastructure/public-page-collector.ts)、[xhs-search-collector.ts](./host/modules/research/infrastructure/xhs-search-collector.ts)、[xhs-login-service.ts](./host/modules/research/infrastructure/xhs-login-service.ts)、[research-report.ts](./host/modules/research/application/research-report.ts)、[public-diagnosis-report.ts](./host/modules/research/application/public-diagnosis-report.ts)、[research-store.ts](./host/modules/research/infrastructure/research-store.ts)、[topic-store.ts](./host/modules/research/infrastructure/topic-store.ts) | 平台链接、已采集证据、模型候选和人工采用版本分别保存；研究和选题执行复用既有 Run |
| 文案生成、同篇对话、图文审核、局部返修与 ZIP | [publication-routes.ts](./host/modules/publication/interfaces/publication-routes.ts)、[publication-tool.ts](./host/modules/publication/interfaces/publication-tool.ts)、[text-generation-service.ts](./host/modules/publication/application/text-generation-service.ts)、[publication-conversation.ts](./host/modules/publication/application/publication-conversation.ts)、[publication-conversation-store.ts](./host/modules/publication/infrastructure/publication-conversation-store.ts)、[publication-zip.ts](./host/modules/publication/infrastructure/publication-zip.ts) | HTTP 与 Agent 工具接入同一持久任务链；草稿、审核、费用确认和最终导出各有版本与回执 |
| 图片生成、参考图修改、未知结果对账 | [generation-service.ts](./host/modules/media/application/generation-service.ts)、[image-media-port.ts](./host/modules/media/infrastructure/image-media-port.ts)、[image-input.ts](./host/modules/media/infrastructure/image-input.ts)、[generation-store.ts](./host/modules/media/infrastructure/generation-store.ts) | 图片任务与外部调用在此管理；图文中的图片采用和编排仍归 `publication`。`image-media-port.ts` 同时包含接口和具体 Provider 实现，因此放在基础设施层 |
| Skill 安装、专家配置、版本与运行快照 | [capability-routes.ts](./host/modules/capabilities/interfaces/capability-routes.ts)、[capability-registry.ts](./host/modules/capabilities/application/capability-registry.ts)、[skill-package.ts](./host/modules/capabilities/application/skill-package.ts)、[capabilities/infrastructure](./host/modules/capabilities/infrastructure/) | 管理实际可用资产、配置与版本；运行时按受理时冻结的快照读取 |
| 工作台汇总、人工排期、商家素材与发布登记 | [workbench-routes.ts](./host/modules/workbench/interfaces/workbench-routes.ts)、[workbench-store.ts](./host/modules/workbench/infrastructure/workbench-store.ts) | 排期是人工工作安排；发布登记记录用户确认的链接与反馈，下载 ZIP 不代表已向平台发布 |

图文模块中，`content-template.ts` 负责创作模板，`publication-expert.ts` 负责固定业务步骤与专家任务的衔接；具体存储、审核绑定、返修来源和交付文件在同模块的 [infrastructure](./host/modules/publication/infrastructure/) 下查找。

小红书采集的自动导航、点击、返回和滚动统一经过 [xhs-browser-actions.ts](./host/modules/research/infrastructure/xhs-browser-actions.ts) 的串行队列，每次操作前等待一秒，取消会跳过尚未执行的操作；搜索、公开页与登录服务共用这一入口。

## runtime 每个文件做什么

这里按运行职责分组，当前共 17 个 TypeScript 文件。

| 子目录 | 文件 | 职责 |
| --- | --- | --- |
| `execution` | [agent-task-manager.ts](./host/runtime/execution/agent-task-manager.ts) | 领取排队 Run，保持同会话串行，组织主任务及正式专家步骤的执行、取消、退出等待与持久终态；先保存事件再推送 |
| `execution` | [runtime-plan.ts](./host/runtime/execution/runtime-plan.ts) | 在受理时冻结模型参数、工具、Skill、专家和来源；计算稳定哈希并校验新旧 Plan，恢复时使用原版本 |
| `execution` | [async-result-summary.ts](./host/runtime/execution/async-result-summary.ts) | 解析异步业务结果的有限说明正文，限制返回结构；实际任务查询与调度另由服务和存储完成 |
| `context` | [context-assembler.ts](./host/runtime/context/context-assembler.ts) | 根据冻结 Plan 与本次 Attempt 来源，校验附件归属和哈希，装配模型输入及来源摘要 |
| `context` | [prompt-assembly.ts](./host/runtime/context/prompt-assembly.ts) | 从同一有序段落生成系统指令和不可变启动快照，让实际输入与页面查看保持同源 |
| `context` | [task-context.ts](./host/runtime/context/task-context.ts) | 计算任务要求摘要和版本引用，校验上下文容量，合并用户要求增量，判断执行依据是否仍有效 |
| `context` | [task-context-projection.ts](./host/runtime/context/task-context-projection.ts) | 按职责投影任务要求与成果索引，校验精确引用，为再次推理和压缩预留必要输入空间 |
| `context` | [task-focus.ts](./host/runtime/context/task-focus.ts) | 重建本轮请求提醒和停止后的接续上下文，在原文离开有效历史时补回完整用户要求 |
| `history` | [context-token-meter.ts](./host/runtime/history/context-token-meter.ts) | 统一上下文估算、窗口占比及前后比较，并将 Provider 实际报告与本地估算分开记录 |
| `history` | [main-history.ts](./host/runtime/history/main-history.ts) | 为主模型投影历史，收窄可识别的内部任务回合和工具正文，保留真实用户原话及成果回读入口 |
| `history` | [microcompact.ts](./host/runtime/history/microcompact.ts) | 在窗口压力下，把可验证的旧只读工具正文替换为精确来源引用，保护近期批次与冻结权限 |
| `tools` | [tool-catalog.ts](./host/runtime/tools/tool-catalog.ts) | 定义传给 Pi 的工具目录、Schema 与执行适配，校验会话和商家边界并连接具体业务能力 |
| `tools` | [tool-replay-policy.ts](./host/runtime/tools/tool-replay-policy.ts) | 区分本地只读与幂等任务工具，决定启动恢复和上下文溢出回滚时能否自动重放 |
| `delegation` | [delegation-service.ts](./host/runtime/delegation/delegation-service.ts) | 管理父 Run 与子 Agent 的持久委派、输入、回答、调整、取消和提交生命周期 |
| `delegation` | [expert-contracts.ts](./host/runtime/delegation/expert-contracts.ts) | 定义专家任务与提交 Schema 和按 contractId 选择的 Few-shot 示例；校验示例、输出、材料引用、完成标准及待回答问题 |
| `ports` | [pi-runtime-port.ts](./host/runtime/ports/pi-runtime-port.ts) | 定义调度器使用的启动、执行、事件、快照、等待、取消、压缩和释放接口 |
| `adapters/pi` | [pi-sdk-adapter.ts](./host/runtime/adapters/pi/pi-sdk-adapter.ts) | 实现运行接口，连接 Pi 会话、模型、受控工具、事件、用量、历史和快照；保留旧适配器版本的兼容分支 |

## HTTP、数据库与文件基础设施

| 位置 | 职责与维护注意点 |
| --- | --- |
| [http/server.ts](./host/http/server.ts) | 创建 Fastify 服务、配对/同源/CSRF 检查、注册模块路由，同时保留尚未拆出的业务端点 |
| [http/pairing.ts](./host/http/pairing.ts)、[http/event-hub.ts](./host/http/event-hub.ts) | 本机浏览器配对与会话凭证；持久事件的实时推送入口 |
| [infrastructure/sqlite/db-client.ts](./host/infrastructure/sqlite/db-client.ts) | Host 向数据库 Worker 发送操作并接收结果，保持异步调用边界 |
| [infrastructure/sqlite/db-worker.ts](./host/infrastructure/sqlite/db-worker.ts) | Worker 内的 SQLite 连接、事务和操作分发；仍包含会话、商家等业务操作，业务存储方法由此调用 |
| [infrastructure/sqlite/migrations.ts](./host/infrastructure/sqlite/migrations.ts) | 数据库结构的有序迁移；源码搬迁本身不要求新增数据库版本 |
| [infrastructure/files/files.ts](./host/infrastructure/files/files.ts) | 数据目录、工作区、Blob、暂存文件、快照、目录约束与启动租约 |
| [infrastructure/security/secret-store.ts](./host/infrastructure/security/secret-store.ts) | 本机模型密钥的加密存储与解锁 |
| [infrastructure/audit/audit.ts](./host/infrastructure/audit/audit.ts) | 记录关键操作与运行结果的审计日志 |
| [model/save-model.ts](./host/model/save-model.ts) | 保存本机文本模型配置的命令入口，复用密钥存储 |

数据库同步读写继续在 Worker 内执行。把业务存储文件放进 `modules/*/infrastructure` 后，最终归属、版本、状态和事件仍须在原事务中一起复核和保存；不要把一个原子操作拆成几次跨 Worker 请求。

源码的 `host/runtime` 与用户数据的 `.data/runtime` 用途不同。`ZHIBAN_DATA_DIR` 默认指向 `.data`，其中 `runtime/pi-agent/sessions` 保存真实运行文件；源码目录整理不会要求迁移或改名这些数据。运行数据的目录约定由 `FileStore` 管理。

## 按页面找 Renderer 代码

| 目录 | 文件与职责 |
| --- | --- |
| [app](./renderer/app/) | `main.tsx` 组装路由、配对、主工作台和会话交互；`styles.css`、`workbench.css` 保存现有全局样式 |
| [features/chat](./renderer/features/chat/) | `session-sidebar.tsx` 会话列表；`session-draft.ts` 待发草稿键；`context-token-panel.tsx` 上下文计量；`prompt-snapshot-panel.tsx` 启动指令快照 |
| [features/merchants](./renderer/features/merchants/) | `merchant-page.tsx` 商家档案；`products-page.tsx` 商品；`merchant-content-start.tsx` 商家创作入口；`memory-panel.tsx` 记忆与归档总结；`media-library.tsx` 商家素材维护及选择 |
| [features/research](./renderer/features/research/) | `research-panel.tsx` 研究报告、候选与采用；`topic-panel.tsx` 选题卡和后续创作入口 |
| [features/publication](./renderer/features/publication/) | `content-studio.tsx` 图文工作台；`content-conversation.tsx` 同篇对话；`content-draft-panel.tsx` 草稿；`chat-publication-results.tsx` 普通聊天内的任务结果；`publication-editor.tsx` 编辑与编排；`publication-preview.tsx` 成品预览；`publication-record-form.tsx` 人工发布登记；`task-context-panel.tsx` 本篇要求；`image-generation-panel.tsx` 图片任务；`image-reconcile-modal.tsx` 未知结果对账 |
| [features/settings](./renderer/features/settings/) | `capabilities-page.tsx` 能力目录加载；`experts-page.tsx` 专家；`skills-page.tsx` 方法包；`model-picker.tsx` 当前模型配置展示 |
| [features/dashboard](./renderer/features/dashboard/) | `dashboard-page.tsx` 排期、内容进度及继续工作入口 |
| [components](./renderer/components/) | `ui.tsx` 通用图标与弹窗；`assistant-markdown.tsx` 多页面共用的 Markdown 展示 |
| [api/client.ts](./renderer/api/client.ts) | 统一调用 Host，携带同源凭证、CSRF、幂等键并转换错误 |

2026-10-24 将 31 个 Renderer 文件归入这些目录，更新 97 处 import 路径，HTML 改为加载 `/app/main.tsx`；API 客户端路径保留。这次目录调整的变化限于入口、引用和 import 排序/格式，后续功能修改的验收记录见相应提交说明与交付报告。

## 典型调用链

1. **普通消息**：Renderer `api/client.ts` → `http/server.ts` → `SessionService` → `DbClient` / Worker 冻结消息与 Run → `AgentTaskManager` → `context-assembler` → `PiRuntimePort` / `PiSdkRuntimeAdapter`。结果与事件先持久化，再由 `EventHub` 推送给页面。
2. **图文任务**：页面 `publication-routes.ts` 或 Agent `publication-tool.ts` → 同一图文任务与步骤记录 → `TextGenerationService` 接入既有会话 Run → 草稿、编排、审核或返修结果写回原任务。图片任务交给 `GenerationService`；`publication-preview.tsx` 在普通聊天和图文工作台共用复制与导出入口，人工确认草稿和编排双版本后由原导出链生成固定版本 ZIP，收到回执才发起下载。
3. **商家归档总结**：会话归档受理 → 按逐消息 Run 快照冻结商品来源 → `MemoryService` 使用冻结输出额度读取授权来源并产生候选 → 格式或引文来源失败时在同一 Attempt 内最多纠正一次 → `memory-store.ts` 事务核验来源与角色，保存待审核的短期总结和长期候选 → `memory-panel.tsx` 人工核对归属与正文后 CAS 确认。混合商品总结不自动归入商家通用，“记住”也只生成候选。独立 DeepSeek 总结通过 `PiSdkRuntimeAdapter` 的专用选项关闭思考，普通聊天沿原请求契约。
4. **商家记忆检索**：`loadConfig` 校验可选向量三项 → `SessionService` 将无密钥的策略冻结到 `RuntimePlan.runtime.memorySearch` → `AgentTaskManager` / `DelegationService` 注入同一检索服务 → `merchant_memory_search` 在原商家快照内执行 BM25 或混合召回 → 每个实际 Embedding 请求预留并结算原任务模型额度 → Worker 以记忆 ID、版本、哈希和服务模型指纹缓存 Float32 BLOB。子计划和研究续执行继承原策略；旧计划缺省字段保留原算法。查询向量不落库，缓存不改写记忆或审批状态，删除记忆版本时派生缓存由外键级联清理。服务回退原因保留在工具结果 `details.memorySearch`，不记录服务返回正文或密钥。

定位问题时沿“页面 → API/工具 → 应用流程 → Worker 内业务存储 → 数据/事件”查找，再按需要进入运行底座。`runtime` 与业务模块当前仍有双向调用，目录分组不代表依赖关系已经全部解耦。

商品记忆范围由 Worker 从文字任务的 `source.product` 或原草稿创作来源推导，不能由模型任意指定。`isMemoryApplicable` 在冻结记忆引用前排除未审核、未分类及不适用版本；默认上下文、检索、按 ID 回读及子任务复用该快照。V44 的 `memory_scope_json` 纳入新快照哈希，旧快照不补字段改写原哈希。旧快照若带记忆而无新范围，执行入口明确拒绝并提示重新发起。`projectMemoryHistory` 对历史 `merchant_memory_search/get` 工具正文核对本轮精确引用，保留原历史文件及工具调用配对；它不重写旧助手自然语言或既有压缩摘要。

## 轻量 DDD 的放置规则与现阶段限制

| 层 | 新逻辑放在哪里 | 现有例子 |
| --- | --- | --- |
| `domain` | 无数据库、文件或 Provider 调用的业务规则、结构校验和状态计算 | [content-output.ts](./host/modules/publication/domain/content-output.ts) 区分正文与内部说明；[publication-repair.ts](./host/modules/publication/domain/publication-repair.ts) 校验补丁范围和原文定位 |
| `application` | 完成一个业务目标所需的流程协调，连接存储、运行服务和外部能力 | `SessionService` 受理消息并唤醒队列；`TextGenerationService` 将持久文案任务接入 Run |
| `infrastructure` | SQLite、文件、浏览器、Provider 及与这些能力耦合的实现 | 模块内的 `*-store.ts`、图片 Provider、采集器和 ZIP 生成 |
| `interfaces` | HTTP 路由或 Agent 工具入口，解析请求并调用相同业务能力 | `publication-routes.ts` 与 `publication-tool.ts` |

只有存在对应职责时才建立这一层。当前 `domain` 仅在图文模块落下两份已有纯规则，其他模块按现有代码分组；`publication-review-contract.ts` 包含实际 SQL 查询，因此仍放在 `infrastructure`。目录名称不等于完整 DDD 已实现。

后续拆分应围绕真实职责和事务边界逐步进行：

- `db-worker.ts` 仍同时承载基础设施分发、基础 CRUD 与部分业务规则；可以继续提取模块操作，但要保留事务原子性。
- `http/server.ts` 仍有较多业务端点；已有 `publication`、`capabilities`、`workbench` 路由可作为进一步归位的参考。
- `renderer/app/main.tsx` 仍包含主页面的大量状态与交互；本轮完成目录归组，页面拆分尚未实施。
- `publication-conversation-store.ts` 等存储文件仍含流程推进和版本判断；下一步需辨认哪些可提取为纯规则、哪些必须在事务中最终校验。
- `runtime` 中的调度器、工具目录和适配器仍连接具体业务模块；新的抽象应服务于明确的替换或复用需求，避免为分层增加空接口。

涉及代码变更时，同步核对本文的实际落点及项目 README 的运行说明，并在交付报告中记录接口、版本、归属和持久状态的实际验证结果与限制。
