import React from "react";
import type { DeliveryStatus } from "../../../../packages/domain/src/index.js";

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
  readonly badgeClass: string;
  readonly dotClass: string;
  readonly icon: string;
}

const STATUS_CONFIGS: Record<MessageDeliveryStatus, StatusConfig> = {
  VALIDATED: {
    label: "Validated",
    badgeClass: "bg-sky-50 text-sky-700 border-sky-200",
    dotClass: "bg-sky-400",
    icon: "✓"
  },
  QUEUED: {
    label: "Queued",
    badgeClass: "bg-amber-50 text-amber-700 border-amber-200",
    dotClass: "bg-amber-400",
    icon: "⏳"
  },
  DELIVERING: {
    label: "Streaming...",
    badgeClass: "bg-blue-50 text-blue-700 border-blue-200 animate-pulse",
    dotClass: "bg-blue-500 animate-ping",
    icon: "⚡"
  },
  EXPOSED: {
    label: "Exposed",
    badgeClass: "bg-teal-50 text-teal-700 border-teal-200",
    dotClass: "bg-teal-500",
    icon: "👁️"
  },
  COMPLETED: {
    label: "Delivered",
    badgeClass: "bg-emerald-50 text-emerald-700 border-emerald-200",
    dotClass: "bg-emerald-500",
    icon: "✓"
  },
  CANCELLED: {
    label: "Cancelled",
    badgeClass: "bg-slate-100 text-slate-500 border-slate-200",
    dotClass: "bg-slate-300",
    icon: "⊘"
  },
  POSSIBLY_EXPOSED: {
    label: "Recovered",
    badgeClass: "bg-orange-50 text-orange-700 border-orange-200",
    dotClass: "bg-orange-400",
    icon: "⚠️"
  },
  PENDING: {
    label: "Sending...",
    badgeClass: "bg-slate-100 text-slate-600 border-slate-200",
    dotClass: "bg-slate-400 animate-pulse",
    icon: "•••"
  },
  ACKNOWLEDGED: {
    label: "Committed",
    badgeClass: "bg-indigo-50 text-indigo-700 border-indigo-200",
    dotClass: "bg-indigo-500",
    icon: "✓"
  },
  ERROR: {
    label: "Failed",
    badgeClass: "bg-rose-50 text-rose-700 border-rose-200",
    dotClass: "bg-rose-500",
    icon: "✗"
  }
};

export const DeliveryBadge: React.FC<DeliveryBadgeProps> = ({
  status,
  className = "",
  showLabel = true
}) => {
  const config = STATUS_CONFIGS[status];

  return (
    <span
      className={`delivery-badge inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border ${config.badgeClass} ${className}`}
      data-testid="delivery-badge"
      data-status={status}
      title={`Delivery status: ${config.label}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${config.dotClass}`} />
      <span className="font-mono text-[10px] leading-none">{config.icon}</span>
      {showLabel && <span>{config.label}</span>}
    </span>
  );
};
