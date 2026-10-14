import {
  createElement,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type UIEvent,
} from "react";
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
  const scroller = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState("");
  const [hovered, setHovered] = useState("");
  const [scrollState, setScrollState] = useState({
    atStart: true,
    atEnd: true,
  });
  function updateScrollState(node: HTMLDivElement) {
    const next = {
      atStart: node.scrollLeft <= 0,
      atEnd: Math.ceil(node.scrollLeft) >= node.scrollWidth - node.clientWidth,
    };
    setScrollState((current) => {
      if (current.atStart === next.atStart && current.atEnd === next.atEnd)
        return current;
      return next;
    });
  }
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const update = () => updateScrollState(node);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [options.length]);
  useEffect(() => {
    const node = scroller.current;
    const button = buttons.current.get(selected);
    if (!node || !button) return;
    const start = button.offsetLeft;
    const end = start + button.offsetWidth;
    if (start < node.scrollLeft)
      node.scrollTo({ left: Math.max(0, start - space.lg) });
    else if (end > node.scrollLeft + node.clientWidth)
      node.scrollTo({ left: end - node.clientWidth + space.lg });
  }, [selected]);
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
      style: { position: "relative", minWidth: 0 },
    },
    createElement(
      "div",
      {
        ref: scroller,
        role: "tablist",
        "aria-label": label,
        onScroll: (event: UIEvent<HTMLDivElement>) =>
          updateScrollState(event.currentTarget),
        style: {
          display: "flex",
          flexWrap: "nowrap",
          minWidth: 0,
          overflowX: "auto",
          overflowY: "hidden",
          paddingInlineEnd: space.xl,
          scrollbarWidth: "none",
          scrollPaddingInline: space.lg,
          borderBottomWidth: 1,
          borderBottomStyle: "solid",
          borderBottomColor: colors.border,
        },
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
              flex: "0 0 auto",
              minHeight: size.controlMd,
              paddingInline: space.lg,
              borderWidth: 0,
              borderBottomWidth: space.xxs,
              borderBottomStyle: "solid",
              borderBottomColor:
                selected === option.value ? colors.accent : "transparent",
              borderTopLeftRadius: radius.sm,
              borderTopRightRadius: radius.sm,
              backgroundColor:
                hovered === option.value ? colors.surfaceMuted : colors.surface,
              color: colors.text,
              fontFamily: type.family,
              fontSize: type.label,
              lineHeight: `${type.captionLine}px`,
              fontWeight: selected === option.value ? "700" : "500",
              whiteSpace: "nowrap",
              outline:
                focused === option.value
                  ? `${space.xxs}px solid ${colors.focus}`
                  : "none",
              outlineOffset: -space.xxs,
              cursor: "pointer",
            },
          },
          option.label,
        ),
      ),
    ),
    !scrollState.atStart
      ? createElement("div", {
          "aria-hidden": true,
          style: {
            position: "absolute",
            insetBlock: 0,
            insetInlineStart: 0,
            width: space.xl,
            pointerEvents: "none",
            background: `linear-gradient(to right, ${colors.background}, transparent)`,
          },
        })
      : null,
    !scrollState.atEnd
      ? createElement("div", {
          "aria-hidden": true,
          style: {
            position: "absolute",
            insetBlock: 0,
            insetInlineEnd: 0,
            width: space.xl,
            pointerEvents: "none",
            background: `linear-gradient(to left, ${colors.background}, transparent)`,
          },
        })
      : null,
  );
}
