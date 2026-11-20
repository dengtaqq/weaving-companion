import { useCallback, useEffect, useState } from "react";
import type { CapabilityCatalog } from "../../../shared/capabilities.js";
import * as api from "../../api/client.js";
import { ExpertsPage } from "./experts-page.js";
import { SkillsPage } from "./skills-page.js";

/** 共用真实能力目录读取，具体专家和 Skill 管理由各自页面负责。 */
export function CapabilitiesPage({ page }: { page: "experts" | "skills" }) {
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [notice, setNotice] = useState("");
  /** 在保存后刷新目录和版本，页面不凭本地表单假定安装成功。 */
  const refresh = useCallback(async () => {
    setCatalog(await api.getCapabilities());
  }, []);
  useEffect(() => {
    let active = true;
    void api
      .getCapabilities()
      .then((result) => {
        if (active) setCatalog(result);
      })
      .catch((error: unknown) => {
        if (active) setNotice(String(error));
      });
    return () => {
      active = false;
    };
  }, []);
  if (!catalog)
    return (
      <div className="page-content">
        <p role="status">{notice || "正在读取能力配置…"}</p>
      </div>
    );
  return page === "skills" ? (
    <SkillsPage catalog={catalog} refresh={refresh} />
  ) : (
    <ExpertsPage catalog={catalog} refresh={refresh} />
  );
}
