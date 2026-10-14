import {
  AccessibilityInfo,
  InteractionManager,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type AccessibilityRole,
} from "react-native";
import {
  useEffect,
  useRef,
  useState,
  type ElementRef,
  type ReactNode,
  type RefObject,
} from "react";
import { X } from "lucide-react-native";
import { radius, size, space, type, type AppColors } from "./theme";

export interface SheetFocusable {
  focus: () => void;
}

interface SheetProps {
  visible: boolean;
  title: string;
  description?: string;
  closeLabel: string;
  colors: AppColors;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  returnFocusRef?: RefObject<SheetFocusable | null>;
  initialFocusRef?: RefObject<SheetFocusable | null>;
  bodyAccessibilityRole?: AccessibilityRole;
  bodyTestID?: string;
  nativeID?: string;
}

export function Sheet({
  visible,
  title,
  description,
  closeLabel,
  colors,
  onClose,
  children,
  footer,
  returnFocusRef,
  initialFocusRef,
  bodyAccessibilityRole,
  bodyTestID,
  nativeID = "sheet",
}: SheetProps) {
  const { width } = useWindowDimensions();
  const [reduceMotion, setReduceMotion] = useState(false);
  const dialogRef = useRef<ElementRef<typeof View>>(null);
  const wide = width >= size.breakpointWide;

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!visible || Platform.OS !== "web") return;
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (
        typeof HTMLElement === "undefined" ||
        !(dialog instanceof HTMLElement)
      )
        return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [role="button"]:not([aria-disabled="true"]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          element.offsetParent !== null &&
          element.getAttribute("aria-hidden") !== "true",
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => document.removeEventListener("keydown", trapFocus);
  }, [visible]);

  const focus = (target: SheetFocusable | null | undefined) => {
    if (!target) return;
    target.focus();
  };
  const close = () => {
    onClose();
    InteractionManager.runAfterInteractions(() =>
      focus(returnFocusRef?.current),
    );
  };

  return (
    <Modal
      animationType={reduceMotion ? "none" : wide ? "fade" : "slide"}
      transparent
      visible={visible}
      accessibilityLabel={title}
      onRequestClose={close}
      onShow={() =>
        InteractionManager.runAfterInteractions(() =>
          focus(initialFocusRef?.current),
        )
      }
    >
      <View style={[styles.overlay, wide && styles.overlayWide]}>
        <Pressable
          accessible={Platform.OS === "web" ? undefined : false}
          aria-hidden={Platform.OS === "web" ? true : undefined}
          onPress={close}
          testID={`${nativeID}-backdrop`}
          style={[styles.backdrop, { backgroundColor: colors.overlay }]}
        />
        <View
          ref={dialogRef}
          nativeID={nativeID}
          accessibilityViewIsModal
          style={[
            styles.sheet,
            wide && styles.sheetWide,
            {
              backgroundColor: colors.surfaceElevated,
              borderColor: colors.border,
            },
          ]}
        >
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <View style={styles.headerCopy}>
              <Text
                nativeID={`${nativeID}-title`}
                style={[styles.title, { color: colors.text }]}
              >
                {title}
              </Text>
              {description ? (
                <Text style={[styles.description, { color: colors.muted }]}>
                  {description}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={closeLabel}
              onPress={close}
              style={({ pressed }) => [
                styles.close,
                {
                  backgroundColor: pressed
                    ? colors.surfaceMuted
                    : colors.surfaceElevated,
                  borderColor: colors.borderStrong,
                },
              ]}
            >
              <X
                accessible={Platform.OS === "web" ? undefined : false}
                aria-hidden={Platform.OS === "web" ? true : undefined}
                color={colors.text}
                size={size.navigationIcon}
              />
            </Pressable>
          </View>
          <ScrollView
            testID={bodyTestID}
            accessibilityRole={bodyAccessibilityRole}
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
          {footer ? (
            <View style={[styles.footer, { borderTopColor: colors.border }]}>
              {footer}
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  overlayWide: {
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
  },
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  sheet: {
    maxHeight: "90%",
    borderWidth: 1,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    overflow: "hidden",
  },
  sheetWide: {
    width: "100%",
    maxWidth: size.readable,
    maxHeight: "80%",
    borderRadius: radius.xl,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.lg,
    padding: space.xl,
    borderBottomWidth: 1,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
    gap: space.xs,
  },
  title: {
    fontSize: type.heading,
    lineHeight: type.headingLine,
    fontWeight: "700",
  },
  description: {
    maxWidth: size.readable,
    fontSize: type.body,
    lineHeight: type.bodyLine,
  },
  close: {
    width: size.controlMd,
    height: size.controlMd,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flexShrink: 1,
  },
  bodyContent: {
    padding: space.xl,
    gap: space.lg,
  },
  footer: {
    padding: space.xl,
    borderTopWidth: 1,
  },
});
