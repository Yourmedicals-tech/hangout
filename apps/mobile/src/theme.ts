/**
 * theme.ts — "floodlit"
 *
 * Grounded in an actual Friday-night sports hall, not app-store gloss.
 * Cool chalk grey-green ground, green-black ink, and a single hot cricket-ball
 * vermilion spent ONLY on "act now" — the empty slot, the join button. A court
 * green means "sorted".
 *
 * The whole app is really two states, and the colour carries them:
 *   RED   → somebody is missing
 *   GREEN → it's sorted
 */
import { useColorScheme } from "react-native";

/** `as const` here would make every colour a literal type, and then the dark
 *  theme could never satisfy it. A plain record of strings is what we want. */
export interface Palette {
  ink: string; ink2: string; ink3: string;
  paper: string; card: string; card2: string;
  line: string; lineSoft: string;
  accent: string; accentInk: string; accentWash: string;
  court: string; courtWash: string;
  amber: string; amberWash: string;
}

const light: Palette = {
  ink: "#0F1512",
  ink2: "#3D4A43",
  ink3: "#6B7A72",
  paper: "#E8EAE4",
  card: "#FCFDFB",
  card2: "#F1F3EE",
  line: "#C9CEC5",
  lineSoft: "#DEE2DA",
  accent: "#E8452F",       // somebody is missing
  accentInk: "#FFFFFF",
  accentWash: "#FCE9E5",
  court: "#0B6E4F",        // it's sorted
  courtWash: "#DDEDE5",
  amber: "#8A5200",
  amberWash: "#F8EEDC",
};

const dark: Palette = {
  ink: "#E9ECE5",
  ink2: "#A9B4AC",
  ink3: "#7C8981",
  paper: "#0A0E0C",
  card: "#171F1A",
  card2: "#1E2721",
  line: "#2C382F",
  lineSoft: "#232D26",
  accent: "#FF6248",
  accentInk: "#1A0B07",
  accentWash: "#3A1A13",
  court: "#35BE8B",
  courtWash: "#1B3529",
  amber: "#E0A44A",
  amberWash: "#3A2E15",
};

export type Theme = Palette;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

export const radius = { sm: 8, md: 14, lg: 18, pill: 999 } as const;
export const space = (n: number) => n * 4;
