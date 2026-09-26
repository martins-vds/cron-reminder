import { createElement, useId, useState, type ChangeEvent } from "react";
import { Text, View } from "react-native";
import { darkColors, radius, size, space, type, type AppColors } from "./theme";

interface NumberFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  colors: AppColors;
  minimum: number;
  maximum: number;
  step?: number;
  hint?: string;
}

export function NumberField({
  label,
  value,
  onChange,
  colors,
  minimum,
  maximum,
  step = 1,
  hint,
}: NumberFieldProps) {
  const [focused, setFocused] = useState(false);
  const hintId = useId();
  const numericValue = Number(value);
  const invalid =
    value.trim() !== "" &&
    (!Number.isInteger(numericValue) ||
      numericValue < minimum ||
      numericValue > maximum);

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
      {createElement("input", {
        "aria-label": label,
        "aria-describedby": hint ? hintId : undefined,
        "aria-invalid": invalid || undefined,
        type: "number",
        inputMode: "numeric",
        min: minimum,
        max: maximum,
        step,
        value,
        onChange: (event: ChangeEvent<HTMLInputElement>) =>
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
          borderColor: invalid
            ? colors.danger
            : focused
              ? colors.focus
              : colors.borderStrong,
          borderRadius: radius.md,
          paddingInline: space.lg,
          backgroundColor: colors.surface,
          color: colors.text,
          colorScheme:
            colors.background === darkColors.background ? "dark" : "light",
          fontFamily: type.family,
          fontSize: type.body,
        },
      })}
      {hint ? (
        <Text
          nativeID={hintId}
          style={{
            color: colors.subtle,
            marginTop: space.xs,
            fontSize: type.caption,
            lineHeight: type.captionLine,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
