import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { StoredAgendaOccurrence } from "../apps/app/src/agenda";
import {
  nextPostponementAt,
  resolvePostponement,
  type NotificationAction,
  type Reminder,
} from "@cron-reminder/domain";

const ownerId = "00000000-0000-4000-8000-000000000001";
const supabaseOrigin = "http://127.0.0.1:9999";
const storageKey = "sb-127-auth-token";
const viewportWidths = [280, 320, 414, 768, 879, 880, 1120, 1440] as const;

const reminders = [
  {
    id: "daily-operations-review",
    ownerId,
    title: "Review critical customer operations and outstanding escalations",
    notes:
      "Confirm ownership, deadlines, and the next action before the daily handoff.",
    tags: ["operations", "customer-success", "high-priority-follow-up"],
    schedule: { kind: "daily-times" as const, times: ["09:00", "16:30"] },
    timezone: "UTC",
    sound: { mode: "default" as const },
    status: "active" as const,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-09-24T12:00:00.000Z",
  },
  {
    id: "weekly-archive-review",
    ownerId,
    title: "Archive completed weekly reports",
    notes: "Keep the shared workspace current.",
    tags: ["reporting"],
    schedule: {
      kind: "cron" as const,
      expression: "0 17 * * 5",
    },
    timezone: "UTC",
    sound: { mode: "silent" as const },
    status: "disabled" as const,
    revision: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-09-23T12:00:00.000Z",
  },
];

const toDatabaseReminder = (reminder: Reminder) => ({
  id: reminder.id,
  owner_id: reminder.ownerId,
  title: reminder.title,
  notes: reminder.notes,
  tags: reminder.tags,
  schedule: reminder.schedule,
  timezone: reminder.timezone,
  sound: reminder.sound,
  status: reminder.status,
  revision: reminder.revision,
  created_at: reminder.createdAt,
  updated_at: reminder.updatedAt,
  next_due_at: null,
  schedule_revision: 1,
  occurrence_count: occurrences.filter(
    (occurrence) => occurrence.reminder_id === reminder.id,
  ).length,
});

const history = [
  {
    id: "history-2",
    reminder_id: "daily-operations-review",
    event_type: "postponed",
    occurred_at: "2026-09-25T15:30:00.000Z",
  },
  {
    id: "history-1",
    reminder_id: "weekly-archive-review",
    event_type: "dismissed",
    occurred_at: "2026-09-24T17:00:00.000Z",
  },
];

const occurrences: StoredAgendaOccurrence[] = [
  {
    id: "occurrence-older",
    reminder_id: "daily-operations-review",
    scheduled_at: "2026-09-25T09:00:00.000Z",
    status: "triggered",
    acted_at: null,
    snoozed_until: null,
  },
  {
    id: "occurrence-1",
    reminder_id: "daily-operations-review",
    scheduled_at: "2026-09-25T16:30:00.000Z",
    status: "triggered",
    acted_at: null,
    snoozed_until: null,
  },
  {
    id: "occurrence-archive",
    reminder_id: "weekly-archive-review",
    scheduled_at: "2026-09-25T17:00:00.000Z",
    status: "triggered",
    acted_at: null,
    snoozed_until: null,
  },
];

interface LayoutReport {
  documentWidth: number;
  viewportWidth: number;
  outsideViewport: string[];
  clipped: string[];
  undersizedTargets: string[];
  overlaps: string[];
}

interface SubmittedAction {
  occurrenceId: string;
  action: NotificationAction;
  until?: string;
}

function fakeSession() {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const accessToken = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: ownerId,
    aud: "authenticated",
    role: "authenticated",
    email: "qa@example.com",
    exp: 4_102_444_800,
  })}.qa-signature`;

  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3_600,
    expires_at: 4_102_444_800,
    refresh_token: "qa-refresh-token",
    user: {
      id: ownerId,
      aud: "authenticated",
      role: "authenticated",
      email: "qa@example.com",
      app_metadata: {},
      user_metadata: {},
      identities: [],
      created_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

async function mockSupabase(
  page: Page,
  notificationActions: SubmittedAction[] = [],
  theme: "light" | "dark" = "light",
  seededReminders: readonly Reminder[] = reminders,
  reminderWrites: Array<Record<string, unknown>> = [],
): Promise<void> {
  const storedOccurrences = occurrences.map((item) => ({ ...item }));
  const storedReminders: Array<Record<string, unknown>> =
    seededReminders.map(toDatabaseReminder);
  await page.route(`${supabaseOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const table = url.pathname.split("/").at(-1);
    let body: unknown = [];

    if (url.pathname.endsWith("/functions/v1/occurrence-action")) {
      const action = request.postDataJSON() as SubmittedAction;
      notificationActions.push(action);
      const occurrence = storedOccurrences.find(
        ({ id }) => id === action.occurrenceId,
      );
      if (occurrence) {
        occurrence.status =
          action.action === "complete"
            ? "completed"
            : action.action === "dismiss"
              ? "dismissed"
              : "postponed";
        if (action.action === "snooze") {
          const reminder = seededReminders.find(
            ({ id }) => id === occurrence.reminder_id,
          )!;
          const now = new Date(await page.evaluate(() => Date.now()));
          const postponement = resolvePostponement(
            { until: action.until! },
            now.toISOString(),
            nextPostponementAt(
              reminder,
              now,
              toDatabaseReminder(reminder).occurrence_count,
            ),
          );
          occurrence.snoozed_until = postponement.until;
          occurrence.postponed_to_next = postponement.mergeIntoNext;
        } else occurrence.snoozed_until = null;
      }
      body = { updated: true };
    } else if (table === "profiles") {
      body = request.method() === "GET" ? { locale: "en", theme } : null;
    } else if (table === "reminders") {
      const id = url.searchParams.get("id")?.replace(/^eq\./, "");
      if (request.method() === "POST") {
        const incoming = request.postDataJSON() as Record<string, unknown>;
        reminderWrites.push(incoming);
        storedReminders.push({ ...incoming, occurrence_count: 0 });
      } else if (request.method() === "PATCH") {
        const updates = request.postDataJSON() as Record<string, unknown>;
        reminderWrites.push(updates);
        for (const reminder of storedReminders) {
          if (reminder.id === id) Object.assign(reminder, updates);
        }
      }
      const selected = storedReminders.filter(
        (reminder) => !id || reminder.id === id,
      );
      body = request
        .headers()
        .accept?.includes("application/vnd.pgrst.object+json")
        ? (selected[0] ?? null)
        : selected;
    } else if (table === "occurrences") {
      body = storedOccurrences;
    } else if (table === "history") {
      body = history;
    } else if (url.pathname.startsWith("/auth/v1/user")) {
      body = fakeSession().user;
    } else if (url.pathname.startsWith("/rest/v1/rpc/")) {
      body = true;
    }

    await route.fulfill({
      status: request.method() === "DELETE" ? 204 : 200,
      contentType: "application/json",
      body: request.method() === "DELETE" ? "" : JSON.stringify(body),
    });
  });
}

async function authenticate(
  page: Page,
  seededReminders: readonly Reminder[] = reminders,
): Promise<void> {
  await page.addInitScript(
    ({ session, seededReminders, sessionStorageKey }) => {
      localStorage.setItem(sessionStorageKey, JSON.stringify(session));
      localStorage.setItem(
        "cron-reminder:reminders",
        JSON.stringify(seededReminders),
      );
    },
    {
      session: fakeSession(),
      seededReminders,
      sessionStorageKey: storageKey,
    },
  );
}

function captureLayoutConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().includes("Unexpected text node")
    ) {
      errors.push(message.text());
    }
  });
  return errors;
}

async function measureLayout(page: Page): Promise<LayoutReport> {
  return page.evaluate(() => {
    interface VisibleRect {
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
    }

    const clips = (overflow: string) =>
      overflow === "auto" ||
      overflow === "clip" ||
      overflow === "hidden" ||
      overflow === "scroll";
    const visibleRect = (element: Element): VisibleRect => {
      const elementRect = element.getBoundingClientRect();
      let left = Math.max(elementRect.left, 0);
      let top = Math.max(elementRect.top, 0);
      let right = Math.min(elementRect.right, innerWidth);
      let bottom = Math.min(elementRect.bottom, innerHeight);
      let ancestor = element.parentElement;

      while (ancestor) {
        const style = getComputedStyle(ancestor);
        const ancestorRect = ancestor.getBoundingClientRect();
        if (clips(style.overflowX)) {
          left = Math.max(left, ancestorRect.left);
          right = Math.min(right, ancestorRect.right);
        }
        if (clips(style.overflowY)) {
          top = Math.max(top, ancestorRect.top);
          bottom = Math.min(bottom, ancestorRect.bottom);
        }
        ancestor = ancestor.parentElement;
      }

      return {
        left,
        top,
        right,
        bottom,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      };
    };
    const isVisible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = visibleRect(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const label = (element: Element) => {
      const text =
        element.getAttribute("aria-label") ??
        element.textContent?.trim().replace(/\s+/g, " ") ??
        "";
      return `${element.tagName.toLowerCase()} "${text.slice(0, 80)}"`;
    };
    const visible = Array.from(document.querySelectorAll("*")).filter(
      isVisible,
    );
    const outsideViewport = visible
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      })
      .map(label);
    const clipped = visible
      .filter((element) => {
        if (element === document.body || element === document.documentElement) {
          return false;
        }
        const style = getComputedStyle(element);
        if (
          style.textOverflow === "ellipsis" &&
          style.whiteSpace === "nowrap"
        ) {
          return false;
        }
        const clipsX =
          style.overflowX === "hidden" || style.overflowX === "clip";
        const clipsY =
          style.overflowY === "hidden" || style.overflowY === "clip";
        return (
          (clipsX && element.scrollWidth > element.clientWidth + 1) ||
          (clipsY && element.scrollHeight > element.clientHeight + 1)
        );
      })
      .map(label);
    const targets = visible.filter((element) =>
      element.matches(
        'button, a[href], input, select, textarea, [role="button"], [role="switch"], [role="checkbox"], [role="radio"]',
      ),
    );
    const undersizedTargets = targets
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width < 24 || rect.height < 24;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return `${label(element)} (${rect.width.toFixed(1)}x${rect.height.toFixed(1)})`;
      });
    const overlapCandidates = visible.filter(
      (element) =>
        targets.includes(element) ||
        (element.children.length === 0 &&
          Boolean(element.textContent?.trim()) &&
          getComputedStyle(element).position !== "absolute"),
    );
    const overlaps: string[] = [];

    for (
      let firstIndex = 0;
      firstIndex < overlapCandidates.length;
      firstIndex += 1
    ) {
      const first = overlapCandidates[firstIndex];
      if (!first) continue;
      const firstRect = visibleRect(first);
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < overlapCandidates.length;
        secondIndex += 1
      ) {
        const second = overlapCandidates[secondIndex];
        if (
          !second ||
          first.contains(second) ||
          second.contains(first) ||
          first.closest("button") === second.closest("button")
        ) {
          continue;
        }
        const secondRect = visibleRect(second);
        const overlapWidth =
          Math.min(firstRect.right, secondRect.right) -
          Math.max(firstRect.left, secondRect.left);
        const overlapHeight =
          Math.min(firstRect.bottom, secondRect.bottom) -
          Math.max(firstRect.top, secondRect.top);
        if (overlapWidth > 2 && overlapHeight > 2) {
          overlaps.push(
            `${label(first)} [${firstRect.left.toFixed(1)},${firstRect.top.toFixed(1)},${firstRect.right.toFixed(1)},${firstRect.bottom.toFixed(1)}] overlaps ${label(second)} [${secondRect.left.toFixed(1)},${secondRect.top.toFixed(1)},${secondRect.right.toFixed(1)},${secondRect.bottom.toFixed(1)}]`,
          );
        }
      }
    }

    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      outsideViewport: [...new Set(outsideViewport)],
      clipped: [...new Set(clipped)],
      undersizedTargets: [...new Set(undersizedTargets)],
      overlaps: [...new Set(overlaps)],
    };
  });
}

async function expectSoundLayout(page: Page, routeName: string): Promise<void> {
  const report = await measureLayout(page);
  expect
    .soft(report.documentWidth, `${routeName} expands beyond its viewport`)
    .toBeLessThanOrEqual(report.viewportWidth + 1);
  expect
    .soft(report.outsideViewport, `${routeName} has off-screen content`)
    .toEqual([]);
  expect.soft(report.clipped, `${routeName} clips visible content`).toEqual([]);
  expect
    .soft(
      report.undersizedTargets,
      `${routeName} has targets smaller than 24 by 24 CSS pixels`,
    )
    .toEqual([]);
  expect
    .soft(report.overlaps, `${routeName} has overlapping content`)
    .toEqual([]);
}

async function expectControlContrast(
  control: Locator,
  description: string,
): Promise<void> {
  const page = control.page();
  for (const state of ["default", "hover", "focus"] as const) {
    await page.mouse.move(0, 0);
    await control.evaluate((element) => (element as HTMLElement).blur());
    if (state === "hover") await control.hover();
    if (state === "focus") await control.focus();
    const contrasts = await control.evaluate((element) => {
      const text =
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement
          ? element
          : Array.from(element.querySelectorAll("*")).find(
              (child) => !child.children.length && child.textContent?.trim(),
            );
      if (!text) throw new Error("Control has no visible label");
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((channel) => {
            const value = channel / 255;
            return value <= 0.04045
              ? value / 12.92
              : ((value + 0.055) / 1.055) ** 2.4;
          });
        return (
          channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
        );
      };
      const ratio = (foreground: string, background: string) => {
        const first = luminance(foreground);
        const second = luminance(background);
        return (
          (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
        );
      };
      const styles = getComputedStyle(element);
      let parent = element.parentElement;
      while (
        parent &&
        getComputedStyle(parent).backgroundColor === "rgba(0, 0, 0, 0)"
      )
        parent = parent.parentElement;
      if (!parent) throw new Error("Control has no opaque parent background");
      const parentBackground = getComputedStyle(parent).backgroundColor;
      // Native auto outlines do not expose their painted color; measure the authored border.
      const outlineContrast =
        styles.outlineStyle !== "auto" &&
        styles.outlineStyle !== "none" &&
        parseFloat(styles.outlineWidth) > 0
          ? ratio(styles.outlineColor, parentBackground)
          : 0;
      return {
        text: ratio(getComputedStyle(text).color, styles.backgroundColor),
        focus: Math.max(
          outlineContrast,
          ratio(styles.borderTopColor, parentBackground),
        ),
      };
    });
    expect(
      contrasts.text,
      `${description} ${state} text contrast`,
    ).toBeGreaterThanOrEqual(4.5);
    if (state === "focus")
      expect(
        contrasts.focus,
        `${description} focus indicator contrast`,
      ).toBeGreaterThanOrEqual(3);
  }
}

test.describe("responsive UI layout", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const state of [
      "healthy",
      "disabled",
      "missing",
      "mismatched",
      "unavailable",
    ] as const) {
      test(`browser notification status verifies a ${state} registration in ${theme} mode`, async ({
        page,
      }, testInfo) => {
        const subscription = {
          endpoint: "https://push.example/current",
          keys: { auth: "auth", p256dh: "key" },
        };
        let repairedToken: string | null = null;
        await mockSupabase(page, [], theme);
        await authenticate(page);
        await page.addInitScript(
          ({ subscription }) => {
            localStorage.setItem(
              "cron-reminder:device-id",
              JSON.stringify({
                id: "this-browser",
                token: "00000000-0000-4000-8000-000000000002",
              }),
            );
            Object.defineProperty(Notification, "permission", {
              value: "granted",
              configurable: true,
            });
            Object.defineProperty(Notification, "requestPermission", {
              value: async () => "granted",
              configurable: true,
            });
            let current: typeof subscription | null = subscription;
            const registration = {
              pushManager: {
                getSubscription: async () =>
                  current && {
                    ...current,
                    unsubscribe: async () => {
                      current = null;
                      return true;
                    },
                  },
                subscribe: async () => {
                  current = {
                    ...subscription,
                    endpoint: "https://push.example/repaired",
                  };
                  return current;
                },
              },
            };
            Object.defineProperty(navigator.serviceWorker, "getRegistration", {
              value: async () => registration,
            });
            Object.defineProperty(navigator.serviceWorker, "register", {
              value: async () => registration,
            });
            Object.defineProperty(navigator.serviceWorker, "ready", {
              value: Promise.resolve(registration),
            });
          },
          { subscription },
        );
        await page.route(
          `${supabaseOrigin}/rest/v1/devices*`,
          async (route) => {
            expect(
              new URL(route.request().url()).searchParams.get("owner_id"),
            ).toBe(`eq.${ownerId}`);
            await route.fulfill({
              status: state === "unavailable" ? 503 : 200,
              headers:
                state === "unavailable"
                  ? {
                      "Retry-After": "0",
                      "Access-Control-Expose-Headers": "Retry-After",
                    }
                  : {},
              contentType: "application/json",
              body: JSON.stringify(
                state === "unavailable"
                  ? { message: "Registration lookup unavailable" }
                  : state === "missing"
                    ? []
                    : [
                        {
                          enabled:
                            repairedToken !== null || state !== "disabled",
                          token:
                            repairedToken ??
                            JSON.stringify(
                              state === "mismatched"
                                ? {
                                    ...subscription,
                                    endpoint: "https://push.example/old",
                                  }
                                : subscription,
                            ),
                        },
                      ],
              ),
            });
          },
        );
        if (state === "disabled") {
          await page.route(
            `${supabaseOrigin}/rest/v1/rpc/claim_device_token`,
            async (route) => {
              const parameters = route.request().postDataJSON();
              expect(parameters.p_platform).toBe("web");
              expect(parameters.p_device_id).toBe("this-browser");
              expect(JSON.parse(parameters.p_token).endpoint).toBe(
                "https://push.example/repaired",
              );
              repairedToken = parameters.p_token;
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: "true",
              });
            },
          );
        }
        await page.goto("/settings");
        if (state === "healthy") {
          await expect(
            page.getByRole("button", {
              name: "Notifications are enabled on this device.",
            }),
          ).toBeVisible();
        } else {
          await expect(
            page.getByRole("button", {
              name: "Enable notifications on this device",
            }),
          ).toBeVisible();
          await expect(
            page.getByText("Notifications are enabled on this device.", {
              exact: true,
            }),
          ).toHaveCount(0);
          if (state === "unavailable")
            await expect(
              page.getByText(
                "Notifications could not be enabled. Check your connection and try again.",
              ),
            ).toBeVisible();
        }
        if (state === "disabled") {
          await expectControlContrast(
            page.getByRole("button", {
              name: "Enable notifications on this device",
            }),
            `${theme} notification recovery`,
          );
          for (const width of [280, 320, 414, 1120]) {
            await page.setViewportSize({ width, height: 900 });
            await expect
              .poll(() => measureLayout(page), {
                message: `browser registration recovery at ${width}px`,
              })
              .toEqual({
                documentWidth: width,
                viewportWidth: width,
                outsideViewport: [],
                clipped: [],
                undersizedTargets: [],
                overlaps: [],
              });
            await expectSoundLayout(
              page,
              `browser registration recovery at ${width}px`,
            );
          }
          await page.setViewportSize({ width: 390, height: 900 });
          await page
            .getByRole("button", {
              name: "Enable notifications on this device",
            })
            .scrollIntoViewIfNeeded();
          await page.mouse.move(0, 0);
          await page.screenshot({
            path: testInfo.outputPath("browser-registration-recovery.png"),
          });
          await writeFile(
            testInfo.outputPath("browser-registration.html"),
            await page.content(),
          );
          await page
            .getByRole("button", {
              name: "Enable notifications on this device",
            })
            .click();
          await expect(
            page.getByRole("button", {
              name: "Notifications are enabled on this device.",
            }),
          ).toBeVisible();
          expect(JSON.parse(repairedToken!)).toEqual({
            ...subscription,
            endpoint: "https://push.example/repaired",
          });
        }
      });
    }
  }

  for (const theme of ["light", "dark"] as const) {
    test(`recurrence endings create, edit, validate, and persist in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      const writes: Array<Record<string, unknown>> = [];
      await page.clock.setFixedTime(new Date("2026-09-25T18:00:00.000Z"));
      await mockSupabase(page, [], theme, reminders, writes);
      await authenticate(page);
      await page.setViewportSize({ width: 390, height: 900 });
      await page.goto("/reminders");
      await page.getByRole("button", { name: "Add reminder" }).click();
      await page
        .getByRole("textbox", { name: "Title", exact: true })
        .fill("Bounded daily reminder");
      const ends = page.getByRole("combobox", { name: "Ends", exact: true });
      await expect(ends).toHaveValue("never");
      await ends.selectOption("until");
      const until = page.getByLabel("Until", { exact: true });
      await until.fill("2026-09-27T09:00");
      await expectControlContrast(ends, `${theme} recurrence ending selector`);
      await expectControlContrast(until, `${theme} recurrence end date`);
      await until.fill("");
      await expect(
        page.getByRole("button", { name: "Save", exact: true }),
      ).toBeDisabled();

      await ends.selectOption("count");
      const count = page.getByRole("spinbutton", { name: "Total occurrences" });
      await expect(count).toHaveAttribute("min", "1");
      for (const value of ["0", "1.5"]) {
        await count.fill(value);
        await expect(
          page.getByRole("button", { name: "Save", exact: true }),
        ).toBeDisabled();
      }
      await count.fill("3");
      await page.getByRole("button", { name: "Add another time" }).click();
      await page.getByLabel("Time 2", { exact: true }).fill("12:00");
      await expectControlContrast(count, `${theme} recurrence count`);
      for (const width of [280, 320, 414, 1120]) {
        await page.setViewportSize({ width, height: 900 });
        await expectSoundLayout(
          page,
          `${theme} recurrence count at ${width}px`,
        );
        if (width === 1120) {
          await count.scrollIntoViewIfNeeded();
          await page.mouse.move(0, 0);
          await page.screenshot({
            path: testInfo.outputPath(`recurrence-count-desktop-${theme}.png`),
          });
        }
      }
      await page.setViewportSize({ width: 390, height: 900 });
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(() =>
          writes.some((write) => write.title === "Bounded daily reminder"),
        )
        .toBe(true);
      const created = writes.find(
        (write) => write.title === "Bounded daily reminder",
      )!;
      expect(created.schedule).toEqual({
        kind: "daily-times",
        times: ["09:00", "12:00"],
        occurrenceLimit: 3,
      });

      const original = page
        .getByText(reminders[0]!.title, { exact: true })
        .locator("..")
        .locator("..")
        .locator("..")
        .locator("..");
      await original.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(ends).toHaveValue("never");
      await ends.selectOption("count");
      await count.fill("3");
      await expect(
        page.getByText("2 occurrences already generated."),
      ).toBeVisible();
      await count.fill("2");
      await expect(
        page.getByText("No future occurrences within this schedule."),
      ).toBeVisible();
      await count.fill("3");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(() =>
          writes.some(
            (write) =>
              (write.schedule as { occurrenceLimit?: number } | undefined)
                ?.occurrenceLimit === 3 && write.title === reminders[0]!.title,
          ),
        )
        .toBe(true);
      await original.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(ends).toHaveValue("count");
      await expect(count).toHaveValue("3");
      await ends.selectOption("until");
      await until.fill("2026-09-27T09:00");
      const expectedUntil = await until.evaluate((element) =>
        new Date((element as HTMLInputElement).value).toISOString(),
      );
      for (const width of [280, 320, 414]) {
        await page.setViewportSize({ width, height: 900 });
        await expectSoundLayout(page, `${theme} recurrence date at ${width}px`);
      }
      await page.setViewportSize({ width: 390, height: 900 });
      await until.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: testInfo.outputPath(`recurrence-until-${theme}.png`),
      });
      await writeFile(
        testInfo.outputPath(`recurrence-${theme}.html`),
        await page.content(),
      );
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(() =>
          writes.some(
            (write) =>
              (write.schedule as { endAt?: string } | undefined)?.endAt ===
              expectedUntil,
          ),
        )
        .toBe(true);
      await original.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(ends).toHaveValue("until");
      await expect(until).toHaveValue("2026-09-27T09:00");
      await ends.selectOption("never");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(() => writes.at(-1)?.schedule)
        .toEqual(reminders[0]!.schedule);
      await original.getByRole("button", { name: "Edit", exact: true }).click();
      await page
        .getByRole("combobox", { name: "Frequency" })
        .selectOption("once");
      await expect(ends).toHaveCount(0);
      await expect(until).toHaveCount(0);
      await expect(count).toHaveCount(0);
    });
  }

  test("desktop navigation starts below the brand with centered labels", async ({
    page,
  }) => {
    await mockSupabase(page);
    await authenticate(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/reminders");

    const navigationItems = await Promise.all(
      ["Today", "Reminders", "History", "Settings"].map((name) =>
        page.getByRole("button", { name }).evaluate((button, label) => {
          const text = Array.from(button.querySelectorAll("*")).find(
            (element) =>
              element.children.length === 0 &&
              element.textContent?.trim() === label,
          );
          const buttonRect = button.getBoundingClientRect();
          const textRect = text?.getBoundingClientRect();
          return {
            buttonTop: buttonRect.top,
            buttonCenter: buttonRect.top + buttonRect.height / 2,
            textCenter: textRect
              ? textRect.top + textRect.height / 2
              : Number.NaN,
          };
        }, name),
      ),
    );
    expect(navigationItems[0]?.buttonTop).toBeLessThan(120);
    for (const item of navigationItems) {
      expect(Math.abs(item.buttonCenter - item.textCenter)).toBeLessThanOrEqual(
        1,
      );
    }
  });

  test("unauthenticated screen has no overflow, clipping, or overlap", async ({
    page,
  }) => {
    await mockSupabase(page);
    const consoleErrors = captureLayoutConsoleErrors(page);

    for (const width of viewportWidths) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(
        page.getByRole("heading", {
          name: "Make time-sensitive work hard to miss.",
        }),
      ).toBeVisible();
      await expectSoundLayout(page, `authentication at ${width}px`);
    }
    expect(
      consoleErrors,
      "authentication emitted layout console errors",
    ).toEqual([]);
  });

  test("only the latest overdue occurrence has dismiss, postpone, and complete actions", async ({
    page,
  }) => {
    const notificationActions: Array<{
      occurrenceId: string;
      action: "dismiss" | "snooze" | "complete";
    }> = [];
    await mockSupabase(page, notificationActions);
    await authenticate(page);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/");

    const operationsTitle =
      "Review critical customer operations and outstanding escalations";
    await expect(
      page.getByRole("button", { name: /Show.*occurrences|Dismiss all/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: new RegExp(`^Dismiss ${operationsTitle},`),
      }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", {
        name: new RegExp(`^Postpone ${operationsTitle},`),
      }),
    ).toHaveCount(1);
    await page
      .getByRole("button", {
        name: new RegExp(`^Complete ${operationsTitle},`),
      })
      .click();
    await expect
      .poll(() => notificationActions.map(({ occurrenceId }) => occurrenceId))
      .toEqual(["occurrence-1"]);
    expect(notificationActions[0]?.action).toBe("complete");
    await expect(
      page.getByRole("button", {
        name: new RegExp(`^(Dismiss|Postpone|Complete) ${operationsTitle},`),
      }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("button", {
        name: new RegExp(`^(Dismiss|Postpone|Complete) ${operationsTitle},`),
      }),
    ).toHaveCount(0);
  });

  for (const action of ["Dismiss", "Postpone"] as const) {
    test(`${action} handles only the latest occurrence`, async ({ page }) => {
      const notificationActions: Array<{
        occurrenceId: string;
        action: "dismiss" | "snooze" | "complete";
      }> = [];
      await mockSupabase(page, notificationActions);
      await authenticate(page);
      await page.goto("/");
      const title = reminders[0]!.title;
      await page
        .getByRole("button", { name: new RegExp(`^${action} ${title},`) })
        .click();
      if (action === "Postpone")
        await page.getByRole("button", { name: "10 min", exact: true }).click();
      await expect
        .poll(() => notificationActions.map(({ occurrenceId }) => occurrenceId))
        .toEqual(["occurrence-1"]);
      expect(notificationActions[0]?.action).toBe(
        action === "Dismiss" ? "dismiss" : "snooze",
      );
      await expect(
        page.getByRole("button", { name: new RegExp(`^Postpone ${title},`) }),
      ).toHaveCount(0);
      if (action === "Postpone")
        await expect(page.getByText(/Postponed to/)).toBeVisible();
      else
        await expect(
          page.getByRole("button", { name: new RegExp(`^Complete ${title},`) }),
        ).toHaveCount(0);
    });
  }

  test("a queued completion stays hidden across refresh while offline", async ({
    page,
  }) => {
    await mockSupabase(page);
    await page.route(
      `${supabaseOrigin}/functions/v1/occurrence-action`,
      (route) => route.abort(),
    );
    await authenticate(page);
    await page.goto("/");
    const action = page.getByRole("button", {
      name: new RegExp(`^Complete ${reminders[0]!.title},`),
    });
    await action.click();
    await expect(page.getByText(/Your reminder action is saved/)).toBeVisible();
    await expect(action).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(/Your reminder action is saved/)).toBeVisible();
    await expect(action).toHaveCount(0);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`bounded postponement choices and custom validation work in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      await page.clock.install({ time: new Date("2026-10-07T12:51:59.000Z") });
      await page.clock.pauseAt(new Date("2026-10-07T12:52:00.000Z"));
      const hourly: Reminder[] = [
        {
          ...reminders[0]!,
          schedule: { kind: "cron", expression: "0 * * * *" },
        },
      ];
      const actions: SubmittedAction[] = [];
      await mockSupabase(page, actions, theme, hourly);
      await authenticate(page, hourly);
      await page.setViewportSize({ width: 390, height: 900 });
      await page.goto("/");
      await page
        .getByRole("button", {
          name: new RegExp(`^Postpone ${hourly[0]!.title},`),
        })
        .click();
      await expect(
        page.getByRole("button", { name: "5 min", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "10 min", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "15 min", exact: true }),
      ).toBeDisabled();
      await page.getByRole("button", { name: "Custom", exact: true }).click();
      const minutes = page.getByRole("spinbutton", {
        name: "Minutes",
        exact: true,
      });
      await expect(minutes).toHaveAttribute("min", "1");
      await expect(minutes).toHaveAttribute("max", "8");
      await minutes.fill("9");
      await expect(minutes).toHaveAttribute("aria-invalid", "true");
      await expect(
        page.getByRole("button", { name: "Postpone reminder", exact: true }),
      ).toBeDisabled();
      await minutes.fill("8");
      await expect(
        page.getByRole("button", { name: "Postpone reminder", exact: true }),
      ).toBeEnabled();
      for (const label of [
        "5 min",
        "Custom",
        "Until next occurrence",
        "Postpone reminder",
        "Cancel",
      ]) {
        await expectControlContrast(
          page.getByRole("button", { name: label, exact: true }),
          `${theme} ${label}`,
        );
      }
      await expectControlContrast(minutes, `${theme} custom duration`);
      await minutes.focus();
      const bounds = await minutes.boundingBox();
      const navigation = await page
        .getByRole("button", { name: "Today", exact: true })
        .boundingBox();
      expect(bounds).not.toBeNull();
      expect(navigation).not.toBeNull();
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(navigation!.y);
      for (const width of [280, 320, 414]) {
        await page.setViewportSize({ width, height: 900 });
        await expectSoundLayout(
          page,
          `${theme} postponement choices at ${width}px`,
        );
      }
      await page.setViewportSize({ width: 390, height: 900 });
      await page.addStyleTag({
        content:
          "* { transition: none !important; animation: none !important; }",
      });
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: testInfo.outputPath(`postponement-${theme}.png`),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Postpone reminder", exact: true })
        .click();
      await expect.poll(() => actions.length).toBe(1);
      expect(actions[0]).toMatchObject({
        action: "snooze",
        until: "2026-10-07T13:00:00.000Z",
      });
      await expect(
        page.getByRole("button", {
          name: new RegExp(`^Postpone ${hourly[0]!.title},`),
        }),
      ).toHaveCount(0);
      await expect(page.getByText("Upcoming", { exact: true })).toHaveCount(1);
      await expect(page.getByText(/Postponed to/)).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`postponement-${theme}-merged.png`),
        fullPage: true,
      });
    });
  }

  test("Until next occurrence folds into the next scheduled reminder", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-10-07T12:49:59.000Z") });
    await page.clock.pauseAt(new Date("2026-10-07T12:50:00.000Z"));
    const hourly: Reminder[] = [
      { ...reminders[0]!, schedule: { kind: "cron", expression: "0 * * * *" } },
    ];
    const actions: SubmittedAction[] = [];
    await mockSupabase(page, actions, "light", hourly);
    await authenticate(page, hourly);
    await page.goto("/");
    await page
      .getByRole("button", {
        name: new RegExp(`^Postpone ${hourly[0]!.title},`),
      })
      .click();
    await page
      .getByRole("button", { name: "Until next occurrence", exact: true })
      .click();
    await expect.poll(() => actions[0]?.until).toBe("2026-10-07T13:00:00.000Z");
    await expect(page.getByText("Upcoming", { exact: true })).toHaveCount(1);
    await expect(
      page.getByRole("button", {
        name: new RegExp(`^Postpone ${hourly[0]!.title},`),
      }),
    ).toHaveCount(0);
  });

  for (const schedule of [
    { kind: "once" as const, at: "2026-10-07T10:00:00.000Z" },
    { kind: "cron" as const, expression: "0 * * * *", occurrenceLimit: 2 },
  ]) {
    test(`${schedule.kind} without remaining occurrences permits a long custom duration`, async ({
      page,
    }) => {
      await page.clock.install({ time: new Date("2026-10-07T11:59:59.000Z") });
      await page.clock.pauseAt(new Date("2026-10-07T12:00:00.000Z"));
      const seeded: Reminder[] = [{ ...reminders[0]!, schedule }];
      const actions: SubmittedAction[] = [];
      await mockSupabase(page, actions, "light", seeded);
      await authenticate(page, seeded);
      await page.goto("/");
      await page
        .getByRole("button", {
          name: new RegExp(`^Postpone ${seeded[0]!.title},`),
        })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Until next occurrence",
          exact: true,
        }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: "Custom", exact: true }).click();
      const minutes = page.getByRole("spinbutton", {
        name: "Minutes",
        exact: true,
      });
      await expect(minutes).not.toHaveAttribute("max");
      await minutes.fill("75");
      await page
        .getByRole("button", { name: "Postpone reminder", exact: true })
        .click();
      await expect
        .poll(() => actions[0]?.until)
        .toBe("2026-10-07T13:15:00.000Z");
      await expect(page.getByText(/Postponed to/)).toBeVisible();
    });
  }

  test("notification Postpone opens the chooser instead of immediately postponing", async ({
    page,
  }) => {
    const actions: SubmittedAction[] = [];
    await mockSupabase(page, actions);
    await authenticate(page);
    await page.goto("/");
    await page.evaluate(
      ({ ownerId }) => {
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: "notification-action",
              action: "snooze",
              occurrenceId: "occurrence-1",
              ownerId,
            },
          }),
        );
      },
      { ownerId },
    );
    await expect(
      page.getByText("When should we remind you?", { exact: true }),
    ).toBeVisible();
    expect(actions).toHaveLength(0);
    await page.getByRole("button", { name: "5 min", exact: true }).click();
    await expect.poll(() => actions.length).toBe(1);
  });

  test("queued postponement keeps its absolute time through refresh", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-10-07T12:51:59.000Z") });
    await page.clock.pauseAt(new Date("2026-10-07T12:52:00.000Z"));
    const hourly: Reminder[] = [
      { ...reminders[0]!, schedule: { kind: "cron", expression: "0 * * * *" } },
    ];
    await mockSupabase(page, [], "light", hourly);
    await page.route(
      `${supabaseOrigin}/functions/v1/occurrence-action`,
      (route) => route.abort(),
    );
    await authenticate(page, hourly);
    await page.goto("/");
    await page
      .getByRole("button", {
        name: new RegExp(`^Postpone ${hourly[0]!.title},`),
      })
      .click();
    await page.getByRole("button", { name: "5 min", exact: true }).click();
    await expect(page.getByText(/Your reminder action is saved/)).toBeVisible();
    await page.clock.runFor(2 * 60_000);
    await page.reload();
    await expect(page.getByText(/Your reminder action is saved/)).toBeVisible();
    const until = await page.evaluate(() => {
      const actions = JSON.parse(
        localStorage.getItem("cron-reminder:notification-actions")!,
      );
      return actions[0]?.until;
    });
    expect(until).toBe("2026-10-07T12:57:00.000Z");
  });

  for (const theme of ["light", "dark"] as const) {
    test(`reminder actions work with keyboard and contrast in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      await mockSupabase(page, [], theme);
      await authenticate(page);
      await page.setViewportSize({ width: 390, height: 900 });
      await page.goto("/");
      await page.addStyleTag({
        content:
          "* { transition: none !important; animation: none !important; }",
      });
      await page.mouse.move(0, 0);
      await expect(
        page.getByRole("button", {
          name: new RegExp(`^Complete ${reminders[0]!.title},`),
        }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`agenda-${theme}.png`),
        fullPage: true,
      });
      const html = await page.evaluate(() => {
        const documentClone = document.documentElement.cloneNode(
          true,
        ) as HTMLElement;
        documentClone
          .querySelectorAll("script, link[rel=stylesheet], style")
          .forEach((element) => element.remove());
        const style = document.createElement("style");
        style.textContent = Array.from(document.styleSheets)
          .flatMap((sheet) =>
            Array.from(sheet.cssRules, (rule) => rule.cssText),
          )
          .join("\n");
        documentClone.querySelector("head")!.append(style);
        return `<!doctype html>${documentClone.outerHTML}`;
      });
      await testInfo.attach(`agenda-${theme}.html`, {
        body: html,
        contentType: "text/html",
      });
      await writeFile(testInfo.outputPath(`agenda-${theme}.html`), html);
      for (const label of ["Dismiss", "Postpone", "Complete"]) {
        const button = page.getByRole("button", {
          name: new RegExp(`^${label} ${reminders[0]!.title},`),
        });
        await expectControlContrast(button, `${theme} ${label}`);
      }
      for (const width of [280, 320, 414]) {
        await page.setViewportSize({ width, height: 900 });
        await expectSoundLayout(page, `${theme} agenda at ${width}px`);
      }
      await page.setViewportSize({ width: 390, height: 900 });
      const complete = page.getByRole("button", {
        name: new RegExp(`^Complete ${reminders[0]!.title},`),
      });
      await page
        .getByRole("button", {
          name: new RegExp(`^Postpone ${reminders[0]!.title},`),
        })
        .focus();
      await page.keyboard.press("Tab");
      await expect(complete).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(complete).toHaveCount(0);
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: testInfo.outputPath(`agenda-${theme}-completed.png`),
        fullPage: true,
      });
    });
  }

  for (const route of [
    { path: "/", heading: "Today and upcoming", name: "agenda" },
    { path: "/reminders", heading: "Reminders", name: "reminders" },
    { path: "/history", heading: "History", name: "history" },
    { path: "/settings", heading: "Settings", name: "settings" },
  ]) {
    test(`${route.name} route has no overflow, clipping, or overlap`, async ({
      page,
    }) => {
      await mockSupabase(page);
      await authenticate(page);
      const consoleErrors = captureLayoutConsoleErrors(page);

      for (const width of viewportWidths) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(route.path);
        await expect(
          page.getByRole("heading", { name: route.heading }),
        ).toBeVisible();
        await expectSoundLayout(page, `${route.name} at ${width}px`);
      }
      expect(
        consoleErrors,
        `${route.name} emitted layout console errors`,
      ).toEqual([]);
    });
  }

  test("settings imports a backup from a JSON file", async ({ page }) => {
    await mockSupabase(page);
    await authenticate(page);
    await page.goto("/settings");

    const importButton = page.getByRole("button", {
      name: "Import JSON",
      exact: true,
    });
    await expect(page.locator("textarea")).toHaveCount(0);
    await expect(importButton).toBeDisabled();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose JSON backup file" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: "cron-reminder-backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          version: 1,
          exportedAt: "2026-09-26T12:00:00.000Z",
          reminders: [
            {
              ...reminders[0],
              id: "imported-reminder",
              title: "Imported reminder",
            },
          ],
        }),
      ),
    });

    await expect(
      page.getByText("Selected file: cron-reminder-backup.json"),
    ).toBeVisible();
    await expect(importButton).toBeEnabled();
    await importButton.click();
    await expect(
      page.getByText(/1 imported, 0 skipped, 0 invalid/),
    ).toBeVisible();
    await expect(page.getByText("No JSON file selected.")).toBeVisible();
  });

  test("reminder editor has no overflow, clipping, or overlap", async ({
    page,
  }) => {
    await mockSupabase(page);
    await authenticate(page);
    const consoleErrors = captureLayoutConsoleErrors(page);

    for (const width of viewportWidths) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/reminders");
      await page.getByRole("button", { name: "Add reminder" }).click();
      await expect(
        page.getByRole("heading", { name: "Add reminder" }),
      ).toBeVisible();
      await expect(
        page.getByRole("combobox", { name: "Alert style" }),
      ).toHaveValue("default");
      await expect(
        page.getByRole("option", { name: "Default sound" }),
      ).toHaveCount(1);
      await expect(page.getByRole("option", { name: "Silent" })).toHaveCount(1);
      await expect(
        page.getByRole("option", { name: "Vibrate only" }),
      ).toHaveCount(1);
      await expectSoundLayout(page, `reminder editor at ${width}px`);
    }
    expect(
      consoleErrors,
      "reminder editor emitted layout console errors",
    ).toEqual([]);
  });

  test("schedule numbers use native constrained controls", async ({ page }) => {
    await mockSupabase(page);
    await authenticate(page);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/reminders");
    await page.getByRole("button", { name: "Add reminder" }).click();

    const frequency = page.getByRole("combobox", { name: "Frequency" });

    await frequency.selectOption("interval");
    await expect(
      page.getByRole("spinbutton", { name: "Repeat every (minutes)" }),
    ).toHaveAttribute("min", "1");
    await expect(
      page.getByRole("spinbutton", { name: "Repeat every (minutes)" }),
    ).toHaveAttribute("max", "59");

    await frequency.selectOption("monthly");
    await expect(
      page.getByRole("spinbutton", { name: "Day of month" }),
    ).toHaveAttribute("max", "31");

    await frequency.selectOption("yearly");
    await expect(
      page.getByRole("spinbutton", { name: "Month", exact: true }),
    ).toHaveAttribute("max", "12");
    await expect(
      page.getByRole("spinbutton", { name: "Day", exact: true }),
    ).toHaveAttribute("max", "31");
  });
});
