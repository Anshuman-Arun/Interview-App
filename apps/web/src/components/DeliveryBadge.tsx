import React from "react";
import type { DeliveryStatus } from "../../../../packages/domain/src/index.js";
import styles from "./DeliveryBadge.module.css";

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
  DELIVERING: { label: "Responding…", tone: "info" },
  EXPOSED: { label: "Exposed", tone: "neutral" },
  COMPLETED: { label: "Delivered", tone: "success" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  POSSIBLY_EXPOSED: { label: "Possibly exposed", tone: "warning" },
  PENDING: { label: "Sending…", tone: "neutral" },
  ACKNOWLEDGED: { label: "Committed", tone: "neutral" },
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
      className={`${styles.badge ?? ""} ${styles[config.tone] ?? ""} ${className}`}
      data-testid="delivery-badge"
      data-status={status}
      title={`Delivery status: ${config.label}`}
      aria-label={`Delivery status: ${config.label}`}
    >
      <span className={styles.dot} aria-hidden="true" />
      {showLabel && <span>{config.label}</span>}
    </span>
  );
};
