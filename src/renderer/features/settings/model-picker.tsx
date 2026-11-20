import type { ModelAvailability } from "../../../shared/contracts.js";
/** 按参考稿分栏展示实际模型配置，不列出未接入的服务商或推理档位。 */
export function ModelPicker({ model }: { model: ModelAvailability | null }) {
  return (
    <details className="model-picker">
      <summary className="outline-button">{model?.configured ? model.alias : "模型待配置"}⌃</summary>
      <div className="model-picker-menu">
        <section>
          <h3>服务连接</h3>
          <strong>本机已配置模型</strong>
          <p className="muted">由本机 Host 管理连接和密钥</p>
        </section>
        <section>
          <h3>模型</h3>
          <strong>{model?.alias ?? "未配置"}</strong>
          <p className="muted">{model?.imageInput ? "支持图片输入" : "文本输入"}</p>
        </section>
        <section>
          <h3>推理设置</h3>
          <strong>当前模型默认</strong>
          <p className="muted">新任务使用受理时的配置</p>
        </section>
      </div>
    </details>
  );
}
