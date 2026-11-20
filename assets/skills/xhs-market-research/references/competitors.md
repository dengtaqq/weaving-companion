# 竞品内容差异

先从本轮冻结的 `COMPETITOR` 目录条目选对标来源，调用 `merchant_source_collect(sourceType="CATALOG", sourceId=条目ID)`。本商家已登记账号链接时调用 `merchant_source_collect(sourceType="LINK", sourceId=链接ID)`；用户本轮直接给出的主页仍可用 `public_page_collect`。仅比较身份、地域和业务有依据的账号；昵称相似不能证明同一账号。

分别列出双方实际取得的主页与笔记样本数、时间范围和证据 ID，按目标人群、主题覆盖、标题切入、内容形式、卖点表达和公开可见互动比较。输出“对方覆盖而本方未观察到的角度”“本方可复用的优势”“不适合照搬的做法”及取舍理由。样本不足、发布时间或互动指标不可比时不计算差异百分比或统一分数；最多给定性差异和待补证据。可见互动不等于成交或经营效果。

有 `researchScope` 时只采集其中勾选的本方账号与竞品来源；缺少任一方内容时保存空候选及缺口，不凭印象补出差异。结构化候选 `kind="COMPETITOR_DIFFERENCE"`，`details` 保存 `dimension`、`observation`、`ownEvidenceIds`、`competitorEvidenceIds`；双方证据集合须互不重叠且均包含在候选 `evidenceIds` 中。竞品账号是来源，差异是本次研究判断，不能把差异建议保存成另一个竞品账号。`merchantRelevance` 和 `contentAngle` 说明本商家是否具备借鉴条件以及具体做法，避免只总结对方。
