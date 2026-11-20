import { useRef, useState } from "react";
import type {
  CapabilityCatalog,
  CapabilityRole,
  ExpertConfiguration,
  TeamConfiguration,
} from "../../../shared/capabilities.js";
import * as api from "../../api/client.js";
import { Icon, Modal } from "../../components/ui.js";

/** 将主助手与团队成员分区管理，职责和方法配置保存后只影响新任务。 */
export function ExpertsPage({ catalog, refresh }: { catalog: CapabilityCatalog; refresh: () => Promise<void> }) {
  const [team, setTeam] = useState<TeamConfiguration | null>(null);
  const [expert, setExpert] = useState<ExpertConfiguration | null>(null);
  const [returnToTeam, setReturnToTeam] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const commands = useRef(new Map<string, string>());
  /** 保存回执不明时复用相同编辑命令。 */
  function commandKey(value: unknown): string {
    const signature = JSON.stringify(value);
    if (!commands.current.has(signature)) commands.current.set(signature, crypto.randomUUID());
    return commands.current.get(signature) as string;
  }
  const main = catalog.experts.find((item) => item.role === "main");
  /** 保存完整角色职责及方法选集，版本冲突时保留编辑内容。 */
  async function saveExpert() {
    if (!expert || busy) return;
    setBusy(true);
    setNotice("");
    try {
      await api.saveExpert(
        expert.role,
        expert.revision,
        {
          name: expert.name,
          description: expert.description,
          instructions: expert.instructions,
          skillNames: expert.skillNames,
        },
        commandKey(expert),
      );
      await refresh();
      setExpert(null);
      setNotice("专家配置已保存；之后的新任务生效，已有任务保持原版。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  /** 团队停用成员只改变未来委派，不中止正在执行的子任务。 */
  async function saveTeam() {
    if (!team || busy) return;
    setBusy(true);
    setNotice("");
    try {
      await api.saveExpertTeam(
        team.revision,
        { name: team.name, description: team.description, enabledRoles: team.enabledRoles },
        commandKey(team),
      );
      await refresh();
      setTeam(null);
      setNotice("团队配置已保存，新任务使用当前启用成员。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  /** 打开团队成员职责，关闭后回到保留的团队表单。 */
  function editMember(role: CapabilityRole) {
    const member = catalog.experts.find((item) => item.role === role);
    if (member) {
      setExpert({ ...member });
      setReturnToTeam(true);
      setNotice("");
    }
  }
  return (
    <div className="page-content experts-page">
      {notice && !team && !expert && (
        <p className="studio-notice" role="status">
          {notice}
        </p>
      )}
      <section className="roster-section">
        <h2 className="roster-heading">
          <Icon name="users" />
          专家团
        </h2>
        <button
          type="button"
          className="expert-roster-card"
          onClick={() => {
            setTeam({ ...catalog.group });
            setNotice("");
          }}
        >
          <div className="roster-identity">
            <span className="roster-avatar">商</span>
            <div>
              <h3>{catalog.group.name}</h3>
              <code>{catalog.group.groupId}</code>
            </div>
          </div>
          <p>{catalog.group.description}</p>
          <div className="roster-members">
            {catalog.experts
              .filter((item) => item.role !== "main")
              .map((item) => item.name)
              .join(" · ")}
          </div>
          <div className="roster-footer">
            <span className={`roster-status ${catalog.group.roles.length ? "" : "muted"}`}>
              <i />
              {catalog.group.roles.length ? "已添加" : "已停用"}
            </span>
            <span>
              <Icon name="users" />
              专家团
            </span>
          </div>
        </button>
      </section>
      <div className="roster-divider" />
      <section className="roster-section">
        <h2 className="roster-heading">
          <Icon name="spark" />
          独立专家
        </h2>
        {main && (
          <button
            type="button"
            className="expert-roster-card"
            onClick={() => {
              setExpert({ ...main });
              setReturnToTeam(false);
              setNotice("");
            }}
          >
            <div className="roster-identity">
              <span className="roster-avatar">织</span>
              <div>
                <h3>
                  {main.name}
                  <span className="tag">默认</span>
                </h3>
                <code>main</code>
              </div>
            </div>
            <p>{main.description}</p>
            <div className="roster-footer">
              <span className="roster-status">
                <i />
                已添加
              </span>
              <span>
                <Icon name="spark" />
                专家
              </span>
            </div>
          </button>
        )}
      </section>
      {team && !expert && (
        <Modal
          title={team.name}
          onClose={() => {
            if (!busy) setTeam(null);
          }}
          footer={
            <>
              <button type="button" onClick={() => setTeam(null)}>
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy || !team.name.trim()}
                onClick={() => void saveTeam()}
              >
                保存团队配置
              </button>
            </>
          }
        >
          {notice && (
            <p className="studio-notice" role="status">
              {notice}
            </p>
          )}
          <div className="form-stack">
            <label>
              专家团名称
              <input
                value={team.name}
                maxLength={80}
                onChange={(event) => setTeam({ ...team, name: event.target.value })}
              />
            </label>
            <label>
              团队简介
              <textarea
                value={team.description}
                rows={3}
                maxLength={2000}
                onChange={(event) => setTeam({ ...team, description: event.target.value })}
              />
            </label>
          </div>
          <h3>团队成员与分工</h3>
          {catalog.experts
            .filter((item) => item.role !== "main")
            .map((item) => (
              <div className="team-member-row" key={item.role}>
                <span className="member-avatar">{item.name[0]}</span>
                <div>
                  <strong>{item.name}</strong>
                  <small>{item.description}</small>
                </div>
                <label className="inline-checkbox">
                  <input
                    type="checkbox"
                    checked={team.enabledRoles.includes(item.role as Exclude<CapabilityRole, "main">)}
                    onChange={(event) =>
                      setTeam({
                        ...team,
                        enabledRoles: event.target.checked
                          ? [...team.enabledRoles, item.role as Exclude<CapabilityRole, "main">]
                          : team.enabledRoles.filter((role) => role !== item.role),
                      })
                    }
                  />
                  启用
                </label>
                <button type="button" className="quiet-button" onClick={() => editMember(item.role)}>
                  查看职责
                </button>
              </div>
            ))}
          <p className="info-note">由主助手按任务需要委派。专家意见会返回原任务，最终发布包仍由你整套确认。</p>
        </Modal>
      )}
      {expert && (
        <Modal
          title={`配置${expert.name}`}
          onClose={() => {
            if (!busy) {
              setExpert(null);
              if (!returnToTeam) setTeam(null);
            }
          }}
          wide
          footer={
            <>
              <button type="button" onClick={() => setExpert(null)}>
                {returnToTeam ? "返回团队" : "取消"}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy || !expert.name.trim() || !expert.instructions.trim()}
                onClick={() => void saveExpert()}
              >
                保存专家配置
              </button>
            </>
          }
        >
          {notice && (
            <p className="studio-notice" role="status">
              {notice}
            </p>
          )}
          <div className="form-stack">
            <label>
              专家名称
              <input
                value={expert.name}
                maxLength={80}
                onChange={(event) => setExpert({ ...expert, name: event.target.value })}
              />
            </label>
            <label>
              职责简介
              <textarea
                value={expert.description}
                maxLength={2000}
                rows={2}
                onChange={(event) => setExpert({ ...expert, description: event.target.value })}
              />
            </label>
            <label>
              工作规则
              <textarea
                value={expert.instructions}
                maxLength={32768}
                rows={10}
                onChange={(event) => setExpert({ ...expert, instructions: event.target.value })}
              />
            </label>
          </div>
          <fieldset className="checkbox-list skill-bindings">
            <legend>关联 Skill</legend>
            {catalog.skills.map((skill) => (
              <label key={skill.name}>
                <input
                  type="checkbox"
                  disabled={!skill.roles.includes(expert.role)}
                  checked={expert.skillNames.includes(skill.name)}
                  onChange={(event) =>
                    setExpert({
                      ...expert,
                      skillNames: event.target.checked
                        ? [...expert.skillNames, skill.name]
                        : expert.skillNames.filter((name) => name !== skill.name),
                    })
                  }
                />
                <span>
                  {skill.name}
                  <small>
                    {!skill.enabled
                      ? "已停用，运行时不装配"
                      : !skill.roles.includes(expert.role)
                        ? "请先在 Skill 中关联此专家"
                        : skill.source === "BUILTIN"
                          ? "内置"
                          : "自上传"}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="muted">
            角色 ID：{expert.role} · 配置第{expert.revision}版。编辑职责不会增加工具权限。
          </p>
        </Modal>
      )}
    </div>
  );
}
