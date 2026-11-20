import { useCallback, useEffect, useRef, useState } from "react";
import type { MerchantMedia } from "../../../shared/workbench.js";
import * as api from "../../api/client.js";
import { Icon, Modal } from "../../components/ui.js";

/** 商家素材按归属维护；采用到当前任务必须经过明确选择和 Host 检查。 */
export function MediaLibrary({
  merchantId,
  productEntryId,
  sessionId,
  onImported,
}: {
  merchantId: string;
  productEntryId?: string;
  sessionId?: string;
  onImported?: () => Promise<void>;
}) {
  const [items, setItems] = useState<MerchantMedia[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef(new Map<string, string>());
  /** 重新读取实际保存的图片，切换商家时隔离本地选集。 */
  const refresh = useCallback(async () => {
    setItems(await api.listMerchantMedia(merchantId, productEntryId));
  }, [merchantId, productEntryId]);
  useEffect(() => {
    let active = true;
    setItems([]);
    setSelected([]);
    void api
      .listMerchantMedia(merchantId, productEntryId)
      .then((next) => {
        if (active) setItems(next);
      })
      .catch((error: unknown) => {
        if (active) setNotice(String(error));
      });
    return () => {
      active = false;
    };
  }, [merchantId, productEntryId]);
  /** 保存请求键，文件上传回执不明时不会登记多个素材。 */
  function commandKey(value: unknown): string {
    const signature = JSON.stringify(value);
    if (!pending.current.has(signature)) pending.current.set(signature, crypto.randomUUID());
    return pending.current.get(signature) as string;
  }
  /** 逐份上传实拍图，校验由 Host 再执行，不把前端预览当成已保存。 */
  async function upload(files: FileList | null) {
    if (!files?.length || busy) return;
    const list = Array.from(files);
    setBusy(true);
    setNotice("");
    try {
      if (list.length > 9) throw Error("一次最多选择9张图片。");
      for (const file of list) {
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 8388608)
          throw Error("每张实拍图需为不超过8 MB的 PNG/JPEG/WebP。");
        await api.uploadMerchantMedia(
          merchantId,
          productEntryId ?? null,
          file,
          commandKey({ name: file.name, size: file.size, lastModified: file.lastModified, productEntryId }),
        );
      }
      await refresh();
      setNotice("素材已保存到当前商家；可在图文任务中选择采用。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  /** 素材停用保留已采用的会话副本及原始图片。 */
  async function toggle(item: MerchantMedia) {
    if (busy) return;
    setBusy(true);
    try {
      await api.updateMerchantMedia(
        item,
        item.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
        commandKey({ mediaId: item.mediaId, revision: item.revision }),
      );
      await refresh();
      setSelected((current) => current.filter((id) => id !== item.mediaId));
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  /** 采用前由 Host 复核所有图片仍属于当前商家，失败不部分导入。 */
  async function importSelected() {
    if (!sessionId || busy || !selected.length) return;
    setBusy(true);
    try {
      await api.importMerchantMedia(sessionId, selected, commandKey({ sessionId, selected }));
      await onImported?.();
      setSelected([]);
      setNotice("已加入本篇图文，可在图位中选择采用。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="media-library">
      <div className="section-heading">
        <div>
          <h3>{productEntryId ? "商品实拍素材" : "商家素材库"}</h3>
          <p className="muted">真实商品、门店与品牌素材按商家保存；生成图与实拍分开核对。</p>
        </div>
        <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
          <Icon name="plus" />
          上传实拍图
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(event) => {
          const files = event.target.files;
          void upload(files);
          event.target.value = "";
        }}
      />
      {notice && (
        <p className="studio-notice" role="status">
          {notice}
        </p>
      )}
      <div className="media-grid">
        {items.map((item) => (
          <article className={`media-card ${item.status === "INACTIVE" ? "inactive" : ""}`} key={item.mediaId}>
            {item.status === "ACTIVE" ? (
              <img src={api.merchantMediaUrl(item)} alt={item.title} />
            ) : (
              <div className="media-unavailable">
                <Icon name="image" />
                素材已停用
              </div>
            )}
            <div>
              <strong>{item.title}</strong>
              <small>
                {(item.sizeBytes / 1024).toFixed(0)} KB · 人工提供 · v{item.revision}
              </small>
            </div>
            <div className="row-actions">
              {sessionId && item.status === "ACTIVE" ? (
                <label className="inline-checkbox">
                  <input
                    type="checkbox"
                    checked={selected.includes(item.mediaId)}
                    disabled={busy || (!selected.includes(item.mediaId) && selected.length >= 9)}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, item.mediaId]
                          : selected.filter((id) => id !== item.mediaId),
                      )
                    }
                  />
                  采用到本篇
                </label>
              ) : (
                <button type="button" className="quiet-button" disabled={busy} onClick={() => void toggle(item)}>
                  {item.status === "ACTIVE" ? "停用" : "重新启用"}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {!items.length && (
        <div className="empty-state compact-empty">
          <Icon name="image" size={28} />
          <p>暂无素材。上传实拍后，可在后续创作中复用。</p>
        </div>
      )}
      {sessionId && (
        <button
          type="button"
          className="primary-button"
          disabled={busy || !selected.length}
          onClick={() => void importSelected()}
        >
          将所选 {selected.length} 张加入本篇图文
        </button>
      )}
    </section>
  );
}
/** 统一素材选择弹窗，图文编辑表单保持挂载以保留尚未保存内容。 */
export function MediaPicker({
  merchantId,
  sessionId,
  onClose,
  onImported,
}: {
  merchantId: string;
  sessionId: string;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  return (
    <Modal
      title="选用商家实拍素材"
      onClose={onClose}
      wide
      footer={
        <button type="button" onClick={onClose}>
          返回图文制作
        </button>
      }
    >
      <MediaLibrary merchantId={merchantId} sessionId={sessionId} onImported={onImported} />
    </Modal>
  );
}
