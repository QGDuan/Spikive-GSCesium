import { useEffect } from "react";
import type { InspectionLabel, Vec3 } from "@spikive/shared";

interface Props {
  label: InspectionLabel;
  onClose(): void;
}

const statusText: Record<InspectionLabel["resolutionStatus"], string> = {
  resolved: "已解析",
  pending: "待解析",
  unresolved: "未解析"
};

export function InspectionLabelPopup({ label, onClose }: Props) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <section
    className="inspection-label-popup"
    style={{ borderTopColor: label.color }}
    role="dialog"
    aria-modal="false"
    aria-labelledby="inspection-label-popup-title"
  >
    <header>
      <div>
        <span className="inspection-label-popup-kicker">巡检对象</span>
        <h2 id="inspection-label-popup-title">{label.title}</h2>
      </div>
      <button type="button" className="inspection-label-popup-close" onClick={onClose} aria-label="关闭巡检对象详情">×</button>
    </header>
    <div className="inspection-label-popup-meta">
      <span>{label.category || "巡检点"}</span>
      <span className={`resolution ${label.resolutionStatus}`}>{statusText[label.resolutionStatus]}</span>
    </div>
    {label.description && <p>{label.description}</p>}
    <dl>
      <div><dt>局部坐标 / m</dt><dd>{formatVec3(label.positionLocal)}</dd></div>
      <div><dt>表面法向</dt><dd>{label.surfaceNormalLocal ? formatVec3(label.surfaceNormalLocal) : "未记录"}</dd></div>
      <div><dt>吸附距离</dt><dd>{label.snapDistance === null ? "未记录" : `${formatNumber(label.snapDistance)} m`}</dd></div>
    </dl>
  </section>;
}

const formatNumber = (value: number) => Number(value.toFixed(3)).toString();
const formatVec3 = (value: Vec3) => `${formatNumber(value.x)}, ${formatNumber(value.y)}, ${formatNumber(value.z)}`;
