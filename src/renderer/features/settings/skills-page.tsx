import { type ChangeEvent, useEffect, useRef, useState } from "react";
import {
  CAPABILITY_ROLES,
  type CapabilityCatalog,
  type CapabilityRole,
  SKILL_PACKAGE_LIMIT,
  type SkillCatalogItem,
  type SkillDetail,
  type SkillPackageFile,
} from "../../../shared/capabilities.js";
import * as api from "../../api/client.js";
import { AssistantMarkdown } from "../../components/assistant-markdown.js";
import { Icon, Modal } from "../../components/ui.js";

const roleNames: Record<CapabilityRole, string> = {
  main: "基础助手",
  writer: "写作专家",
  visual: "视觉专家",
  reviewer: "审核专家",
  researcher: "研究专家",
};

/** 管理真实内置/自上传方法，预览与安装分开，旧版本可查看和回滚。 */
export function SkillsPage({ catalog, refresh }: { catalog: CapabilityCatalog; refresh: () => Promise<void> }) {
  const [source, setSource] = useState("ALL");
  const [query, setQuery] = useState("");
  const [upload, setUpload] = useState(false);
  const [files, setFiles] = useState<SkillPackageFile[]>([]);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.previewSkill>> | null>(null);
  const [roles, setRoles] = useState<CapabilityRole[]>(["main"]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [filePath, setFilePath] = useState("SKILL.md");
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const pending = useRef(new Map<string, string>());
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);
  /** 在响应未知时复用同一安装/配置命令，避免产生重复版本。 */
  function commandKey(input: unknown): string {
    const signature = JSON.stringify(input);
    if (!pending.current.has(signature)) pending.current.set(signature, crypto.randomUUID());
    return pending.current.get(signature) as string;
  }
  /** 由浏览器显式选择文件，再交 Host 校验，不读取任意本机路径。 */
  async function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!selected.length) return;
    setBusy(true);
    setNotice("");
    setPreview(null);
    try {
      if (selected.length > 40 || selected.reduce((sum, file) => sum + file.size, 0) > SKILL_PACKAGE_LIMIT)
        throw Error("请选择不超过40个文档、总计不超过128 KB的 Skill 包。");
      const next = await Promise.all(
        selected.map(async (file) => {
          const relative = file.webkitRelativePath;
          const path = relative ? relative.split("/").slice(1).join("/") : file.name;
          const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
          return { path, content };
        }),
      );
      const checked = await api.previewSkill(next);
      setFiles(next);
      setPreview(checked);
      setRoles(catalog.skills.find((skill) => skill.name === checked.name)?.roles ?? ["main"]);
    } catch (error) {
      setFiles([]);
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  /** 确认已预览的完整版本，同时保存用户选择的专家关联。 */
  async function install() {
    if (busy || !preview) return;
    setBusy(true);
    setNotice("");
    const input = { files, roles, revision: preview.expectedRevision };
    try {
      const saved = await api.installSkill(files, preview.expectedRevision, roles, commandKey(input));
      await refresh();
      setUpload(false);
      setPreview(null);
      setFiles([]);
      setNotice(`已安装 ${saved.name} · v${saved.revision}。之后的新任务生效，已有任务保留原版。`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  /** 打开原文和文件目录，内置方法保留只读。 */
  async function openSkill(name: string) {
    setNotice("");
    try {
      const next = await api.getSkill(name);
      setDetail(next);
      setRoles(next.item.roles);
      setFilePath("SKILL.md");
    } catch (error) {
      setNotice(String(error));
    }
  }
  /** 启停与回滚使用预期版本，明确生成新版本后再刷新目录。 */
  async function update(
    skill: SkillCatalogItem,
    enabled: boolean,
    nextRoles: CapabilityRole[],
    rollbackRevision: number | null = null,
  ) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    const input = { expectedRevision: skill.revision, enabled, roles: nextRoles, rollbackRevision };
    try {
      const next = await api.updateSkill(skill.name, input, commandKey({ name: skill.name, ...input }));
      await refresh();
      if (detail?.item.name === skill.name) {
        const latest = await api.getSkill(skill.name);
        setDetail(latest);
        setRoles(latest.item.roles);
      }
      setNotice(`${skill.name} 已保存为 v${next.revision}，之后的新任务生效。`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  const visible = catalog.skills.filter(
    (skill) =>
      (source === "ALL" || skill.source === source) &&
      `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div className="page-content capability-page">
      <div className="page-heading">
        <div>
          <h1>把做事方法，沉淀成 Skill</h1>
          <p>使用内置方法，也可以上传自己的规则与参考资料，按任务关联专家。</p>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            setUpload(true);
            setNotice("");
            setPreview(null);
          }}
        >
          <Icon name="plus" />
          上传 Skill
        </button>
      </div>
      {notice && (
        <p className="studio-notice" role="status">
          {notice}
        </p>
      )}
      <input ref={fileInput} type="file" accept=".md" hidden onChange={(event) => void selectFiles(event)} />
      <input ref={folderInput} type="file" multiple hidden onChange={(event) => void selectFiles(event)} />
      <nav className="page-tabs" aria-label="Skill 来源">
        {[
          ["ALL", "全部"],
          ["BUILTIN", "内置"],
          ["UPLOADED", "我上传的"],
        ].map(([value, label]) => (
          <button
            type="button"
            key={value}
            className={source === value ? "active" : ""}
            onClick={() => setSource(value ?? "ALL")}
          >
            {label}
            <span className="count-badge">
              {catalog.skills.filter((skill) => value === "ALL" || skill.source === value).length}
            </span>
          </button>
        ))}
      </nav>
      <div className="filter-row">
        <div className="search-field">
          <Icon name="search" />
          <input
            aria-label="搜索 Skill"
            placeholder="搜索名称或适用场景"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="muted">上传后先预览，再确认安装</span>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Skill</th>
              <th>适用场景</th>
              <th>来源 / 版本</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((skill) => (
              <tr key={skill.name}>
                <td>
                  <strong>{skill.name}</strong>
                  <small>{skill.fileCount} 个文档</small>
                </td>
                <td className="skill-scenario">{skill.description}</td>
                <td>
                  <span className="tag">{skill.source === "BUILTIN" ? "内置" : "我上传的"}</span>
                  <small>v{skill.revision}</small>
                </td>
                <td>
                  <span className={`tag ${skill.enabled ? "green" : ""}`}>{skill.enabled ? "可用" : "已停用"}</span>
                </td>
                <td>
                  <div className="row-actions">
                    <button type="button" onClick={() => void openSkill(skill.name)}>
                      查看规则
                    </button>
                    {skill.source === "UPLOADED" && (
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={busy}
                        onClick={() => void update(skill, !skill.enabled, skill.roles)}
                      >
                        {skill.enabled ? "停用" : "启用"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && (
          <div className="empty-state">
            <Icon name="file" size={32} />
            <h2>{source === "UPLOADED" ? "把你自己的 Skill 放进来" : "没有匹配的 Skill"}</h2>
            <p>上传 SKILL.md 或包含 references 文档的完整目录。</p>
            <button type="button" onClick={() => setUpload(true)}>
              上传 Skill
            </button>
          </div>
        )}
      </div>
      <p className="info-note">
        内置规则保留原版；上传的 Skill 可以更新、关联专家或停用。更新后，已有任务仍对应原来的版本。
      </p>
      {upload && (
        <Modal
          title="上传 Skill"
          onClose={() => {
            if (!busy) setUpload(false);
          }}
          wide
          footer={
            <>
              <button type="button" disabled={busy} onClick={() => setUpload(false)}>
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy || !preview}
                onClick={() => void install()}
              >
                {busy
                  ? "正在校验 / 安装…"
                  : preview?.expectedRevision
                    ? `确认更新到 v${preview.expectedRevision + 1}`
                    : "确认添加 Skill"}
              </button>
            </>
          }
        >
          <div className="upload-choice">
            <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
              <Icon name="file" />
              选择 SKILL.md
            </button>
            <button type="button" disabled={busy} onClick={() => folderInput.current?.click()}>
              <Icon name="box" />
              选择 Skill 文件夹
            </button>
          </div>
          <p className="muted">
            SKILL.md 需有 name、description 与规则正文。支持 references 下的 Markdown；单文件32 KB，整包128 KB。
          </p>
          {notice && (
            <p className="studio-notice" role="status">
              {notice}
            </p>
          )}
          {preview && (
            <>
              <div className="preview-summary">
                <h3>{preview.name}</h3>
                <p>{preview.description}</p>
                <span className="tag">
                  {preview.expectedRevision ? `更新已有 v${preview.expectedRevision}` : "新增方法"}
                </span>
              </div>
              <fieldset className="checkbox-list">
                <legend>关联专家</legend>
                {CAPABILITY_ROLES.map((role) => (
                  <label key={role}>
                    <input
                      type="checkbox"
                      checked={roles.includes(role)}
                      onChange={(event) =>
                        setRoles(event.target.checked ? [...roles, role] : roles.filter((item) => item !== role))
                      }
                    />
                    {roleNames[role]}
                  </label>
                ))}
              </fieldset>
              <div className="file-list">
                {preview.files.map((file) => (
                  <p key={file.path}>
                    <Icon name="file" />
                    {file.path}
                    <small>{file.sizeBytes} B</small>
                  </p>
                ))}
              </div>
              <div className="rule-preview">
                <AssistantMarkdown content={preview.content} />
              </div>
            </>
          )}
        </Modal>
      )}
      {detail && (
        <Modal
          title={detail.item.name}
          onClose={() => {
            if (!busy) setDetail(null);
          }}
          wide
          footer={
            <>
              <span className="muted">
                {detail.item.source === "BUILTIN" ? "内置规则 · 只读" : `当前 v${detail.item.revision}`}
              </span>
              <button type="button" onClick={() => setDetail(null)}>
                关闭
              </button>
              {detail.item.source === "UPLOADED" && (
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void update(detail.item, detail.item.enabled, roles)}
                >
                  保存专家关联
                </button>
              )}
            </>
          }
        >
          <p>{detail.item.description}</p>
          {notice && (
            <p className="studio-notice" role="status">
              {notice}
            </p>
          )}
          <fieldset className="checkbox-list">
            <legend>关联专家</legend>
            {CAPABILITY_ROLES.map((role) => (
              <label key={role}>
                <input
                  type="checkbox"
                  disabled={detail.item.source === "BUILTIN" || busy}
                  checked={roles.includes(role)}
                  onChange={(event) =>
                    setRoles(event.target.checked ? [...roles, role] : roles.filter((item) => item !== role))
                  }
                />
                {roleNames[role]}
              </label>
            ))}
          </fieldset>
          <div className="document-tabs">
            {detail.files.map((file) => (
              <button
                type="button"
                key={file.path}
                className={filePath === file.path ? "selected" : ""}
                onClick={() => setFilePath(file.path)}
              >
                {file.path}
              </button>
            ))}
          </div>
          <pre className="source-preview">{detail.files.find((file) => file.path === filePath)?.content}</pre>
          <h3>版本记录</h3>
          {detail.versions.map((version) => (
            <div className="history-row" key={version.revision}>
              <span>
                v{version.revision} · {version.createdAt ? new Date(version.createdAt).toLocaleString() : "项目内置"}
              </span>
              {detail.item.source === "UPLOADED" && version.revision !== detail.item.revision && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void update(detail.item, detail.item.enabled, roles, version.revision)}
                >
                  采用此版，另存新版本
                </button>
              )}
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}
