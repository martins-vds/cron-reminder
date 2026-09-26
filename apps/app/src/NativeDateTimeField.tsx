import DateTimePicker, {
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { radius, size, space, type, type AppColors } from "./theme";

interface PickerFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  colors: AppColors;
  locale: string;
  hint?: string;
}

export function TimeField(props: PickerFieldProps) {
  const date = timeToDate(props.value);
  const [open, setOpen] = useState(false);
  const updateTime = (event: DateTimePickerEvent, selected?: Date) => {
    if (Platform.OS === "android") setOpen(false);
    if (event.type === "set" && selected) props.onChange(formatTime(selected));
  };

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: props.colors.text }]}>
        {props.label}
      </Text>
      {Platform.OS === "ios" ? (
        <DateTimePicker
          value={date}
          mode="time"
          display="compact"
          locale={props.locale}
          onChange={updateTime}
          accentColor={props.colors.accent}
          style={styles.iosPicker}
        />
      ) : (
        <>
          <PickerButton
            label={date.toLocaleTimeString(props.locale, {
              hour: "2-digit",
              minute: "2-digit",
            })}
            accessibilityLabel={props.label}
            colors={props.colors}
            onPress={() => setOpen(true)}
          />
          {open ? (
            <DateTimePicker
              value={date}
              mode="time"
              display="default"
              is24Hour
              onChange={updateTime}
            />
          ) : null}
        </>
      )}
      {props.hint ? (
        <Text style={[styles.hint, { color: props.colors.subtle }]}>
          {props.hint}
        </Text>
      ) : null}
    </View>
  );
}

export function DateTimeField(props: PickerFieldProps) {
  const date = dateTimeToDate(props.value);
  const [openMode, setOpenMode] = useState<"date" | "time" | null>(null);
  const updatePart =
    (mode: "date" | "time") =>
    (event: DateTimePickerEvent, selected?: Date) => {
      if (Platform.OS === "android") setOpenMode(null);
      if (event.type !== "set" || !selected) return;
      const next = new Date(date);
      if (mode === "date") {
        next.setFullYear(
          selected.getFullYear(),
          selected.getMonth(),
          selected.getDate(),
        );
      } else {
        next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
      }
      props.onChange(next.toISOString());
    };

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: props.colors.text }]}>
        {props.label}
      </Text>
      {Platform.OS === "ios" ? (
        <View style={styles.dateTimeRow}>
          <DateTimePicker
            value={date}
            mode="date"
            display="compact"
            locale={props.locale}
            onChange={updatePart("date")}
            accentColor={props.colors.accent}
          />
          <DateTimePicker
            value={date}
            mode="time"
            display="compact"
            locale={props.locale}
            onChange={updatePart("time")}
            accentColor={props.colors.accent}
          />
        </View>
      ) : (
        <View style={styles.dateTimeRow}>
          <View style={styles.dateTimeButton}>
            <PickerButton
              label={date.toLocaleDateString(props.locale)}
              accessibilityLabel={`${props.label}: ${date.toLocaleDateString(props.locale)}`}
              colors={props.colors}
              onPress={() => setOpenMode("date")}
            />
          </View>
          <View style={styles.dateTimeButton}>
            <PickerButton
              label={date.toLocaleTimeString(props.locale, {
                hour: "2-digit",
                minute: "2-digit",
              })}
              accessibilityLabel={`${props.label}: ${date.toLocaleTimeString(
                props.locale,
                {
                  hour: "2-digit",
                  minute: "2-digit",
                },
              )}`}
              colors={props.colors}
              onPress={() => setOpenMode("time")}
            />
          </View>
          {openMode ? (
            <DateTimePicker
              value={date}
              mode={openMode}
              display="default"
              is24Hour={openMode === "time"}
              onChange={updatePart(openMode)}
            />
          ) : null}
        </View>
      )}
      {props.hint ? (
        <Text style={[styles.hint, { color: props.colors.subtle }]}>
          {props.hint}
        </Text>
      ) : null}
    </View>
  );
}

function PickerButton({
  label,
  accessibilityLabel,
  colors,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  colors: AppColors;
  onPress: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [
        styles.pickerButton,
        {
          backgroundColor: pressed ? colors.surfaceMuted : colors.surface,
          borderColor: focused ? colors.focus : colors.borderStrong,
        },
      ]}
    >
      <Text style={[styles.value, { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

function timeToDate(value: string): Date {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  const date = new Date();
  date.setSeconds(0, 0);
  if (match) date.setHours(Number(match[1]), Number(match[2]));
  return date;
}

function dateTimeToDate(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  field: { minWidth: 0 },
  label: {
    fontSize: type.label,
    lineHeight: type.captionLine,
    fontWeight: "700",
    marginBottom: space.sm,
  },
  hint: {
    marginTop: space.xs,
    fontSize: type.caption,
    lineHeight: type.captionLine,
  },
  pickerButton: {
    width: "100%",
    minHeight: size.controlLg,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  value: {
    fontSize: type.body,
    lineHeight: type.bodyLine,
  },
  iosPicker: { alignSelf: "flex-start" },
  dateTimeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.sm,
  },
  dateTimeButton: {
    flexGrow: 1,
    flexBasis: size.navigationWide / 2,
    minWidth: 0,
  },
});
