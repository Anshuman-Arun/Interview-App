export function BrandMark({
  size = 28,
  title
}: {
  readonly size?: number;
  readonly title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title === undefined ? "presentation" : "img"}
      aria-label={title}
    >
      <rect x="2.5" y="2.5" width="27" height="27" rx="7" fill="var(--text-primary)" />
      <path
        d="M9 21.8V10.2h3v11.6H9Zm5.6 0 4.3-11.6h3.2l-4.4 11.6h-3.1Z"
        fill="var(--surface-panel)"
      />
      <circle cx="23.6" cy="21.5" r="1.65" fill="var(--accent)" />
    </svg>
  );
}
