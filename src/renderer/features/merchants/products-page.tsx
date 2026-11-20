import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  MerchantCatalogEntry,
  MerchantCatalogInput,
  MerchantRecord,
  SessionRecord,
} from "../../../shared/contracts.js";
import * as api from "../../api/client.js";
import { Icon, Modal } from "../../components/ui.js";
import { MediaLibrary } from "./media-library.js";

const emptyProduct: MerchantCatalogInput = {
  kind: "PRODUCT",
  name: "",
  detail: "",
  sourceUrl: null,
  evidenceId: null,
  observedAt: null,
};

/** 商品维护采用表格与独立编辑弹层，商家详情和全局入口复用同一事实源。 */
export function ProductsPage({
  merchants,
  onSessionCreated,
  defaultMerchantId,
  embedded = false,
  modelConfigured = true,
}: {
  merchants: MerchantRecord[];
  onSessionCreated: (session: SessionRecord) => void;
  defaultMerchantId?: string;
  embedded?: boolean;
  modelConfigured?: boolean;
}) {
  const navigate = useNavigate();
  const [items, setItems] = useState<MerchantCatalogEntry[]>([]);
  const [merchantId, setMerchantId] = useState(defaultMerchantId ?? "");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ACTIVE");
  const [edit, setEdit] = useState<{
    merchantId: string;
    current: MerchantCatalogEntry | null;
    fields: MerchantCatalogInput;
  } | null>(null);
  const [mediaProduct, setMediaProduct] = useState<MerchantCatalogEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const commands = useRef(new Map<string, string>());
  /** 网络重试沿用同一商品写入命令。 */
  function commandKey(value: unknown): string {
    const signature = JSON.stringify(value);
    if (!commands.current.has(signature)) commands.current.set(signature, crypto.randomUUID());
    return commands.current.get(signature) as string;
  }
  const pendingStart = useRef<{ entryId: string; revision: number; session: SessionRecord | null; key: string } | null>(
    null,
  );
  /** 从已有商家目录批量读取商品，不建立另一份商品表。 */
  const refresh = useCallback(async () => {
    const selected = merchantId ? merchants.filter((item) => item.merchantId === merchantId) : merchants;
    const lists = await Promise.all(selected.map((merchant) => api.listMerchantCatalog(merchant.merchantId)));
    setItems(lists.flat().filter((item) => item.kind === "PRODUCT"));
  }, [merchantId, merchants]);
  useEffect(() => {
    void refresh().catch((error: unknown) => setNotice(String(error)));
  }, [refresh]);
  /** 编辑时固定商家，新增时由用户明确选择所属商家。 */
  function editProduct(current: MerchantCatalogEntry | null) {
    const owner = current?.merchantId || merchantId || merchants[0]?.merchantId;
    if (!owner) {
      setNotice("请先添加商家，再维护商品。");
      return;
    }
    setNotice("");
    setEdit({
      merchantId: owner,
      current,
      fields: current
        ? {
            kind: "PRODUCT",
            name: current.name,
            detail: current.detail,
            sourceUrl: current.sourceUrl,
            evidenceId: current.evidenceId,
            observedAt: current.observedAt,
          }
        : { ...emptyProduct },
    });
  }
  /** 保存人工确认的事实，更新前检查当前 revision。 */
  async function saveProduct() {
    if (!edit || busy) return;
    setBusy(true);
    setNotice("");
    try {
      if (edit.current)
        await api.updateMerchantCatalogEntry(
          edit.merchantId,
          edit.current.entryId,
          edit.current.revision,
          edit.fields,
          edit.current.status,
          commandKey(edit),
        );
      else await api.createMerchantCatalogEntry(edit.merchantId, edit.fields, commandKey(edit));
      await refresh();
      setEdit(null);
      setNotice("商品已保存，创作时会固定使用所选版本。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  /** 停用/启用保留历史版本，已受理任务仍使用原快照。 */
  async function toggleProduct(item: MerchantCatalogEntry) {
    if (busy) return false;
    setBusy(true);
    try {
      await api.updateMerchantCatalogEntry(
        item.merchantId,
        item.entryId,
        item.revision,
        {
          kind: "PRODUCT",
          name: item.name,
          detail: item.detail,
          sourceUrl: item.sourceUrl,
          evidenceId: item.evidenceId,
          observedAt: item.observedAt,
        },
        item.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
        commandKey({ entryId: item.entryId, revision: item.revision }),
      );
      await refresh();
      return true;
    } catch (error) {
      setNotice(String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }
  /** 从商品直接创建真实文案任务，回执丢失复用会话与命令键。 */
  async function createContent(item: MerchantCatalogEntry) {
    if (busy) return;
    if (!modelConfigured) {
      setNotice("文本模型尚未配置，请先在设置中查看连接信息。");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      if (pendingStart.current?.entryId !== item.entryId || pendingStart.current.revision !== item.revision)
        pendingStart.current = {
          entryId: item.entryId,
          revision: item.revision,
          session: null,
          key: crypto.randomUUID(),
        };
      const pending = pendingStart.current;
      const session =
        pending.session ?? (await api.createMerchantSession(item.merchantId, undefined, `${pending.key}:session`));
      if (!pending.session) {
        pending.session = session;
        onSessionCreated(session);
      }
      const job = await api.createTextGenerationJob(
        session.sessionId,
        {
          title: `${item.name} · 商品图文`,
          brief: "围绕已确认商品写一篇自然、具体的小红书文案。缺少价格、地址、供应时间时列为待补，不编造到店经历。",
          productEntryId: item.entryId,
        },
        pending.key,
      );
      pendingStart.current = null;
      navigate(`/sessions/${session.sessionId}?studio=1&job=${job.jobId}`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  const visible = items.filter(
    (item) =>
      (!status || item.status === status) &&
      `${item.name} ${item.detail} ${merchants.find((merchant) => merchant.merchantId === item.merchantId)?.name}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <div className={embedded ? "embedded-products" : "page-content products-page"}>
      <div className="page-heading">
        <div>
          <h1>{embedded ? "商品与服务" : "商品与服务"}</h1>
          <p>写清卖点、适用场景与已确认信息，创作时选用，避免重复输入。</p>
        </div>
        <button type="button" className="primary-button" onClick={() => editProduct(null)}>
          <Icon name="plus" />
          新增商品
        </button>
      </div>
      {notice && (
        <p className="studio-notice" role="status">
          {notice}
        </p>
      )}
      <div className="filter-row">
        <div className="search-field">
          <Icon name="search" />
          <input
            aria-label="搜索商品或商家"
            placeholder="搜索商品或商家"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {!defaultMerchantId && (
          <select
            aria-label="按所属商家筛选"
            value={merchantId}
            onChange={(event) => setMerchantId(event.target.value)}
          >
            <option value="">全部商家</option>
            {merchants.map((merchant) => (
              <option key={merchant.merchantId} value={merchant.merchantId}>
                {merchant.name}
              </option>
            ))}
          </select>
        )}
        <select aria-label="商品状态" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="ACTIVE">在用商品</option>
          <option value="INACTIVE">已停用</option>
          <option value="">全部状态</option>
        </select>
        <span className="muted">{visible.length} 个商品 / 服务</span>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>商品 / 服务</th>
              {!defaultMerchantId && <th>所属商家</th>}
              <th>创作资料</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => (
              <tr key={item.entryId}>
                <td>
                  <div className="product-identity">
                    <span className="product-placeholder">
                      <Icon name="image" />
                    </span>
                    <div>
                      <strong>{item.name}</strong>
                      <small>{item.detail || "待补充卖点与限制"}</small>
                    </div>
                  </div>
                </td>
                {!defaultMerchantId && (
                  <td>{merchants.find((merchant) => merchant.merchantId === item.merchantId)?.name}</td>
                )}
                <td>
                  <span className={`tag ${item.detail ? "" : "amber"}`}>{item.detail ? "人工已维护" : "待补资料"}</span>
                  <small>v{item.revision}</small>
                </td>
                <td>
                  <span className={`tag ${item.status === "ACTIVE" ? "green" : ""}`}>
                    {item.status === "ACTIVE" ? "在用" : "已停用"}
                  </span>
                </td>
                <td>
                  <div className="row-actions">
                    <button type="button" className="quiet-button" onClick={() => editProduct(item)}>
                      编辑
                    </button>
                    <button type="button" className="quiet-button" onClick={() => setMediaProduct(item)}>
                      实拍素材
                    </button>
                    <button
                      type="button"
                      disabled={busy || item.status !== "ACTIVE"}
                      onClick={() => void createContent(item)}
                    >
                      用于创作
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && (
          <div className="empty-state">
            <Icon name="box" size={30} />
            <p>还没有匹配的商品，可点击右上角新增。</p>
          </div>
        )}
      </div>
      <p className="info-note">每个商品只属于一个商家。AI 建议、待核实线索与人工确认事实分开记录。</p>
      {edit && (
        <Modal
          title={edit.current ? "编辑商品 / 服务" : "新增商品 / 服务"}
          onClose={() => {
            if (!busy) setEdit(null);
          }}
          footer={
            <>
              {edit.current && (
                <button
                  type="button"
                  className="quiet-button"
                  disabled={busy}
                  onClick={() => {
                    void toggleProduct(edit.current as MerchantCatalogEntry).then((saved) => {
                      if (saved) setEdit(null);
                    });
                  }}
                >
                  {edit.current.status === "ACTIVE" ? "停用此商品" : "重新启用"}
                </button>
              )}
              <button type="button" onClick={() => setEdit(null)}>
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy || !edit.fields.name.trim()}
                onClick={() => void saveProduct()}
              >
                保存商品
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
              所属商家
              <select
                disabled={!!edit.current || !!defaultMerchantId}
                value={edit.merchantId}
                onChange={(event) => setEdit({ ...edit, merchantId: event.target.value })}
              >
                {merchants.map((merchant) => (
                  <option key={merchant.merchantId} value={merchant.merchantId}>
                    {merchant.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              商品名称
              <input
                maxLength={120}
                value={edit.fields.name}
                onChange={(event) => setEdit({ ...edit, fields: { ...edit.fields, name: event.target.value } })}
                placeholder="商品或服务名称"
              />
            </label>
            <label>
              已确认卖点、适用场景与限制
              <textarea
                rows={6}
                maxLength={2000}
                value={edit.fields.detail}
                onChange={(event) => setEdit({ ...edit, fields: { ...edit.fields, detail: event.target.value } })}
                placeholder="写清规格、价格、适用人群、供应情况和不能承诺的内容。缺少的信息可以暂不填写。"
              />
            </label>
            <label>
              商品来源链接（可选）
              <input
                value={edit.fields.sourceUrl ?? ""}
                maxLength={2048}
                onChange={(event) =>
                  setEdit({ ...edit, fields: { ...edit.fields, sourceUrl: event.target.value || null } })
                }
              />
            </label>
          </div>
          <p className="muted">保存后的资料视为你维护的事实，模型不会直接覆盖。</p>
        </Modal>
      )}
      {mediaProduct && (
        <Modal
          title={`${mediaProduct.name} · 实拍素材`}
          wide
          onClose={() => setMediaProduct(null)}
          footer={
            <button type="button" onClick={() => setMediaProduct(null)}>
              关闭
            </button>
          }
        >
          <MediaLibrary merchantId={mediaProduct.merchantId} productEntryId={mediaProduct.entryId} />
        </Modal>
      )}
    </div>
  );
}
