import { describe, expect, it } from "vitest";
import { createTranslator, normalizeLocale } from "../src/index";

describe("localization", () => {
  it("supports English and Brazilian Portuguese", () => {
    expect(createTranslator("en")("reminders")).toBe("Reminders");
    expect(createTranslator("pt-BR")("reminders")).toBe("Lembretes");
    expect(createTranslator("en")("monthly")).toBe("Monthly");
    expect(createTranslator("en")("yearly")).toBe("Yearly");
    expect(createTranslator("pt-BR")("monthly")).toBe("Mensalmente");
    expect(createTranslator("pt-BR")("yearly")).toBe("Anualmente");
    expect(createTranslator("en")("notificationsEnabled")).toBe(
      "Notifications are enabled on this device.",
    );
    expect(createTranslator("pt-BR")("notificationsEnabled")).toBe(
      "As notificações estão ativas neste dispositivo.",
    );
  });

  it("falls back regional locales safely", () => {
    expect(normalizeLocale("pt-PT")).toBe("pt-BR");
    expect(normalizeLocale("fr-FR")).toBe("en");
  });
});
