import { createElement, useRef, useState, type KeyboardEvent } from "react";
import type { CategoryTabsProps } from "./CategoryTabs";
import { radius, size, space, type } from "./theme";

export function CategoryTabs({
  options,
  selected,
  onSelect,
  colors,
  label,
  panelId,
}: CategoryTabsProps) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [focused, setFocused] = useState("");
  const [hovered, setHovered] = useState("");
  function keyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % options.length;
    else if (event.key === "ArrowLeft")
      next = (index + options.length - 1) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else return;
    event.preventDefault();
    const option = options[next];
    if (option) {
      onSelect(option.value);
      buttons.current.get(option.value)?.focus();
    }
  }
  return createElement(
    "div",
    {
      role: "tablist",
      "aria-label": label,
      style: { display: "flex", flexWrap: "wrap", gap: space.sm, minWidth: 0 },
    },
    options.map((option, index) =>
      createElement(
        "button",
        {
          key: option.value,
          id: `${panelId}-${option.value}`,
          type: "button",
          role: "tab",
          ref: (node: HTMLButtonElement | null) => {
            if (node) buttons.current.set(option.value, node);
            else buttons.current.delete(option.value);
          },
          "aria-selected": selected === option.value,
          "aria-controls": panelId,
          tabIndex: selected === option.value ? 0 : -1,
          onClick: () => onSelect(option.value),
          onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) =>
            keyDown(event, index),
          onFocus: () => setFocused(option.value),
          onBlur: () => setFocused(""),
          onMouseEnter: () => setHovered(option.value),
          onMouseLeave: () => setHovered(""),
          style: {
            minHeight: size.controlMd,
            maxWidth: "100%",
            minWidth: 0,
            paddingInline: space.md,
            borderWidth: 1,
            borderStyle: "solid",
            borderRadius: radius.md,
            borderColor:
              selected === option.value ? colors.accent : colors.borderStrong,
            backgroundColor:
              hovered === option.value
                ? colors.surfaceMuted
                : selected === option.value
                  ? colors.accentSoft
                  : colors.surface,
            color: colors.text,
            fontFamily: type.family,
            fontSize: type.label,
            lineHeight: `${type.captionLine}px`,
            fontWeight: selected === option.value ? "700" : "500",
            overflowWrap: "anywhere",
            textDecoration: selected === option.value ? "underline" : "none",
            outline:
              focused === option.value
                ? `${space.xxs}px solid ${colors.focus}`
                : "none",
            outlineOffset: space.xxs,
            cursor: "pointer",
          },
        },
        option.label,
      ),
    ),
  );
}
