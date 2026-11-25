// Stroke icons, drawn inline so they take the text colour.
import type { JSX } from "solid-js";

const icon = (children: JSX.Element) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    {children}
  </svg>
);

export const IconPlus = () => icon(<path d="M12 5v14M5 12h14" />);
export const IconBell = () =>
  icon(
    <>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z" />
      <path d="M10 21h4" />
    </>,
  );
export const IconSplit = () =>
  icon(
    <>
      <rect x="4" y="5" width="16" height="14" />
      <path d="M12 5v14" />
    </>,
  );
export const IconSun = () =>
  icon(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
    </>,
  );
export const IconMoon = () => icon(<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />);
export const IconSettings = () =>
  icon(
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>,
  );
export const IconCamera = () =>
  icon(
    <>
      <rect x="4" y="7" width="16" height="12" />
      <circle cx="12" cy="13" r="3" />
      <path d="M9 7l1-2h4l1 2" />
    </>,
  );
export const IconFullscreen = () => icon(<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />);
export const IconCursor = () => icon(<path d="M12 3v18M3 12h18" />);
export const IconTrend = () =>
  icon(
    <>
      <path d="M5 19 19 5" />
      <circle cx="5" cy="19" r="1.5" />
      <circle cx="19" cy="5" r="1.5" />
    </>,
  );
export const IconHLine = () =>
  icon(
    <>
      <path d="M3 12h18" />
      <circle cx="12" cy="12" r="1.5" />
    </>,
  );
export const IconFib = () => icon(<path d="M4 5h16M4 10h16M4 14h16M4 19h16" />);
export const IconRect = () => icon(<rect x="5" y="7" width="14" height="10" />);
export const IconText = () => icon(<path d="M6 6h12M12 6v13" />);
export const IconMeasure = () =>
  icon(
    <>
      <path d="M4 16 16 4l4 4L8 20z" />
      <path d="m8 12 2 2M11 9l2 2" />
    </>,
  );
export const IconEraser = () =>
  icon(
    <>
      <path d="M8 19 4 15 14 5l6 6-8 8z" />
      <path d="M8 19h12" />
    </>,
  );
export const IconTrash = () => icon(<path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12" />);
export const IconStar = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="m8 1.5 2 4.2 4.5.6-3.3 3.1.8 4.5L8 11.7l-4 2.2.8-4.5L1.5 6.3 6 5.7z" />
  </svg>
);
