/**
 * ui.tsx — the primitives.
 */
import React from "react";
import {
  View, Text, Pressable, StyleSheet, ViewStyle, TextStyle, ScrollView,
} from "react-native";
import { useTheme, radius, Theme } from "./theme";

export function Screen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[{ flex: 1, backgroundColor: t.card }, style]}>{children}</View>;
}

export function Body({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 20, paddingTop: 4, gap: 12 }}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function Nav({ title, sub, onBack, action }: {
  title: string; sub?: string; onBack?: () => void;
  action?: { label: string; onPress: () => void };
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 10 }}>
      {onBack && (
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={{ fontSize: 28, color: t.ink2, lineHeight: 30 }}>‹</Text>
        </Pressable>
      )}
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 22, fontWeight: "800", color: t.ink, letterSpacing: -0.5 }}>{title}</Text>
        {!!sub && <Text numberOfLines={1} style={{ fontSize: 11.5, color: t.ink3, fontWeight: "600" }}>{sub}</Text>}
      </View>
      {action && (
        <Pressable onPress={action.onPress} hitSlop={10}>
          <Text style={{ fontSize: 14, fontWeight: "700", color: t.accent }}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

type BtnKind = "accent" | "ghost" | "dark" | "green" | "amber" | "flat";

export function Button({ label, onPress, kind = "accent", small, disabled, style, testID }: {
  label: string; onPress?: () => void; kind?: BtnKind;
  small?: boolean; disabled?: boolean; style?: ViewStyle; testID?: string;
}) {
  const t = useTheme();
  const bg: Record<BtnKind, string> = {
    accent: t.accent, ghost: "transparent", dark: t.ink,
    green: t.court, amber: t.amber, flat: "transparent",
  };
  const fg: Record<BtnKind, string> = {
    accent: t.accentInk, ghost: t.ink, dark: t.paper,
    green: "#fff", amber: "#fff", flat: t.ink3,
  };
  return (
    <Pressable
      testID={testID}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        {
          backgroundColor: bg[kind],
          borderWidth: kind === "ghost" ? 1 : 0,
          borderColor: t.line,
          borderRadius: radius.pill,
          paddingVertical: small ? 9 : 14,
          paddingHorizontal: small ? 15 : 22,
          alignItems: "center",
          opacity: disabled ? 0.4 : pressed ? 0.85 : 1,
          transform: [{ scale: pressed && !disabled ? 0.98 : 1 }],
        },
        style,
      ]}
    >
      <Text style={{ color: fg[kind], fontWeight: "700", fontSize: small ? 12.5 : 15, letterSpacing: -0.2 }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Card({ children, tone = "plain", onPress }: {
  children: React.ReactNode;
  tone?: "plain" | "urgent" | "filled" | "ask";
  onPress?: () => void;
}) {
  const t = useTheme();
  const tones = {
    plain: { bg: t.card, border: t.lineSoft },
    urgent: { bg: t.accentWash, border: t.accent },   // somebody is missing
    filled: { bg: t.courtWash, border: t.court },     // it's sorted
    ask: { bg: t.amberWash, border: t.amber },
  }[tone];
  const inner = (
    <View style={{
      backgroundColor: tones.bg, borderColor: tones.border, borderWidth: 1,
      borderRadius: radius.lg, padding: 14, gap: 9,
    }}>
      {children}
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.985 : 1 }] })}>
      {inner}
    </Pressable>
  ) : inner;
}

export function Block({ title, children }: { title?: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{
      borderWidth: 1, borderColor: t.lineSoft, borderRadius: radius.md,
      backgroundColor: t.card, padding: 14, gap: 9,
    }}>
      {!!title && <Label>{title}</Label>}
      {children}
    </View>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <Text style={{
      fontSize: 10, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", color: t.ink3,
    }}>{children}</Text>
  );
}

export function Row({ left, right }: { left: React.ReactNode; right?: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <View style={{ flex: 1 }}>{left}</View>
      {right}
    </View>
  );
}

export function P({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  const t = useTheme();
  return <Text style={[{ fontSize: 14, color: t.ink2, lineHeight: 21 }, style]}>{children}</Text>;
}

export function Note({ children, tone }: { children: React.ReactNode; tone?: "amber" }) {
  const t = useTheme();
  return (
    <Text style={{ fontSize: 11.5, lineHeight: 17, color: tone === "amber" ? t.amber : t.ink3 }}>
      {children}
    </Text>
  );
}

export function Tag({ children, tone = "plain" }: {
  children: React.ReactNode; tone?: "plain" | "new" | "good" | "warn";
}) {
  const t = useTheme();
  const c = {
    plain: { bg: t.card2, fg: t.ink2 },
    new: { bg: t.accentWash, fg: t.accent },
    good: { bg: t.courtWash, fg: t.court },
    warn: { bg: t.amberWash, fg: t.amber },
  }[tone];
  return (
    <View style={{ backgroundColor: c.bg, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 2 }}>
      <Text style={{ fontSize: 10, fontWeight: "700", color: c.fg }}>{children}</Text>
    </View>
  );
}

const PIP_COLOURS = ["#3C7A5A", "#7A4E9B", "#2F6F8F", "#B0653C", "#8F4358", "#4A6B8A", "#6B7A3C"];

/**
 * A player. `anon` is the disclosure ladder made visible: before you are in a
 * game the roster is grey blanks, because those are people and you have not
 * earned their names.
 */
export function Pip({ initials, anon, empty, i = 0, ring }: {
  initials?: string; anon?: boolean; empty?: boolean; i?: number; ring?: string;
}) {
  const t = useTheme();
  const base: ViewStyle = {
    width: 28, height: 28, borderRadius: 14, borderWidth: 2,
    borderColor: ring ?? t.card, alignItems: "center", justifyContent: "center",
    marginLeft: i === 0 ? 0 : -7,
  };
  if (empty) {
    return (
      <View style={[base, { backgroundColor: "transparent", borderColor: t.accent, borderStyle: "dashed" }]}>
        <Text style={{ color: t.accent, fontSize: 14 }}>+</Text>
      </View>
    );
  }
  if (anon) return <View style={[base, { backgroundColor: t.line }]} />;
  return (
    <View style={[base, { backgroundColor: PIP_COLOURS[i % PIP_COLOURS.length] }]}>
      <Text style={{ color: "#fff", fontSize: 10.5, fontWeight: "700" }}>{initials}</Text>
    </View>
  );
}

export function Meter({ value, max, tone }: { value: number; max: number; tone?: "close" }) {
  const t = useTheme();
  const pct = Math.min(100, Math.round((value / Math.max(max, 1)) * 100));
  return (
    <View style={{ height: 5, borderRadius: 999, backgroundColor: t.lineSoft, overflow: "hidden" }}>
      <View style={{ width: `${pct}%`, height: "100%", backgroundColor: tone === "close" ? t.amber : t.accent }} />
    </View>
  );
}

export function Chip({ label, on, onPress }: { label: string; on?: boolean; onPress?: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} style={{
      borderWidth: 1, borderRadius: radius.pill, paddingVertical: 8, paddingHorizontal: 13,
      backgroundColor: on ? t.ink : t.card, borderColor: on ? t.ink : t.line,
    }}>
      <Text style={{ fontSize: 12.5, fontWeight: "600", color: on ? t.paper : t.ink2 }}>{label}</Text>
    </Pressable>
  );
}

export function Tabs({ active, onSelect, badge }: {
  active: string; onSelect: (k: string) => void; badge?: number;
}) {
  const t = useTheme();
  const items = [
    { k: "home", label: "Near you" },
    { k: "sports", label: "Sports" },
    { k: "people", label: "People" },
    { k: "you", label: "You" },
  ];
  return (
    <View style={{
      flexDirection: "row", borderTopWidth: 1, borderTopColor: t.lineSoft,
      paddingTop: 8, paddingBottom: 24, backgroundColor: t.card,
    }}>
      {items.map((i) => (
        <Pressable key={i.k} onPress={() => onSelect(i.k)} style={{ flex: 1, alignItems: "center", gap: 3 }}>
          <Text style={{
            fontSize: 10, fontWeight: "700",
            color: active === i.k ? t.ink : t.ink3,
          }}>{i.label}</Text>
          <View style={{
            height: 2, width: 20, borderRadius: 2,
            backgroundColor: active === i.k ? t.accent : "transparent",
          }} />
        </Pressable>
      ))}
    </View>
  );
}

export const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
});

export { useTheme };
export type { Theme };
