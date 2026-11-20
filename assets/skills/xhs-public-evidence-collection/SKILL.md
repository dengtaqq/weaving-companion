---
name: xhs-public-evidence-collection
description: 用户提供小红书公开主页或笔记链接，并要求采集可见资料或支持账号诊断时使用；无需先关联商家，只有保存链接或普通文案创作时不触发。
---

# 小红书公开资料取证

## 目标

把用户提供的公开链接转换为有来源、采集时间和可见范围的证据。此 Skill 只负责取证，不直接给出正式经营诊断。

## 采集边界

1. 确认用户要分析的链接，区分主页、单篇笔记与参考账号；未关联商家时先把证据归当前会话。保存链接不等于已经读取页面；账号昵称不能代替稳定账号标识。
2. 本轮有 `public_page_collect` 时，仅对用户明确给定的小红书公开主页或笔记 URL 调用。分析账号主页且当前工具参数包含 `includeRecentNotes` 时传 `true`，让 Host 从主页实际展示的卡片中依次读取最多 5 篇不同笔记详情及其实际加载的可见评论；用户只给单篇笔记时不扩大到其他笔记。若当前工具没有该参数，照常采集用户给定的单页，并说明此轮不能自动读取前 5 篇；不要试探未知参数或自行拼造笔记 URL。由 Host 打开受控 Chrome：当前会话在工作台完成“打开 Chrome 登录 → 用户确认 → Host 验证目标页”后，优先使用该会话的独立授权目录；否则可使用启动前显式配置的 `ZHIBAN_XHS_AUTH_PROFILE_DIR`，再否则默认无登录态。Skill 不能配置浏览器、读取 Cookie、代替用户登录或扩大工具权限；不要用任意 HTTP、Shell 或其他浏览器操作绕过边界。
3. 先检查主页的 `status`、`errorCode`、`evidenceId`、`collectedAt` 和 `accessMode`。工具返回 `notes` 时，逐篇核对 `status`、`errorCode`、`evidenceId`、`commentSectionVisible` 和可见文字；只对 `COLLECTED` 或有正文的 `LIMITED` 证据调用 `evidence_get` 分段读取。`notes` 缺失表示当前工具只返回单页；`notes` 为空表示本次未取得笔记详情，两者都不能写成已覆盖前 5 篇。若主页已成功但此前漏传 `includeRecentNotes`，可在同一 Run 对同一主页 URL 补调一次；仍为空就报告缺口，不直接用卡片链接调用工具。`BLOCKED`、`FAILED` 不能当成已取得内容。`AUTH_PROFILE_UNAVAILABLE` 表示授权目录缺失或被占用，应告知用户检查本机配置并关闭占用该目录的 Chrome；`ACCESS_RESTRICTED` 表示登录或风控限制，不能声称重新登录后一定能采集。
4. 只记录页面实际可见的主页介绍、笔记正文、发布时间、互动信息和已加载的评论区摘录。仅当 `commentSectionVisible: true` 且相应证据正文确有评论区摘录时，才说该篇读到了可见评论；字段缺失、为 `false` 或只有评论入口时，标记评论未确认。若主页不足 5 篇、卡片未提供可用链接、详情或评论不可见，明确报告实际覆盖数和缺口；不能把前 5 篇说成账号全部历史，也不能把可见评论说成全部评论。没有显示的指标、隐藏内容和经营数据标为不可得。
5. 每项观察对应证据 ID、原始 URL、采集时间、访问方式和可见范围。受控工具失败时保留失败状态，可引导用户使用会话页的“小红书本机授权”入口；用户确认后，工作台会复核目标页并另起一轮 Agent Run 继续采集。不能索取密码、验证码、Cookie，也不能把授权窗口打开、用户点击确认或新 Run 受理当成采集成功；最终仍以 `public_page_collect` 的实际状态为准。

## 交付

研究文案和图片风格时，工具提供includeImages且本轮支持图片采集才传true。Host仅截取实际加载的主页封面或笔记当前主图并登记为证据素材，不下载全部原图或遍历轮播。工具回执的deliveredImages按像素顺序列出实际送给本模型的截图；只有这些图片才可用于图片风格结论，引用artifactId并保留页面evidenceId。imageInputStatus=UNAVAILABLE、NO_VISIBLE_IMAGES或存在imageCaptureError时说明能力和素材缺口，不把images元数据当作看图。evidence_get(includeImages=true)只回读已有截图，不会扩大采集范围。同Run先保存文字后要求图片时旧证据保持不变，未取得截图就明确缺口，下一轮再采集。

输出可供账号诊断使用的证据 ID、覆盖范围和缺口。公开页面观察不得写入人工确认档案；需要长期保存的候选事实先交用户核对。

Skill 正文和允许使用的工具列表按 Run 冻结；旧 Run 不会自动改用新版 Skill。用户要求补读笔记时，在更新后的 Host 里发送新消息开启新 Run，并以新一轮实际返回的证据为准。
