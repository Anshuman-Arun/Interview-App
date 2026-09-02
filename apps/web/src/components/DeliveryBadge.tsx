import React from "react";
import type { DeliveryStatus } from "../../../../packages/domain/src/index.js";
import "./DeliveryBadge.css";

export type MessageDeliveryStatus =
  | DeliveryStatus
  | "PENDING"
  | "ACKNOWLEDGED"
  | "ERROR";

export interface DeliveryBadgeProps {
  readonly status: MessageDeliveryStatus;
  readonly className?: string;
  readonly showLabel?: boolean;
}

interface StatusConfig {
  readonly label: string;
  readonly tone: "neutral" | "info" | "success" | "warning" | "danger";
}

const STATUS_CONFIGS: Record<MessageDeliveryStatus, StatusConfig> = {
  VALIDATED: { label: "Validated", tone: "info" },
  QUEUED: { label: "Queued", tone: "warning" },
  DELIVERING: { label: "Streaming...", tone: "info" },
  EXPOSED: { label: "Exposed", tone: "info" },
  COMPLETED: { label: "Delivered", tone: "success" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  POSSIBLY_EXPOSED: { label: "Recovered", tone: "warning" },
  PENDING: { label: "Sending...", tone: "neutral" },
  ACKNOWLEDGED: { label: "Committed", tone: "success" },
  ERROR: { label: "Failed", tone: "danger" }
};

export const DeliveryBadge: React.FC<DeliveryBadgeProps> = ({
  status,
  className = "",
  showLabel = true
}) => {
  const config = STATUS_CONFIGS[status];

  return (
    <span
      className={`delivery-badge delivery-badge--${config.tone} ${className}`}
      data-testid="delivery-badge"
      data-status={status}
      title={`Delivery status: ${config.label}`}
    >
      <span className="delivery-badge__dot" aria-hidden="true" />
      {showLabel && <span>{config.label}</span>}
    </span>
  );
};
