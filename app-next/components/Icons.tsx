/* Hand-built icon set. Stroke-based, inherits currentColor. */

type P = {
  size?: number;
  className?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
};

const base = (size: number, className?: string, sw = 1.6, style?: React.CSSProperties) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: sw,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className,
  style,
});

export const IconCompass = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth)}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5z" />
  </svg>
);

export const IconAtom = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth)}>
    <circle cx="12" cy="12" r="2" />
    <ellipse cx="12" cy="12" rx="10" ry="4.5" />
    <ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(60 12 12)" />
    <ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(120 12 12)" />
  </svg>
);

export const IconBlocks = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth)}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
  </svg>
);

export const IconNetwork = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth)}>
    <circle cx="12" cy="4" r="2.2" />
    <circle cx="4.5" cy="19" r="2.2" />
    <circle cx="19.5" cy="19" r="2.2" />
    <path d="M12 6.2 5.8 16.9M12 6.2l6.2 10.7M6.7 19h10.6" />
  </svg>
);

export const IconDatabase = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth)}>
    <ellipse cx="12" cy="5.5" rx="8" ry="3" />
    <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13" />
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </svg>
);

export const IconBlueprint = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth)}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M9 9v12M13 13h4M13 17h4" />
  </svg>
);

export const IconTarget = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth)}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" />
  </svg>
);

export const IconSearch = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.6-3.6" />
  </svg>
);

export const IconCheck = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth ?? 2.4)}>
    <path d="m4 12.5 5.2 5.2L20 7" />
  </svg>
);

export const IconBookmark = ({ size = 20, className, filled, style }: P & { filled?: boolean }) => (
  <svg {...base(size, className, 1.6, style)} fill={filled ? "currentColor" : "none"}>
    <path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.2L5 21V4.5a1 1 0 0 1 1-1Z" />
  </svg>
);

export const IconNote = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth)}>
    <path d="M5 3.5h9.5L19 8v12.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z" />
    <path d="M14 3.5V8h5M8 13h8M8 17h5" />
  </svg>
);

export const IconFlame = ({ size = 20, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M12 22c3.9 0 7-2.9 7-6.6 0-4.3-3.5-6-5-9.4-.6 2-1.8 3-3 4-1.4 1.2-2 2.4-2 3.9 0 .9.4 1.7 1 2.2-1.6-.2-2.5-1.6-2.5-3.2C5.9 14.4 5 15.6 5 17.3 5 20 8.1 22 12 22Z" />
  </svg>
);

export const IconSun = ({ size = 20, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
  </svg>
);

export const IconMoon = ({ size = 20, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M20.5 14.5A8.6 8.6 0 0 1 9.5 3.5a8.7 8.7 0 1 0 11 11Z" />
  </svg>
);

export const IconArrow = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth)}>
    <path d="M4.5 12h15M13.5 6l6 6-6 6" />
  </svg>
);

export const IconMenu = ({ size = 20, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M3.5 7h17M3.5 12h17M3.5 17h17" />
  </svg>
);

export const IconX = ({ size = 20, className }: P) => (
  <svg {...base(size, className, 2)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconChevron = ({ size = 20, className }: P) => (
  <svg {...base(size, className, 2)}>
    <path d="m9 5 7 7-7 7" />
  </svg>
);

export const IconLogout = ({ size = 20, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4M16 17l5-5-5-5M21 12H9" />
  </svg>
);

export const IconSpark = ({ size = 20, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
  </svg>
);

export const IconRocket = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth)}>
    <path d="M5.5 14.5c-1.4 1.4-1.9 5.5-1.9 5.5s4.1-.5 5.5-1.9c.8-.8.8-2.1 0-2.9a2 2 0 0 0-3.6-.7Z" />
    <path d="M12.5 12.5 9 9m11.5-6.5c0 4-2 8-5 11l-3.5 1L9 13l1-3.5c3-3 7-5 10.5-5Z" />
    <circle cx="15" cy="8" r="1.4" />
  </svg>
);

export const IconChip = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth)}>
    <rect x="7" y="7" width="10" height="10" rx="2" />
    <rect x="10.5" y="10.5" width="3" height="3" rx="0.6" />
    <path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3" />
  </svg>
);

export const IconServer = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth)}>
    <rect x="3" y="4" width="18" height="6" rx="1.8" />
    <rect x="3" y="14" width="18" height="6" rx="1.8" />
    <path d="M7 7h.01M7 17h.01" />
    <path d="M13 7h4M13 17h4" />
  </svg>
);

export const IconBrain = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth)}>
    <path d="M12 5.5a2.6 2.6 0 0 0-4.9-1.2A2.6 2.6 0 0 0 4.4 8a2.8 2.8 0 0 0 .5 4.6A2.7 2.7 0 0 0 7.4 17a2.6 2.6 0 0 0 4.6-.9Z" />
    <path d="M12 5.5a2.6 2.6 0 0 1 4.9-1.2A2.6 2.6 0 0 1 19.6 8a2.8 2.8 0 0 1-.5 4.6 2.7 2.7 0 0 1-2.5 4.4 2.6 2.6 0 0 1-4.6-.9Z" />
    <path d="M12 5.5v10.6" />
  </svg>
);

export const IconBook = ({ size = 20, className, strokeWidth }: P) => (
  <svg {...base(size, className, strokeWidth)}>
    <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v15H5.5A1.5 1.5 0 0 0 4 19.5Z" />
    <path d="M4 19.5A1.5 1.5 0 0 1 5.5 21H19v-3" />
    <path d="M8 7.5h7M8 10.5h5" />
  </svg>
);

const MAP = {
  compass: IconCompass,
  atom: IconAtom,
  blocks: IconBlocks,
  network: IconNetwork,
  database: IconDatabase,
  blueprint: IconBlueprint,
  target: IconTarget,
  rocket: IconRocket,
  chip: IconChip,
  server: IconServer,
  brain: IconBrain,
  book: IconBook,
} as const;

export function SectionIcon({
  name,
  size = 20,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const C = MAP[name as keyof typeof MAP] ?? IconBlocks;
  return <C size={size} className={className} />;
}
