import { Pressable, StyleSheet, Text, View } from "react-native";
import { radius, size, space, type, type AppColors } from "./theme";

export interface CategoryTabsProps {
  options: readonly { value: string; label: string }[];
  selected: string;
  onSelect: (value: string) => void;
  colors: AppColors;
  label: string;
  panelId: string;
}

export function CategoryTabs({
  options,
  selected,
  onSelect,
  colors,
  label,
  panelId,
}: CategoryTabsProps) {
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={styles.tabs}
    >
      {options.map((option) => (
        <Pressable
          key={option.value}
          nativeID={`${panelId}-${option.value}`}
          accessibilityRole="tab"
          accessibilityState={{ selected: selected === option.value }}
          onPress={() => onSelect(option.value)}
          style={({ pressed }) => [
            styles.tab,
            {
              borderColor:
                selected === option.value ? colors.accent : colors.borderStrong,
              backgroundColor: pressed
                ? colors.surfaceMuted
                : selected === option.value
                  ? colors.accentSoft
                  : colors.surface,
            },
          ]}
        >
          <Text style={[styles.text, { color: colors.text }]}>
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  tab: {
    minHeight: size.controlMd,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    justifyContent: "center",
    maxWidth: "100%",
  },
  text: {
    fontSize: type.label,
    lineHeight: type.captionLine,
    fontWeight: "600",
    flexShrink: 1,
  },
});
