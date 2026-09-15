interface ChevronIconProps {
  open: boolean;
}

export function ChevronIcon({ open }: ChevronIconProps) {
  return (
    <svg
      className={`icon-chevron ${open ? 'icon-chevron-open' : ''}`}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
    >
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface EyeIconProps {
  hidden: boolean;
}

interface StarIconProps {
  starred: boolean;
}

export function UploadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 11V3M8 3L5 6M8 3l3 3M3 12v1a1 1 0 001 1h8a1 1 0 001-1v-1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function EyeIcon({ hidden }: EyeIconProps) {
  if (hidden) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path
          d="M2 2l12 12M6.6 6.7a2 2 0 002.7 2.7M4 4.5C2.5 5.6 1.5 7 1.2 8c.7 2.3 3.4 5 6.8 5 1.2 0 2.3-.3 3.3-.9M9.8 3.3C9.2 3.1 8.6 3 8 3c-.6 0-1.2.1-1.7.3"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M1.2 8C2 5.6 4.6 3 8 3s6 2.6 6.8 5c-.8 2.4-3.4 5-6.8 5s-6-2.6-6.8-5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function StarIcon({ starred }: StarIconProps) {
  if (starred) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" strokeWidth="1">
        <path d="M8 1.5l1.85 3.75 4.15.6-3 2.93.71 4.12L8 10.87l-3.71 1.95L5 8.78l-3-2.93 4.15-.6z" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M8 1.5l1.85 3.75 4.15.6-3 2.93.71 4.12L8 10.87l-3.71 1.95L5 8.78l-3-2.93 4.15-.6z" strokeLinejoin="round" />
    </svg>
  );
}