import { createElement, useState, type ChangeEvent } from "react";
import { Text, View } from "react-native";
import { darkColors, radius, size, space, type, type AppColors } from "./theme";

interface PickerFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  colors: AppColors;
  locale: string;
  hint?: string;
}

export function TimeField(props: PickerFieldProps) {
  return (
    <WebPickerField
      {...props}
      inputType="time"
      inputValue={props.value}
      onInputChange={props.onChange}
    />
  );
}

export function DateTimeField(props: PickerFieldProps) {
  return (
    <WebPickerField
      {...props}
      inputType="datetime-local"
      inputValue={toLocalDateTime(props.value)}
      onInputChange={(value) => {
        const selected = new Date(value);
        props.onChange(
          Number.isNaN(selected.getTime()) ? "" : selected.toISOString(),
        );
      }}
    />
  );
}

function WebPickerField({
  label,
  inputType,
  inputValue,
  onInputChange,
  colors,
  hint,
}: PickerFieldProps & {
  inputType: "time" | "datetime-local";
  inputValue: string;
  onInputChange: (value: string) => void;
}) {
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
      {createElement("input", {
        "aria-label": label,
        type: inputType,
        value: inputValue,
        onChange: (event: ChangeEvent<HTMLInputElement>) =>
          onInputChange(event.currentTarget.value),
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
        },
      })}
      {hint ? (
        <Text
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

function toLocalDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
