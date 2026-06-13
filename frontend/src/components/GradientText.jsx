export default function GradientText({
  children,
  className = "",
  colors = ["#ffffff", "#b9ff73", "#79e6ff", "#ff5ca8", "#ffffff"],
  animationSpeed = 7,
  direction = "horizontal",
  pauseOnHover = true
}) {
  const gradientAngle =
    direction === "vertical" ? "to bottom" : direction === "diagonal" ? "135deg" : "to right";

  return (
    <span
      className={`animated-gradient-text ${pauseOnHover ? "pause-on-hover" : ""} ${className}`}
      style={{
        "--gradient-text-colors": colors.join(", "),
        "--gradient-text-angle": gradientAngle,
        "--gradient-text-speed": `${animationSpeed}s`
      }}
    >
      {children}
    </span>
  );
}
