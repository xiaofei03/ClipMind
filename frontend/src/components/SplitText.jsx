export default function SplitText({
  text = "",
  className = "",
  tag: Tag = "span",
  delay = 54,
  duration = 720,
  splitType = "chars",
  children
}) {
  const content = text || String(children || "");
  const units = splitType === "words" ? content.split(/(\s+)/) : Array.from(content);

  return (
    <Tag className={`split-text ${className}`} aria-label={content}>
      <span className="split-readable">{content}</span>
      {units.map((unit, index) => {
        const isSpace = /^\s+$/.test(unit);
        return (
          <span
            aria-hidden="true"
            className={isSpace ? "split-space" : "split-unit"}
            key={`${unit}-${index}`}
            style={{
              "--split-index": index,
              "--split-delay": `${delay}ms`,
              "--split-duration": `${duration}ms`
            }}
          >
            {isSpace ? "\u00a0" : unit}
          </span>
        );
      })}
    </Tag>
  );
}
