/**
 * Small looping illustrations for the tips shown while the preview boots,
 * one per topic, drawn in the current text colour with the accent for the
 * moving part. The keyframes live in globals.css (tip-*).
 */
export type TipTopic =
  | "connectors"
  | "chat"
  | "folders"
  | "annotate"
  | "knowledge"
  | "mentions"
  | "payments"
  | "responsive"
  | "secrets"
  | "security"
  | "skills"
  | "files"
  | "select";

const A = "var(--accent)";

export default function TipAnimation({ topic }: { topic: TipTopic }) {
  const box = {
    fill: "none",
    stroke: "currentColor",
    strokeOpacity: 0.35,
    strokeWidth: 1.5,
  } as const;
  const body = (() => {
    switch (topic) {
      case "connectors":
        return (
          <>
            <rect x="8" y="22" width="30" height="28" rx="6" {...box} />
            <rect x="82" y="22" width="30" height="28" rx="6" {...box} />
            <path
              className="tip-draw"
              d="M38 36 C 55 18, 65 54, 82 36"
              fill="none"
              stroke={A}
              strokeWidth="2"
            />
          </>
        );
      case "chat":
        return (
          <>
            <rect x="20" y="16" width="80" height="34" rx="10" {...box} />
            {[44, 60, 76].map((x, i) => (
              <circle
                key={x}
                className="tip-bounce"
                cx={x}
                cy="33"
                r="4"
                fill={A}
                style={{ animationDelay: `${i * 0.15}s` }}
              />
            ))}
          </>
        );
      case "folders":
        return (
          <>
            <path d="M24 34 h22 l6 6 h44 v24 h-72 z" {...box} />
            <rect
              className="tip-drop"
              x="44"
              y="22"
              width="32"
              height="20"
              rx="3"
              fill={A}
              fillOpacity="0.85"
            />
          </>
        );
      case "annotate":
        return (
          <>
            <rect x="14" y="10" width="92" height="52" rx="4" {...box} />
            <path
              className="tip-draw"
              d="M30 46 C 40 20, 60 20, 66 34 S 88 50, 92 26"
              fill="none"
              stroke={A}
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </>
        );
      case "knowledge":
        return (
          <>
            <path
              d="M60 18 v44 M60 18 C 48 12, 30 12, 22 16 v44 c8-4 26-4 38 2 M60 18 c12-6 30-6 38-2 v44 c-8-4-26-4-38 2"
              {...box}
            />
            {[28, 36, 44].map((y, i) => (
              <line
                key={y}
                className="tip-fade"
                x1="68"
                y1={y}
                x2="90"
                y2={y}
                stroke={A}
                strokeWidth="2"
                style={{ animationDelay: `${i * 0.3}s` }}
              />
            ))}
          </>
        );
      case "mentions":
        return (
          <>
            <text x="18" y="30" fontSize="18" fontWeight="600" fill={A}>
              @
            </text>
            {[0, 1, 2].map((i) => (
              <rect
                key={i}
                className="tip-slide"
                x="40"
                y={14 + i * 16}
                width="62"
                height="11"
                rx="3"
                fill="currentColor"
                fillOpacity={i === 0 ? 0.3 : 0.12}
                style={{ animationDelay: `${i * 0.15}s` }}
              />
            ))}
          </>
        );
      case "payments":
        return (
          <>
            <rect x="26" y="40" width="68" height="8" rx="3" {...box} />
            <g className="tip-drop">
              <rect
                x="38"
                y="14"
                width="44"
                height="28"
                rx="4"
                fill={A}
                fillOpacity="0.85"
              />
              <rect
                x="38"
                y="20"
                width="44"
                height="5"
                fill="white"
                fillOpacity="0.6"
              />
            </g>
          </>
        );
      case "responsive":
        return (
          <>
            <rect
              className="tip-squeeze"
              x="14"
              y="12"
              width="92"
              height="48"
              rx="5"
              fill="none"
              stroke={A}
              strokeWidth="2"
            />
            <rect
              x="20"
              y="20"
              width="22"
              height="5"
              rx="2"
              fill="currentColor"
              fillOpacity="0.3"
            />
          </>
        );
      case "secrets":
        return (
          <>
            <rect x="40" y="34" width="40" height="28" rx="5" {...box} />
            <path d="M48 34 v-8 a12 12 0 0 1 24 0 v8" {...box} />
            <g className="tip-turn" style={{ transformOrigin: "60px 48px" }}>
              <circle cx="60" cy="46" r="4" fill={A} />
              <rect x="58.5" y="46" width="3" height="9" rx="1" fill={A} />
            </g>
          </>
        );
      case "security":
        return (
          <>
            <path
              d="M60 10 l28 10 v16 c0 16-12 26-28 30 c-16-4-28-14-28-30 v-16 z"
              {...box}
            />
            <line
              className="tip-scan"
              x1="36"
              y1="22"
              x2="84"
              y2="22"
              stroke={A}
              strokeWidth="2"
            />
          </>
        );
      case "skills":
        return (
          <>
            <text x="16" y="30" fontSize="18" fontWeight="600" fill={A}>
              /
            </text>
            {["review", "seo", "a11y"].map((s, i) => (
              <g
                key={s}
                className="tip-slide"
                style={{ animationDelay: `${i * 0.15}s` }}
              >
                <rect
                  x="32"
                  y={12 + i * 17}
                  width="70"
                  height="13"
                  rx="3"
                  fill="currentColor"
                  fillOpacity={i === 0 ? 0.28 : 0.12}
                />
                <text x="38" y={22 + i * 17} fontSize="8" fill="currentColor">
                  /{s}
                </text>
              </g>
            ))}
          </>
        );
      case "files":
        return (
          <>
            {[0, 1, 2].map((i) => (
              <rect
                key={i}
                className="tip-drop"
                x={30 + i * 22}
                y="22"
                width="18"
                height="24"
                rx="2"
                fill={i === 1 ? A : "currentColor"}
                fillOpacity={i === 1 ? 0.85 : 0.25}
                style={{ animationDelay: `${i * 0.25}s` }}
              />
            ))}
          </>
        );
      case "select":
        return (
          <>
            <rect
              x="20"
              y="16"
              width="56"
              height="30"
              rx="4"
              fill="none"
              stroke={A}
              strokeWidth="2"
              strokeDasharray="4 3"
            />
            <path
              className="tip-click"
              d="M70 38 l0 22 l6 -6 l5 9 l4 -2 l-5 -9 l8 -1 z"
              fill="currentColor"
            />
          </>
        );
    }
  })();
  return (
    <svg
      className="tip-anim h-[72px] w-[120px] shrink-0"
      viewBox="0 0 120 72"
      aria-hidden="true"
    >
      {body}
    </svg>
  );
}
