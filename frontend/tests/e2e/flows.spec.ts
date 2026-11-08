import { test, expect, type Page } from "@playwright/test";
async function home(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "오리지널", exact: true }),
  ).toBeVisible();
}
async function openChat(page: Page) {
  await home(page);
  await page
    .getByRole("button", { name: "겨울 대화 시작", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "메시지", exact: true }),
  ).toBeEnabled();
}
async function send(page: Page, value: string) {
  await page.getByRole("textbox", { name: "메시지", exact: true }).fill(value);
  await page
    .getByRole("button", { name: "메시지 보내기", exact: true })
    .click();
}
async function scenario(page: Page, kind: string) {
  await page.goto("/preview");
  await page
    .getByRole("combobox", { name: "다음 답변", exact: true })
    .selectOption(kind);
  await expect(
    page.getByRole("status").filter({ hasText: "설정을 저장했어요." }),
  ).toBeVisible();
}

test("three locales, preserved messages, no external requests", async ({
  page,
}) => {
  const external: string[] = [];
  const errors: string[] = [];
  page.on("request", (req) => {
    if (
      /^https?:/.test(req.url()) &&
      !req.url().startsWith("http://127.0.0.1:3000/")
    )
      external.push(req.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await openChat(page);
  const first = await page.locator(".message.assistant").first().innerText();
  await page
    .getByRole("combobox", { name: "언어", exact: true })
    .selectOption("en-US");
  await expect(
    page.getByRole("heading", { name: "Winter", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".message.assistant").first()).toHaveText(first);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Hello from the browser");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".message.assistant")).toHaveCount(2);
  await expect(page.locator(".message.assistant").last()).toContainText(
    "Let us walk together",
  );
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-TW");
  await expect(
    page.getByRole("heading", { name: "冬", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "訊息", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".message.assistant")).toHaveCount(2);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.locator("html").getAttribute("lang")).toBe("zh-TW");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("guest chat migrates on mock login, profile edits persist, logout isolates data", async ({
  page,
}) => {
  await openChat(page);
  const roomUrl = page.url();
  await send(page, "나의 첫 대화");
  await expect(page.locator(".message.assistant")).toHaveCount(2);
  await page.getByRole("link", { name: "로그인", exact: true }).click();
  await page
    .getByRole("button", { name: "Google로 로그인", exact: true })
    .click();
  await expect(page).toHaveURL(roomUrl);
  await expect(page.locator(".message.user")).toContainText("나의 첫 대화");
  await page.getByRole("link", { name: "마이페이지", exact: true }).click();
  await page.getByRole("button", { name: "프로필 수정", exact: true }).click();
  await page.getByLabel("닉네임", { exact: true }).fill("테스트 여행자");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.locator(".profile_box")).toContainText("테스트 여행자");
  await page.reload();
  await expect(page.locator(".profile_box")).toContainText("테스트 여행자");
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page).toHaveURL("/");
  await page.goto(roomUrl);
  await expect(page).toHaveURL("/");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await page
    .getByRole("dialog", { name: "이야기를 이어가세요" })
    .getByRole("button", { name: "Google로 로그인", exact: true })
    .click();
  await expect(page).toHaveURL("/");
  await page.goto(roomUrl);
  await expect(page.locator(".message.user")).toContainText("나의 첫 대화");
});

test("401 recovery continues the same message ID and preserves the next draft", async ({
  page,
}) => {
  await openChat(page);
  const roomUrl = page.url();
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    const attempts: string[] = [];
    window.fetch = async (input, init) => {
      if (String(input).endsWith("/messages") && init?.method === "POST") {
        attempts.push(String(init.body));
        sessionStorage.setItem(
          "dopia:recovery-attempts",
          JSON.stringify(attempts),
        );
        if (attempts.length === 1)
          return Response.json({ code: "unauthorized" }, { status: 401 });
      }
      return originalFetch(input, init);
    };
  });
  await send(page, "세션 복구 뒤에도 이어갈 메시지");
  const input = page.getByRole("textbox", { name: "메시지", exact: true });
  await input.fill("다음 메시지 초안");
  await expect(page.locator(".message.assistant")).toHaveCount(2);
  await expect(page.locator(".message.user")).toHaveCount(1);
  await expect(input).toHaveValue("다음 메시지 초안");
  await expect(page).toHaveURL(roomUrl);
  const attempts = await page.evaluate(
    () =>
      JSON.parse(
        sessionStorage.getItem("dopia:recovery-attempts") ?? "[]",
      ) as string[],
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBe(attempts[0]);
  expect(JSON.parse(attempts[0]).client_message_id).toBeTruthy();
});

test("failed reply restores the sent text and the next draft without keeping failed bubbles", async ({
  page,
}) => {
  await home(page);
  await scenario(page, "fail");
  await openChat(page);
  await send(page, "실패할 메시지");
  await page
    .getByRole("textbox", { name: "메시지", exact: true })
    .fill("다음에 보낼 메시지");
  await expect(page.locator(".inline_error")).toContainText("입력 내용을 복구");
  await expect(
    page.getByRole("textbox", { name: "메시지", exact: true }),
  ).toHaveValue("실패할 메시지\n다음에 보낼 메시지");
  await expect(page.locator(".message.user")).toHaveCount(0);
  await page
    .getByRole("button", { name: "메시지 보내기", exact: true })
    .click();
  await expect(page.locator(".message.assistant")).toHaveCount(2);
});

test("stream interruption recovers one reply by polling; reload during generation also completes", async ({
  page,
}) => {
  await home(page);
  await scenario(page, "disconnect");
  await openChat(page);
  await send(page, "연결 끊김");
  await expect(page.locator(".message.assistant")).toHaveCount(2);
  await expect(page.locator(".message.user")).toHaveCount(1);
  const url = page.url();
  await scenario(page, "slow");
  await page.goto(url);
  // The mock API runs inside the page, so the turn is only saved once the
  // POST has been answered. Reloading earlier aborts the request itself.
  const accepted = page.waitForResponse(
    (response) =>
      response.url().includes("/messages") &&
      response.request().method() === "POST",
  );
  await send(page, "새로고침 전송");
  await accepted;
  await expect(page.locator(".message.user")).toHaveCount(2);
  await page.reload();
  await expect(page.locator(".message.assistant")).toHaveCount(3);
  await page
    .getByRole("textbox", { name: "메시지", exact: true })
    .fill("새로운 초안");
  await expect(
    page.getByRole("button", { name: "메시지 보내기", exact: true }),
  ).toBeEnabled();
});

test("empty list, one-shot load failure, retry and preview reset", async ({
  page,
}) => {
  await home(page);
  await page.goto("/preview");
  await page
    .getByRole("combobox", { name: "홈 목록", exact: true })
    .selectOption("empty");
  await expect(
    page.getByRole("status").filter({ hasText: "설정을 저장했어요." }),
  ).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("지금은 공개된 캐릭터가 없어요.")).toBeVisible();
  await page.goto("/preview");
  await page
    .getByRole("combobox", { name: "홈 목록", exact: true })
    .selectOption("error");
  await expect(
    page.getByRole("status").filter({ hasText: "설정을 저장했어요." }),
  ).toBeVisible();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "오리지널", exact: true }),
  ).toBeVisible();
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  await page.goto("/preview");
  await page
    .getByRole("button", { name: "테스트 데이터 초기화", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "테스트 데이터 초기화", exact: true })
    .click();
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("link", { name: "로그인", exact: true }),
  ).toBeVisible();
});

test("SAFE requires login and adult verification without sending a PATCH", async ({
  page,
}) => {
  await home(page);
  const adult = page.getByRole("button", {
    name: "밤의 라운지, 레이 대화 시작",
    exact: true,
  });
  const changes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      request.url().endsWith("/account/me/adult_mode")
    )
      changes.push(request.url());
  });
  const safe = page.getByRole("switch", { name: "세이프 모드", exact: true });
  await expect(safe).toBeChecked();
  await expect(adult).toHaveCount(0);
  await safe.click();
  const login = page.getByRole("dialog", { name: "이야기를 이어가세요" });
  await expect(login).toBeVisible();
  await expect(page).toHaveURL("/");
  expect(changes).toEqual([]);
  await login
    .getByRole("button", { name: "Google로 로그인", exact: true })
    .click();
  await expect(page).toHaveURL("/");
  await expect(safe).toBeChecked();
  await safe.click();
  await expect(
    page.getByRole("status").filter({ hasText: "성인 인증이 필요해요." }),
  ).toBeVisible();
  await expect(safe).toBeChecked();
  await expect(adult).toHaveCount(0);
  expect(changes).toEqual([]);
});

test("dialog Escape restores focus", async ({ page }) => {
  await openChat(page);
  const menu = page.getByRole("button", {
    name: "대화 목록 열기 또는 닫기",
    exact: true,
  });
  await menu.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(menu).toBeFocused();
  await menu.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(menu).toBeFocused();
  await menu.click();
  const dialog = page.getByRole("dialog");
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.x + box!.width).toBeLessThan(viewport.width);
  await page.mouse.click(viewport.width - 1, viewport.height / 2);
  await expect(dialog).toHaveCount(0);
  await expect(menu).toBeFocused();
});

test("composition Enter does not send, Shift+Enter inserts newline, action button wraps selection", async ({
  page,
}) => {
  await openChat(page);
  const input = page.getByRole("textbox", { name: "메시지", exact: true });
  await input.fill("가");
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  await expect(page.locator(".message.user")).toHaveCount(0);
  await input.dispatchEvent("compositionend");
  // A synthetic composition cannot swallow Enter like a real IME does, so
  // reset the draft before checking Shift+Enter.
  await input.fill("가");
  await input.press("Shift+Enter");
  await input.press("b");
  await expect(input).toHaveValue("가\nb");
  await input.selectText();
  await page
    .getByRole("button", { name: "행동 묘사 입력", exact: true })
    .click();
  await expect(input).toHaveValue("*가\nb*");
  await input.press("Enter");
  await expect(page.locator(".message.assistant")).toHaveCount(2);
});
