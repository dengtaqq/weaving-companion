import { useRef, useState } from "react";
import type { ArtifactRecord, GenerationJobRecord } from "../../../shared/contracts.js";
import * as api from "../../api/client.js";
import { Modal } from "../../components/ui.js";
/** 对结果不明的原图片请求人工核对，解决前不允许再次发起同一图位的付费请求。 */
export function ImageReconcileModal({
  job,
  images,
  onClose,
  onResolved,
}: {
  job: GenerationJobRecord;
  images: ArtifactRecord[];
  onClose: () => void;
  onResolved: () => Promise<void>;
}) {
  const [resolution, setResolution] = useState<"NO_RESULT" | "ADOPT_IMAGE">("NO_RESULT");
  const [artifactId, setArtifactId] = useState("");
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const keys = useRef(new Map<string, string>());
  /** 保存核对说明和原请求标识，人工选择不会被伪装成服务商回执。 */
  async function save() {
    if (!confirmed || busy) return;
    setBusy(true);
    try {
      const input = { resolution, artifactId: resolution === "ADOPT_IMAGE" ? artifactId : null, note };
      const signature = JSON.stringify(input);
      if (!keys.current.has(signature)) keys.current.set(signature, crypto.randomUUID());
      await api.reconcileImageJob(job.sessionId, job.jobId, input, keys.current.get(signature) as string);
      await onResolved();
      onClose();
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="核对原图片请求"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !confirmed || note.trim().length < 5 || (resolution === "ADOPT_IMAGE" && !artifactId)}
            onClick={() => void save()}
          >
            保存人工核对结果
          </button>
        </>
      }
    >
      <p className="muted">请先到服务商核对原请求。此操作只登记核对结果，不会再次收费生成。</p>
      <p>任务：{job.jobId}</p>
      {notice && <p role="status">{notice}</p>}
      <div className="form-stack">
        <label>
          核对结果
          <select value={resolution} onChange={(event) => setResolution(event.target.value as typeof resolution)}>
            <option value="NO_RESULT">已确认未取得可用图片，结束原请求</option>
            <option value="ADOPT_IMAGE">已取得图片，采用会话中的图片</option>
          </select>
        </label>
        {resolution === "ADOPT_IMAGE" && (
          <label>
            图片文件
            <select value={artifactId} onChange={(event) => setArtifactId(event.target.value)}>
              <option value="">请先将图片上传到本会话，再选择</option>
              {images.map((item) => (
                <option key={item.artifactId} value={item.artifactId}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          核对依据与说明
          <textarea rows={4} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <label className="inline-checkbox">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          我已核对原请求，并确认以上人工处理结果
        </label>
      </div>
    </Modal>
  );
}
