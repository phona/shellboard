/** Terminal toolbar icons: 14px stroke icons, currentColor. */

function base(): React.SVGProps<SVGSVGElement> {
  return {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
}

export function IconSearch() {
  return (
    <svg {...base()}>
      <circle cx="11" cy="11" r="7" />
      <path d="M16.5 16.5 21 21" />
    </svg>
  );
}

export function IconCopy() {
  return (
    <svg {...base()}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

export function IconPaste() {
  return (
    <svg {...base()}>
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
    </svg>
  );
}

export function IconNewLine() {
  return (
    <svg {...base()}>
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
      <path d="m9 10-5 5 5 5" />
    </svg>
  );
}

export function IconAttach() {
  return (
    <svg {...base()}>
      <path d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9" />
    </svg>
  );
}

export function IconHistory() {
  return (
    <svg {...base()}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

export function IconFullscreen() {
  return (
    <svg {...base()}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

export function IconFontMinus() {
  return (
    <svg {...base()}>
      <path d="M4 18 9.5 5h1L15 18" />
      <path d="M6 13.5h7" />
      <path d="M18.5 12v6M15.5 15h6" />
    </svg>
  );
}

export function IconFontPlus() {
  return (
    <svg {...base()}>
      <path d="M3 18 8.5 5h1L15 18" />
      <path d="M5 13.5h7" />
      <path d="M19 9.5v6M16 12.5h6" />
    </svg>
  );
}

export function IconPanelLeft() {
  return (
    <svg {...base()}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

export function IconPanelRight() {
  return (
    <svg {...base()}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </svg>
  );
}
