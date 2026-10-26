/**
 * 18pt 绘制网格线稿图标：与参考实现同一套手绘路径（圆头圆角、统一线宽）。
 * 线宽随尺寸缩放：小图标不变细、大图标不变重。
 */

function circle(x: number, y: number, r: number): string {
  return `M${x + r} ${y}A${r} ${r} 0 1 1 ${x - r} ${y}A${r} ${r} 0 1 1 ${x + r} ${y}Z`;
}

function rounded(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M${x + r} ${y}H${x + w - r}` +
    `A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}` +
    `A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}` +
    `A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}` +
    `A${r} ${r} 0 0 1 ${x + r} ${y}Z`
  );
}

/** 齿轮：48 段折线交替半径形成齿冠。 */
function gearPath(): string {
  let d = '';
  for (let i = 0; i < 48; i++) {
    const angle = (i * Math.PI) / 24 - Math.PI / 2;
    const radius = [0, 1, 4, 5].includes(i % 6) ? 6 : 7.5;
    const x = (9 + Math.cos(angle) * radius).toFixed(3);
    const y = (9 + Math.sin(angle) * radius).toFixed(3);
    d += i === 0 ? `M${x} ${y}` : `L${x} ${y}`;
  }
  return `${d}Z${circle(9, 9, 2.5)}`;
}

function sunPath(): string {
  let d = circle(9, 9, 3.2);
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const x1 = (9 + Math.cos(a) * 5.5).toFixed(3);
    const y1 = (9 + Math.sin(a) * 5.5).toFixed(3);
    const x2 = (9 + Math.cos(a) * 7.4).toFixed(3);
    const y2 = (9 + Math.sin(a) * 7.4).toFixed(3);
    d += `M${x1} ${y1}L${x2} ${y2}`;
  }
  return d;
}

function zoomPath(): string {
  let d = '';
  for (const [cx, cy, dx, dy] of [
    [2.5, 2.5, 1, 1],
    [15.5, 2.5, -1, 1],
    [15.5, 15.5, -1, -1],
    [2.5, 15.5, 1, -1],
  ] as const) {
    d += `M${cx} ${cy + 3.6 * dy}Q${cx} ${cy} ${cx + 3.6 * dx} ${cy}`;
  }
  return `${d}${circle(9, 9, 2.4)}`;
}

function listPath(): string {
  let d = '';
  for (const y of [4.5, 9, 13.5]) {
    d += circle(3.5, y, 0.6) + `M7 ${y}H15.5`;
  }
  return d;
}

function waveformPath(): string {
  let d = '';
  for (const [x, height] of [
    [2, 3],
    [5.5, 8],
    [9, 13],
    [12.5, 7],
    [16, 3],
  ] as const) {
    d += `M${x} ${9 - height / 2}V${9 + height / 2}`;
  }
  return d;
}

function filmPath(): string {
  let d = rounded(2, 3, 14, 12, 2);
  for (const y of [7, 11]) {
    d += `M2 ${y}H5.5M12.5 ${y}H16`;
  }
  return `${d}M5.5 3V15M12.5 3V15`;
}

const BASE_PATHS: Record<string, string> = {
  settings: gearPath(),
  sliders:
    'M2 4H5M9 4H16' + circle(7, 4, 1.8) +
    'M2 9H10M14 9H16' + circle(12, 9, 1.8) +
    'M2 14H4M8 14H16' + circle(6, 14, 1.8),
  record: circle(9, 9, 7) + circle(9, 9, 2.6),
  shield:
    'M9 1.5L15 4V9Q15 14 9 16.5Q3 14 3 9V4Z' +
    rounded(6.8, 8, 4.4, 4, 0.8) +
    'M7.5 8C7.5 4.5 10.5 4.5 10.5 8',
  info:
    circle(9, 9, 7) + circle(9, 5, 0.35) +
    'M8 8H9V13M7.7 13H10.3',
  keyboard: rounded(1.5, 4, 15, 10, 2) + 'M4.5 7H4.6M7.5 7H7.6M10.5 7H10.6M13.5 7H13.6M4.5 10H4.6M7.5 10H7.6M10.5 10H10.6M13.5 10H13.6M6 12H12',
  shapeCircle: circle(9, 9, 6.5),
  shapeRounded: rounded(2.5, 2.5, 13, 13, 4),
  shapeWide: rounded(1.5, 4.5, 15, 9, 2.5),
  globe: circle(9, 9, 7) + 'M5.6 9a3.4 7 0 1 0 6.8 0a3.4 7 0 1 0 -6.8 0M2 9H16',
  appearance: circle(9, 9, 6.7) + 'M9 2.3V15.7M5 4V14M7 3V15',
  sun: sunPath(),
  moon: 'M11 2C6 7 11 13 16 11C10 22 -5 7 11 2',
  bell:
    'M3 12.5Q4.5 11 4.5 8C4.5 0.5 13.5 0.5 13.5 8Q13.5 11 15 12.5Z' +
    'M9 1.5V2.5M7 15Q9 17 11 15',
  speaker:
    'M2 6H5L9 2.7V15.3L5 12H2Z' +
    'M12 6Q14.5 9 12 12M14.5 3.5Q18.5 9 14.5 14.5',
  box:
    'M2.5 5.3L9 2L15.5 5.3V12.7L9 16L2.5 12.7ZM9 9V16M5.8 3.7L12 7.2',
  download:
    'M9 1.8V11M5.5 7.5L9 11L12.5 7.5' +
    'M3 9V13.5Q3 15.5 5 15.5H13Q15 15.5 15 13.5V9',
  sparkle:
    'M10.5 4L12 8.5L16 10L12 11.5L10.5 16L9 11.5L5 10L9 8.5Z' +
    'M4 1.8V6.2M1.8 4H6.2',
  display: rounded(2, 2.5, 14, 10, 2) + 'M9 12.5V15.5M5.5 15.5H12.5',
  window: rounded(2, 3, 14, 12, 2) + 'M2 6.5H16' + circle(4.5, 4.8, 0.2) + circle(6.5, 4.8, 0.2),
  microphone:
    rounded(6.5, 1.5, 5, 10, 2.5) +
    'M4 8C4 16 14 16 14 8M9 14V16.5M6 16.5H12',
  cursor: 'M3 1.5L14 9L9.5 9.5L12 15L9 16.5L6.5 11L3 14Z',
  camera: rounded(1.5, 4.5, 10.5, 9, 2) + 'M12 7L16.5 4.5V13.5L12 11',
  folder:
    'M2 6V4Q2 2.5 4 2.5H7L9 4.5H14Q16 4.5 16 6.5V13.5Q16 15.5 14 15.5H4Q2 15.5 2 13.5V6L12 6',
  check: 'M5 9L8 12L13 6',
  checkCircle: circle(9, 9, 7) + 'M5 9L8 12L13 6',
  warning: 'M9 2L16.5 15H1.5ZM9 6V10' + circle(9, 12.5, 0.3),
  refresh:
    'M3 7C5 -0.5 13 1 14.5 4.5L14.5 1.5V5H11' +
    'M15 11C13 18.5 5 17 3.5 13.5L3.5 16.5V13H7',
  code: 'M5 4.5L1.5 9L5 13.5M13 4.5L16.5 9L13 13.5M10.5 3L7.5 15',
  feedback:
    'M5 2.5H13Q16 2.5 16 5.5V10Q16 13 13 13L8 13L4 16L4 12.8Q2 12.5 2 10V5.5Q2 2.5 5 2.5' +
    'M5.5 6.5H12.5M5.5 9.5H10',
  cup:
    'M3 5H12V10C12 16 3 16 3 10Z' +
    'M12 6C18 4 18 12 12 11M2 16H14M5 1.5V2.5M9 1.5V2.5',
  external: 'M4 14L14 4M6 4H14V12',
  chevron: 'M6 3.5L11.5 9L6 14.5',
  person: circle(9, 6, 3) + 'M2.5 16C3 10 15 10 15.5 16',
  close: 'M4.5 4.5L13.5 13.5M13.5 4.5L4.5 13.5',
  arrowLeft: 'M14.5 9H3.5M8.5 4L3.5 9L8.5 14',
  scene:
    rounded(2, 3.5, 14, 11, 2.5) +
    'M4.8 12L8 8.6L10.4 11L11.8 9.6L13.6 11.6' +
    circle(12.2, 6.6, 1.1),
  opening: rounded(2, 3, 14, 12, 2.5) + 'M7.6 6.6L11.8 9L7.6 11.4Z',
  zoom: zoomPath(),
  cursorMotion:
    'M7 2.5L15.5 8.2L11.9 8.7L13.8 13L11.6 14L9.8 9.8L7 12.4Z' +
    'M1.8 6.5H4M2.6 10H4.4M1.8 13.5H5',
  undo:
    'M7 3.8L3.8 7L7 10.2M3.8 7H11C15.8 7 15.8 14.2 11 14.2H6.5',
  plus: 'M9 3.5V14.5M3.5 9H14.5',
  trash:
    'M2.5 4.5H15.5M6.8 4.5L7.4 2.2H10.6L11.2 4.5' +
    'M4 4.5L4.9 14.4L6.4 15.8H11.6L13.1 14.4L14 4.5' +
    'M7.4 7.6L7.6 12.6M10.6 7.6L10.4 12.6',
  pencil: 'M3 15L3.6 11.6L12 3.2L14.8 6L6.4 14.4ZM10.4 4.8L13.2 7.6',
  share:
    'M9 11V2M5.5 5.5L9 2L12.5 5.5' +
    'M5.5 8.5H4.5Q3 8.5 3 10V14Q3 15.5 4.5 15.5H13.5Q15 15.5 15 14V10Q15 8.5 13.5 8.5H12.5',
  chevronDown: 'M4 6.5L9 11.5L14 6.5',
  layers: 'M9 2.5L16 6.5L9 10.5L2 6.5ZM2 10.5L9 14.5L16 10.5',
  play: 'M5.5 3.5L14 9L5.5 14.5Z',
  pause: 'M6 3.5V14.5M12 3.5V14.5',
  stop: rounded(4, 4, 10, 10, 2),
  previousFrame: 'M3.5 3.5V14.5M14 3.5L6 9L14 14.5Z',
  scissors: circle(4.5, 4.5, 2.3) + circle(4.5, 13.5, 2.3) + 'M6.3 6L15 14.5M6.3 12L15 3.5',
  minus: 'M3.5 9H14.5',
  waveform: waveformPath(),
  eye:
    'M1.5 9C5 2 13 2 16.5 9C13 16 5 16 1.5 9Z' + circle(9, 9, 2.3),
  eyeOff:
    'M1.5 9C5 2 13 2 16.5 9C13 16 5 16 1.5 9Z' + circle(9, 9, 2.3) +
    'M3 2.5L15 15.5',
  fit: 'M2.5 3V15M15.5 3V15M5.5 6L8.5 9L5.5 12M12.5 6L9.5 9L12.5 12',
  grid: rounded(2.5, 2.5, 13, 13, 2) + 'M7 2.5V15.5M11 2.5V15.5M2.5 7H15.5M2.5 11H15.5',
  crop: 'M5 2V13H16M2 5H13V16',
  layout: rounded(2, 3, 14, 12, 2) + rounded(5, 6, 8, 6, 1),
  magnet:
    'M3.5 2.5V9C3.5 17 14.5 17 14.5 9V2.5' +
    'M7 2.5V9C7 12.2 11 12.2 11 9V2.5' +
    'M3.5 2.5H7M11 2.5H14.5M3.5 5.5H7M11 5.5H14.5',
  clock: circle(9, 9, 7) + 'M9 5V9L12 11',
  cube:
    'M9 1.8L15.5 5.5V12.5L9 16.2L2.5 12.5V5.5Z' +
    'M2.5 5.5L9 9.2L15.5 5.5M9 9.2V16.2',
  link: rounded(1.5, 6, 9, 6, 3) + rounded(7.5, 6, 9, 6, 3),
  photoAdd:
    rounded(1.5, 2.5, 12, 10, 2) +
    'M3.8 10.5L6.6 7.4L8.8 9.6L10.2 8.2L11.6 9.6' +
    circle(10, 5.4, 0.9) +
    'M14.5 10.5V16.5M11.5 13.5H17.5',
  paste: rounded(3.5, 3, 11, 13.5, 2) + rounded(6.5, 1.5, 5, 3, 1.2) + 'M6.5 8.5H11.5M6.5 11.5H10',
  expand: 'M3 8V3H8M3 3L7.5 7.5M15 10V15H10M15 15L10.5 10.5',
  aspect: rounded(1.5, 3.5, 15, 11, 2.5) + 'M4.5 8.5V6.5H6.5M13.5 9.5V11.5H11.5',
  target:
    circle(9, 9, 6) + circle(9, 9, 1.2) +
    'M9 1.5V4M9 14V16.5M1.5 9H4M14 9H16.5',
  move:
    'M9 2V16M2 9H16' +
    'M6.8 4.2L9 2L11.2 4.2M6.8 13.8L9 16L11.2 13.8' +
    'M4.2 6.8L2 9L4.2 11.2M13.8 6.8L16 9L13.8 11.2',
  pin:
    'M9 16C6 12.5 3.5 10 3.5 7C3.5 0 14.5 0 14.5 7C14.5 10 12 12.5 9 16Z' +
    circle(9, 7, 2),
  speed: 'M2 12.5C2 3 16 3 16 12.5M9 12L12.5 7' + circle(9, 12, 1),
  drop: 'M9 2C9 2 2.5 16 9 16M9 2C9 2 15.5 16 9 16',
  halfCircle: circle(9, 9, 7) + 'M9 2V16M6 3V15M3.6 5V13',
  bookmark: 'M4.5 2H13.5V16L9 12.5L4.5 16Z',
  swap: 'M2 9H16M5 6L2 9L5 12M13 6L16 9L13 12',
  speakerOff:
    'M2 6H5L9 2.7V15.3L5 12H2Z' +
    'M12 6.5L16.5 11.5M16.5 6.5L12 11.5',
  cameraOff:
    rounded(1.5, 4.5, 10.5, 9, 2) + 'M12 7L16.5 4.5V13.5L12 11' +
    'M1.5 2L16.5 16',
  search: circle(7.8, 7.8, 5.2) + 'M11.6 11.6L16 16',
  noSymbol: circle(9, 9, 7) + 'M4 14L14 4',
  chevronLeft: 'M12 3.5L6.5 9L12 14.5',
  chevronUp: 'M4 11.5L9 6.5L14 11.5',
  noFrame: rounded(2, 3.5, 14, 11, 2.5) + 'M3 16L15 2',
  portrait: rounded(4.5, 1.5, 9, 15, 2.5),
  arrowRight: 'M3.5 9H14.5M9.5 4L14.5 9L9.5 14',
  arrowUpLeft: 'M14 14L4 4M4 10V4H10',
  arrowDownRight: 'M4 4L14 14M14 8V14H8',
  deleteLeft:
    'M6 3.5H15Q16.5 3.5 16.5 5V13Q16.5 14.5 15 14.5H6L1.5 9Z' +
    'M8.5 6.5L13 11.5M13 6.5L8.5 11.5',
  list: listPath(),
  presets: rounded(2, 2.5, 6, 6, 1.6) + rounded(10, 2.5, 6, 6, 1.6) + rounded(2, 10.5, 14, 5, 1.6),
  film: filmPath(),
};

/** 以水平镜像绘制的变体。 */
const MIRRORED_BASE: Record<string, string> = {
  redo: 'undo',
  nextFrame: 'previousFrame',
  deleteRight: 'deleteLeft',
};

export type LineIconKind = keyof typeof BASE_PATHS | keyof typeof MIRRORED_BASE;

export function lineIconStrokeWidth(size: number): number {
  return size >= 24 ? size / 14 : Math.min(Math.max(size / 12, 1.2), 1.55);
}

export function LineIcon({
  kind,
  size = 18,
  className,
  style,
}: {
  kind: LineIconKind;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const mirrored = kind in MIRRORED_BASE;
  const base = mirrored ? MIRRORED_BASE[kind as string] : (kind as string);
  const d = BASE_PATHS[base] ?? BASE_PATHS.info;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={lineIconStrokeWidth(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {mirrored ? (
        <g transform="matrix(-1 0 0 1 18 0)">
          <path d={d} />
        </g>
      ) : (
        <path d={d} />
      )}
    </svg>
  );
}
