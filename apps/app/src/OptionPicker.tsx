import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRef, useState, type ElementRef } from "react";
import { Sheet } from "./Sheet";
import { radius, size, space, type, type AppColors } from "./theme";

export interface PickerOption {
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
  cancelLabel,
  changeLabel,
  selectedLabel,
}: OptionPickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<ElementRef<typeof Pressable>>(null);
  const selectedRef = useRef<ElementRef<typeof Pressable>>(null);
  const selectedOption =
    options.find((option) => option.value === value) ?? options[0];

  const close = () => setOpen(false);
  const select = (option: PickerOption) => {
    onChange(option.value);
    AccessibilityInfo.announceForAccessibility(`${label}: ${option.label}`);
    close();
  };

  if (!selectedOption) return null;

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <Pressable
        ref={triggerRef}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${selectedOption.label}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.trigger,
          {
            backgroundColor: pressed ? colors.surfaceMuted : colors.surface,
            borderColor: colors.borderStrong,
          },
        ]}
      >
        <Text style={[styles.triggerText, { color: colors.text }]}>
          {selectedOption.label}
        </Text>
        <Text aria-hidden style={[styles.disclosure, { color: colors.muted }]}>
          {changeLabel}
        </Text>
      </Pressable>
      <Sheet
        visible={open}
        title={label}
        closeLabel={cancelLabel}
        colors={colors}
        onClose={close}
        returnFocusRef={triggerRef}
        initialFocusRef={selectedRef}
        bodyAccessibilityRole="radiogroup"
        nativeID={`option-picker-${label.toLowerCase().replace(/\s+/g, "-")}`}
        footer={
          <Pressable
            accessibilityRole="button"
            onPress={close}
            style={({ pressed }) => [
              styles.cancel,
              {
                backgroundColor: pressed
                  ? colors.surfaceMuted
                  : colors.surfaceElevated,
                borderColor: colors.borderStrong,
              },
            ]}
          >
            <Text style={[styles.cancelText, { color: colors.text }]}>
              {cancelLabel}
            </Text>
          </Pressable>
        }
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              ref={selected ? selectedRef : undefined}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              onPress={() => select(option)}
              style={({ pressed }) => [
                styles.option,
                {
                  backgroundColor:
                    selected || pressed
                      ? colors.accentSoft
                      : colors.surfaceElevated,
                  borderColor: selected ? colors.accent : colors.border,
                },
              ]}
            >
              <Text
                style={[
                  styles.optionText,
                  { color: selected ? colors.accent : colors.text },
                ]}
              >
                {option.label}
              </Text>
              {selected ? (
                <Text style={[styles.selectedText, { color: colors.accent }]}>
                  {selectedLabel}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </Sheet>
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
  trigger: {
    width: "100%",
    minHeight: size.controlLg,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  triggerText: {
    flex: 1,
    fontSize: type.body,
    lineHeight: type.bodyLine,
    fontWeight: "600",
  },
  disclosure: {
    fontSize: type.caption,
    lineHeight: type.captionLine,
    fontWeight: "700",
  },
  option: {
    minHeight: size.controlLg,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  optionText: {
    flex: 1,
    fontSize: type.body,
    lineHeight: type.bodyLine,
    fontWeight: "600",
  },
  selectedText: {
    fontSize: type.caption,
    lineHeight: type.captionLine,
    fontWeight: "700",
  },
  cancel: {
    minHeight: size.controlMd,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg,
  },
  cancelText: {
    fontSize: type.label,
    lineHeight: type.captionLine,
    fontWeight: "700",
  },
});
