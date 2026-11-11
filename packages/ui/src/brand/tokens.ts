/** Bakery brand tokens. Hand-authored; not generated from Paper. */

/** Brand colours of the mascot art, plus the three dark-surface adjustments. */
export const brandPalette = {
  /** Warm near-black brown: outlines, features and the belt on light fills. */
  cocoa: "#3A1E0E",
  /** Bun orange: the mascot's head and body fill on light surfaces. */
  golden: "#F7A93B",
  /** Warm cream: face plate, toque and the light tile. */
  cream: "#FFF1D6",
  /** Burnt orange: conveyor rollers and belt trim. */
  terracotta: "#CF5A2E",
  /** Soft salmon: cheeks. */
  blush: "#F2906C",
  /** Warm off-white that replaces cocoa for the outer outline and wordmark on dark surfaces. */
  creamOnDark: "#FBEFDB",
  /** Bun fill on dark surfaces: golden pulled ~8% darker so it does not glow. */
  doughOnDark: "#E6992F",
  /** Face plate and toque on dark surfaces: cream pulled ~7% darker so it does not glow. */
  plateOnDark: "#F0E0C4",
} as const;

/** Name of a brand colour in `brandPalette`. */
export type BrandColorName = keyof typeof brandPalette;

/** Foundation colour tokens a logo role may read (names from `foundations/tokens.ts`). */
export type LogoFoundationToken =
  | "color.foreground"
  | "color.surface"
  | "color.canvas"
  | "color.primary";

/** Theme block of `foundations/theme.css` a foundation token is read from. */
export type LogoTheme = "light" | "dark";

/** Where a logo role takes its colour from. */
export type LogoRoleSource =
  | { readonly source: "palette"; readonly name: BrandColorName }
  | {
    readonly source: "foundation";
    readonly name: LogoFoundationToken;
    readonly theme: LogoTheme;
  }
  | { readonly source: "none" }
  | { readonly source: "knockout" };

/** Colour roles in the art; `tile` is the rounded tile behind tile variants. */
export type LogoRole =
  | "outline"
  | "line"
  | "feature"
  | "dough"
  | "plate"
  | "belt"
  | "roller"
  | "blush"
  | "type"
  | "tile";

/** Ids of the logo colour variants, exactly as shipped in `assets/brand/logo`. */
export type LogoVariantId =
  | "color-light"
  | "color-dark"
  | "mono-dark"
  | "mono-light"
  | "on-brand"
  | "tile-light"
  | "tile-dark";

/** One variant: label, usage rule and the colour role assignments. */
export type LogoVariant = {
  readonly label: string;
  readonly use: string;
  readonly roles: Readonly<Record<LogoRole, LogoRoleSource>>;
};

const palette = (name: BrandColorName) =>
  ({ source: "palette", name }) as const;
const foundation = (name: LogoFoundationToken, theme: LogoTheme) =>
  ({ source: "foundation", name, theme }) as const;
const none = { source: "none" } as const;
const knockout = { source: "knockout" } as const;

const inkLight = foundation("color.foreground", "light");
const inkDark = foundation("color.foreground", "dark");

const colorLight = {
  outline: palette("cocoa"),
  line: palette("cocoa"),
  feature: palette("cocoa"),
  dough: palette("golden"),
  plate: palette("cream"),
  belt: palette("cocoa"),
  roller: palette("terracotta"),
  blush: palette("blush"),
  type: palette("cocoa"),
  tile: none,
} as const;

const colorDark = {
  outline: palette("creamOnDark"),
  line: palette("cocoa"),
  feature: palette("cocoa"),
  dough: palette("doughOnDark"),
  plate: palette("plateOnDark"),
  belt: palette("cocoa"),
  roller: palette("terracotta"),
  blush: palette("blush"),
  type: palette("creamOnDark"),
  tile: none,
} as const;

const mono = (ink: LogoRoleSource) =>
  ({
    outline: ink,
    line: ink,
    feature: ink,
    dough: none,
    plate: none,
    belt: ink,
    roller: knockout,
    blush: none,
    type: ink,
    tile: none,
  }) as const;

/** Colour role assignments per logo variant; the single source for every logo build script. */
export const logoVariants = {
  "color-light": {
    label: "Full colour · light surfaces",
    use: "Default. Light surfaces and canvases, documents, web headers.",
    roles: colorLight,
  },
  "color-dark": {
    label: "Full colour · dark surfaces",
    use:
      "Dark surfaces. Outer outline and wordmark turn warm cream; fills are toned down.",
    roles: colorDark,
  },
  "mono-dark": {
    label: "Mono · dark ink",
    use:
      "Single ink for print, embossing and light accent fills. Foundation foreground ink.",
    roles: mono(inkLight),
  },
  "mono-light": {
    label: "Mono · light ink (reversed)",
    use:
      "Single light ink on dark or saturated fills. Foundation dark-theme foreground.",
    roles: mono(inkDark),
  },
  "on-brand": {
    label: "On brand orange",
    use: "Brand orange fills. Dough drops out so the surface shows through.",
    roles: { ...colorLight, dough: none },
  },
  "tile-light": {
    label: "Tile · light",
    use:
      "App icon, favicon and home-screen tile for light contexts. Mark on a cream rounded tile.",
    roles: { ...colorLight, type: none, tile: palette("cream") },
  },
  "tile-dark": {
    label: "Tile · dark",
    use:
      "App icon and favicon tile for dark contexts. Mark on a dark-surface rounded tile.",
    roles: {
      ...colorDark,
      type: none,
      tile: foundation("color.surface", "dark"),
    },
  },
} as const satisfies Record<LogoVariantId, LogoVariant>;
