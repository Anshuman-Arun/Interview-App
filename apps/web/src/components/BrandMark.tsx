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
      className="brand-mark"
    >
      <path
        className="brand-mark__bracket"
        d="M14 6H6v8 M18 26h8v-8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.05"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <circle className="brand-mark__dot" cx="16" cy="16" r="2.15" fill="currentColor" />
    </svg>
  );
}
