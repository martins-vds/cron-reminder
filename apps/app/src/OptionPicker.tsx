import {
  AccessibilityInfo,
  findNodeHandle,
  InteractionManager,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useEffect, useRef, useState, type ElementRef } from "react";
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
  const [reduceMotion, setReduceMotion] = useState(false);
  const triggerRef = useRef<ElementRef<typeof Pressable>>(null);
  const selectedRef = useRef<ElementRef<typeof Pressable>>(null);
  const selectedOption =
    options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => subscription.remove();
  }, []);

  const focus = (target: ElementRef<typeof Pressable> | null) => {
    const node = findNodeHandle(target);
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  };
  const close = () => {
    setOpen(false);
    InteractionManager.runAfterInteractions(() => focus(triggerRef.current));
  };
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
      <Modal
        animationType={reduceMotion ? "none" : "slide"}
        transparent
        visible={open}
        onRequestClose={close}
        onShow={() => focus(selectedRef.current)}
      >
        <View style={styles.overlay}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={cancelLabel}
            onPress={close}
            style={[styles.backdrop, { backgroundColor: colors.overlay }]}
          />
          <View
            accessibilityViewIsModal
            style={[
              styles.sheet,
              {
                backgroundColor: colors.surfaceElevated,
                borderColor: colors.border,
              },
            ]}
          >
            <Text style={[styles.sheetTitle, { color: colors.text }]}>
              {label}
            </Text>
            <ScrollView
              accessibilityRole="radiogroup"
              style={styles.optionsScroll}
              contentContainerStyle={styles.options}
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
                      <Text
                        style={[styles.selectedText, { color: colors.accent }]}
                      >
                        {selectedLabel}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
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
          </View>
        </View>
      </Modal>
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
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  sheet: {
    borderWidth: 1,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: space.xl,
    gap: space.lg,
  },
  sheetTitle: {
    fontSize: type.heading,
    lineHeight: type.headingLine,
    fontWeight: "700",
  },
  options: { gap: space.sm },
  optionsScroll: { flexShrink: 1 },
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
