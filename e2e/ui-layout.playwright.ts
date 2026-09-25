import { expect, test, type Page } from "@playwright/test";

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

const databaseReminders = reminders.map((reminder) => ({
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
}));

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

const occurrences = [
  {
    id: "occurrence-1",
    reminder_id: "daily-operations-review",
    scheduled_at: "2026-09-25T16:30:00.000Z",
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

async function mockSupabase(page: Page): Promise<void> {
  await page.route(`${supabaseOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const table = url.pathname.split("/").at(-1);
    let body: unknown = [];

    if (table === "profiles") {
      body =
        request.method() === "GET" ? { locale: "en", theme: "light" } : null;
    } else if (table === "reminders") {
      body = databaseReminders;
    } else if (table === "occurrences") {
      body = occurrences;
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

async function authenticate(page: Page): Promise<void> {
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
      seededReminders: reminders,
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
    const isVisible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
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
      const firstRect = first.getBoundingClientRect();
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
        const secondRect = second.getBoundingClientRect();
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

test.describe("responsive UI layout", () => {
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
      for (const label of ["Default", "Silent", "Vibrate"]) {
        await expect(
          page.getByRole("button", { name: label, exact: true }),
        ).toBeVisible();
      }
      await expectSoundLayout(page, `reminder editor at ${width}px`);
    }
    expect(
      consoleErrors,
      "reminder editor emitted layout console errors",
    ).toEqual([]);
  });
});
