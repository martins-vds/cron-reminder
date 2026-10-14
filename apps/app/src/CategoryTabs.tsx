import { useEffect, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
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
  const scroller = useRef<ScrollView>(null);
  const positions = useRef(new Map<string, number>());
  useEffect(() => {
    const position = positions.current.get(selected);
    if (position === undefined) return;
    scroller.current?.scrollTo({
      x: Math.max(0, position - space.lg),
      animated: false,
    });
  }, [selected]);
  return (
    <ScrollView
      ref={scroller}
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      accessibilityLabel={label}
      contentContainerStyle={[
        styles.tabs,
        { borderBottomColor: colors.border },
      ]}
    >
      {options.map((option) => (
        <Pressable
          key={option.value}
          nativeID={`${panelId}-${option.value}`}
          accessibilityRole="tab"
          accessibilityState={{ selected: selected === option.value }}
          onPress={() => onSelect(option.value)}
          onLayout={(event) => {
            const position = event.nativeEvent.layout.x;
            positions.current.set(option.value, position);
            if (selected === option.value)
              scroller.current?.scrollTo({
                x: Math.max(0, position - space.lg),
                animated: false,
              });
          }}
          style={({ pressed }) => [
            styles.tab,
            {
              borderBottomColor:
                selected === option.value ? colors.accent : "transparent",
              backgroundColor: pressed ? colors.surfaceMuted : colors.surface,
            },
          ]}
        >
          <Text
            style={[
              styles.text,
              {
                color: colors.text,
                fontWeight: selected === option.value ? "700" : "500",
              },
            ]}
          >
            {option.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: "row",
    alignItems: "stretch",
    paddingRight: space["3xl"],
    borderBottomWidth: 1,
  },
  tab: {
    minHeight: size.controlMd,
    flexShrink: 0,
    borderBottomWidth: space.xxs,
    borderTopLeftRadius: radius.sm,
    borderTopRightRadius: radius.sm,
    paddingHorizontal: space.lg,
    justifyContent: "center",
  },
  text: {
    fontSize: type.label,
    lineHeight: type.captionLine,
  },
});
