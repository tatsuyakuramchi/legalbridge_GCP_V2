// Shared empty-state used across list/detail views for a consistent look:
// icon, title, optional description, optional action button.
export function EmptyState({ icon = "◇", title, description, actionLabel, onAction, compact = false }: {
  icon?: string;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}) {
  return <div className={`empty-state-box${compact ? " compact" : ""}`} role="status">
    <span className="empty-icon" aria-hidden="true">{icon}</span>
    <strong>{title}</strong>
    {description && <p>{description}</p>}
    {actionLabel && onAction && <button className="primary" onClick={onAction}>{actionLabel}</button>}
  </div>;
}
