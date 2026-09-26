import { createElement, useState, type ChangeEvent } from "react";
import { Text, View } from "react-native";
import { darkColors, radius, size, space, type, type AppColors } from "./theme";

interface PickerOption {
  value: string;
  label: string;
}

interface OptionPickerProps {
  label: string;
  value: string;
  options: readonly PickerOption[];
  onChange: (value: string) => void;
  colors: AppColors;
  cancelLabel: string;
  changeLabel: string;
  selectedLabel: string;
}

export function OptionPicker({
  label,
  value,
  options,
  onChange,
  colors,
}: OptionPickerProps) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ minWidth: 0 }}>
      <Text
        style={{
          color: colors.text,
          fontSize: type.label,
          lineHeight: type.captionLine,
          fontWeight: "700",
          marginBottom: space.sm,
        }}
      >
        {label}
      </Text>
      {createElement(
        "select",
        {
          "aria-label": label,
          value,
          onChange: (event: ChangeEvent<HTMLSelectElement>) =>
            onChange(event.currentTarget.value),
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          style: {
            boxSizing: "border-box",
            width: "100%",
            minWidth: 0,
            minHeight: size.controlLg,
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: focused ? colors.focus : colors.borderStrong,
            borderRadius: radius.md,
            paddingInline: space.lg,
            backgroundColor: colors.surface,
            color: colors.text,
            colorScheme:
              colors.background === darkColors.background ? "dark" : "light",
            fontFamily: type.family,
            fontSize: type.body,
            fontWeight: "600",
          },
        },
        options.map((option) =>
          createElement(
            "option",
            { key: option.value, value: option.value },
            option.label,
          ),
        ),
      )}
    </View>
  );
}
