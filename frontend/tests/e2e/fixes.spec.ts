import { type Page } from "@playwright/test";
import { expect, signIn, test } from "./fixtures";

async function home(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "오리지널", exact: true }),
  ).toBeVisible();
}

async function profile(page: Page) {
  await page.goto("/me");
  await page
    .getByRole("dialog", { name: "이야기를 이어가세요" })
    .getByRole("button", { name: "Google로 로그인", exact: true })
    .click();
  await expect(page.locator(".profile_box")).toBeVisible();
}

test("profile dialog restores focus and withdrawal returns home", async ({
  page,
}) => {
  await profile(page);
  const edit = page.getByRole("button", { name: "프로필 수정", exact: true });
  await edit.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "취소", exact: true })
    .click();
  await expect(edit).toBeFocused();
  await edit.click();
  await page.getByLabel("닉네임", { exact: true }).fill("초점 복귀 확인");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(edit).toBeFocused();

  await page.getByRole("button", { name: "회원 탈퇴", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "회원 탈퇴", exact: true })
    .click();
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("button", { name: "로그인", exact: true }),
  ).toBeVisible();
  await page.goto("/me");
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("dialog", { name: "이야기를 이어가세요" }),
  ).toBeVisible();
});

test("all cards lock during opening and recent navigation supersedes a late response", async ({
  page,
  isMobile,
}) => {
  await home(page);
  await signIn(page);
  await page
    .getByRole("button", { name: "겨울 대화 시작", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "메시지", exact: true }),
  ).toBeVisible();
  const originalRoom = page.url();
  await home(page);
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    let attempts = 0;
    window.fetch = async (input, init) => {
      if (String(input).endsWith("/chats/open") && init?.method === "POST") {
        sessionStorage.setItem("dopia:open-attempts", String(++attempts));
        // Deliberately ignore AbortSignal to also exercise the late-result guard.
        await new Promise<void>((resolve) =>
          window.addEventListener("dopia:release-open", () => resolve(), {
            once: true,
          }),
        );
        sessionStorage.setItem("dopia:open-resolved", "true");
        return Response.json({ room_id: crypto.randomUUID(), created: true });
      }
      return originalFetch(input, init);
    };
  });
  await page.locator(".card_link").first().click();
  const cards = page.locator(".card_link");
  for (let i = 0; i < (await cards.count()); i++)
    await expect(cards.nth(i)).toBeDisabled();
  await page
    .locator(".card_link")
    .nth(1)
    .evaluate((button: HTMLButtonElement) => button.click());
  expect(
    await page.evaluate(() => sessionStorage.getItem("dopia:open-attempts")),
  ).toBe("1");
  if (isMobile)
    await page
      .getByRole("button", { name: "대화 목록 열기 또는 닫기", exact: true })
      .click();
  const recent = isMobile
    ? page.getByRole("dialog")
    : page.locator(".home_sidebar");
  await recent.getByRole("link", { name: "겨울", exact: true }).click();
  await expect(page).toHaveURL(originalRoom);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("dopia:release-open")),
  );
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem("dopia:open-resolved")),
    )
    .toBe("true");
  await page
    .getByRole("textbox", { name: "메시지", exact: true })
    .fill("최근 대화에 계속 작성");
  await expect(page).toHaveURL(originalRoom);
});

test("two failed reads show server guidance and a manual retry recovers", async ({
  page,
}) => {
  await home(page);
  await page.getByRole("link", { name: "미리보기 설정", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "미리보기 설정", exact: true }),
  ).toBeVisible();
  // Every home read fails until the test releases the server. The dev server
  // runs React StrictMode, whose double mount cancels the first read, so the
  // automatic attempt count is 2 in production and 3 in development.
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    let attempts = 0;
    window.fetch = async (input, init) => {
      if (String(input).endsWith("/home")) {
        sessionStorage.setItem("dopia:read-attempts", String(++attempts));
        if (sessionStorage.getItem("dopia:release-home") !== "true")
          return Response.json({ code: "unavailable" }, { status: 503 });
      }
      return originalFetch(input, init);
    };
  });
  const attempts = () =>
    page.evaluate(() => Number(sessionStorage.getItem("dopia:read-attempts")));
  // A new locale gives the home query a fresh key without a cached success.
  await page
    .getByRole("combobox", { name: "언어", exact: true })
    .selectOption("en-US");
  await page.locator(".brand").click();
  await expect(page.locator("main").getByRole("alert")).toHaveText(
    "The server encountered a problem. Please try again shortly.",
  );
  const automatic = await attempts();
  expect(automatic).toBeGreaterThanOrEqual(2);
  expect(automatic).toBeLessThanOrEqual(3);
  await page.evaluate(() =>
    sessionStorage.setItem("dopia:release-home", "true"),
  );
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator(".card_link").first()).toBeEnabled();
  expect(await attempts()).toBe(automatic + 1);
});

test("profile server validation and upload size errors have distinct guidance", async ({
  page,
}) => {
  await profile(page);
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    let attempts = 0;
    window.fetch = async (input, init) => {
      if (String(input).endsWith("/account/me") && init?.method === "PATCH") {
        attempts++;
        return attempts === 1
          ? Response.json(
              {
                code: "invalid_input",
                detail: [{ field: "nickname", reason: "too_long" }],
              },
              { status: 422 },
            )
          : Response.json({ code: "file_too_large" }, { status: 413 });
      }
      return originalFetch(input, init);
    };
  });
  await page.getByRole("button", { name: "프로필 수정", exact: true }).click();
  await page.getByLabel("닉네임", { exact: true }).fill("서버 검증 확인");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(
    "닉네임 입력 조건을 확인해 주세요.",
  );
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "2MB",
  );
});
