import { describe, expect, it } from "vitest";
import { createTranslator, normalizeLocale } from "../src/index";

describe("localization", () => {
  it("supports English and Brazilian Portuguese", () => {
    expect(createTranslator("en")("reminders")).toBe("Reminders");
    expect(createTranslator("pt-BR")("reminders")).toBe("Lembretes");
  });

  it("falls back regional locales safely", () => {
    expect(normalizeLocale("pt-PT")).toBe("pt-BR");
    expect(normalizeLocale("fr-FR")).toBe("en");
  });
});
