import { expect, test } from "@playwright/test";

test("the app is installable before signing in or enabling notifications", async ({
  page,
}) => {
  await page.goto("/");
  const manifestUrl = new URL(
    (await page.locator('link[rel="manifest"]').getAttribute("href"))!,
    page.url(),
  );
  const response = await page.request.get(manifestUrl.href);
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toMatch(
    /application\/(?:manifest\+)?json/,
  );
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    id: "/",
    name: "Cron Reminder",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  expect(manifest.icons).toHaveLength(2);
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(
      (candidate: { sizes: string }) => candidate.sizes === `${size}x${size}`,
    );
    expect(icon).toMatchObject({ type: "image/png" });
    expect(icon.purpose.split(" ")).toContain("any");
    const dimensions = await page.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }, new URL(icon.src, manifestUrl).href);
    expect(dimensions).toEqual([size, size]);
  }
  expect(
    manifest.icons.some((icon: { purpose: string }) =>
      icon.purpose.split(" ").includes("maskable"),
    ),
  ).toBe(true);
  const appleIconUrl = await page
    .locator('link[rel="apple-touch-icon"]')
    .getAttribute("href");
  const appleDimensions = await page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  }, new URL(appleIconUrl!, page.url()).href);
  expect(appleDimensions).toEqual([180, 180]);
  const session = await page.context().newCDPSession(page);
  const appManifest = await session.send("Page.getAppManifest");
  expect(appManifest.url).toBe(manifestUrl.href);
  expect(appManifest.errors).toEqual([]);
  const installability = await session.send("Page.getInstallabilityErrors");
  expect(installability.installabilityErrors).toEqual([]);
});
