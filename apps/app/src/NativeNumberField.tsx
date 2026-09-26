import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { radius, size, space, type, type AppColors } from "./theme";

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
  hint,
}: NumberFieldProps) {
  const [focused, setFocused] = useState(false);
  const numericValue = Number(value);
  const invalid =
    value.trim() !== "" &&
    (!Number.isInteger(numericValue) ||
      numericValue < minimum ||
      numericValue > maximum);

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityValue={{
          min: minimum,
          max: maximum,
          now: Number.isFinite(numericValue) ? numericValue : undefined,
        }}
        aria-invalid={invalid || undefined}
        value={value}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        keyboardType="number-pad"
        inputMode="numeric"
        style={[
          styles.input,
          {
            color: colors.text,
            borderColor: invalid
              ? colors.danger
              : focused
                ? colors.focus
                : colors.borderStrong,
            backgroundColor: colors.surface,
          },
        ]}
      />
      {hint ? (
        <Text style={[styles.hint, { color: colors.subtle }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { minWidth: 0 },
  label: {
    fontSize: type.label,
    lineHeight: type.captionLine,
    fontWeight: "700",
    marginBottom: space.sm,
  },
  input: {
    width: "100%",
    minWidth: 0,
    minHeight: size.controlLg,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    fontSize: type.body,
  },
  hint: {
    marginTop: space.xs,
    fontSize: type.caption,
    lineHeight: type.captionLine,
  },
});
