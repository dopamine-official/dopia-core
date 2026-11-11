import { expect, sent, settle, signIn, test } from "./fixtures";
import { installStubs, setStubs } from "./stubs";

test.describe("terms", () => {
  test.use({ autoConsent: false });
  test("first visit asks for the required terms before anything else", async ({
    page,
  }) => {
    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: "서비스 이용 동의" });
    await expect(dialog).toBeVisible();
    const agree = dialog.getByRole("button", { name: "동의하고 시작하기" });
    await expect(agree).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    // Each item unfolds its text under it and folds it back.
    const details = dialog.getByRole("button", {
      name: "이용약관 자세히 보기",
    });
    await expect(details).toHaveText("자세히 보기");
    await details.click();
    const hide = dialog.getByRole("button", { name: "이용약관 숨기기" });
    await expect(hide).toHaveAttribute("aria-expanded", "true");
    await expect(
      dialog.getByRole("region", { name: "이용약관 내용" }),
    ).toHaveText(/\[약관 내용\]/);
    await hide.click();
    await expect(dialog.locator("#consent_body_terms")).toBeHidden();
    await dialog.getByRole("checkbox", { name: "이용약관" }).check();
    await expect(agree).toBeDisabled();
    await dialog
      .getByRole("checkbox", { name: "개인정보 수집 및 이용" })
      .check();
    await expect(
      dialog.getByRole("checkbox", { name: "전체 동의" }),
    ).toBeChecked();
    await agree.click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(
      page.getByRole("switch", { name: "세이프 모드" }),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "서비스 이용 동의" }),
    ).toBeHidden();
  });

  test("the browser remembers the consents after a logout, not after a withdrawal", async ({
    page,
    analytics,
  }) => {
    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: "서비스 이용 동의" });
    await dialog.getByRole("checkbox", { name: "전체 동의" }).check();
    await dialog.getByRole("button", { name: "동의하고 시작하기" }).click();
    await expect(dialog).toBeHidden();
    await signIn(page);
    await page.getByRole("button", { name: "내 프로필", exact: true }).click();
    await page
      .getByRole("navigation", { name: "내 메뉴", exact: true })
      .getByRole("button", { name: "로그아웃", exact: true })
      .click();
    await expect(
      page
        .locator(".site_header")
        .getByRole("button", { name: "로그인", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("switch", { name: "세이프 모드" }),
    ).toBeVisible();
    await expect(dialog).toBeHidden();

    await signIn(page);
    await page.goto("/me");
    await page.getByRole("button", { name: "회원 탈퇴", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "회원 탈퇴", exact: true })
      .click();
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL("/");
    // Shown on home, where the withdrawal went, not on My Page.
    await sent(analytics, "consent_modal_viewed", { page: "home" });
    await settle(page);
    expect(
      analytics.filter(
        (item) =>
          item.event === "consent_modal_viewed" &&
          item.properties.page === "me",
      ),
    ).toHaveLength(0);
    await page.reload();
    await expect(dialog).toBeVisible();
  });

  test("the terms modal sends its events (TRACKING-PLAN 9-1 to 9-5)", async ({
    page,
    analytics,
  }) => {
    await installStubs(page, [
      { path: "/api/v1/account/me/consents", method: "POST", status: 503 },
    ]);
    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: "서비스 이용 동의" });
    const viewed = await sent(analytics, "consent_modal_viewed");
    expect(viewed.properties.items).toEqual(["terms", "privacy"]);
    await dialog.getByRole("button", { name: "이용약관 자세히 보기" }).click();
    await sent(analytics, "consent_detail_toggled", {
      item: "terms",
      open: true,
    });
    await dialog.getByRole("checkbox", { name: "전체 동의" }).check();
    await sent(analytics, "consent_checked", { item: "all", checked: true });
    await dialog.getByRole("checkbox", { name: "이용약관" }).uncheck();
    await sent(analytics, "consent_checked", {
      item: "terms",
      checked: false,
    });
    await dialog.getByRole("checkbox", { name: "이용약관" }).check();
    await dialog.getByRole("button", { name: "동의하고 시작하기" }).click();
    const clicked = await sent(analytics, "consent_agree_clicked");
    expect(clicked.properties.items).toEqual(["terms", "privacy"]);
    await sent(analytics, "consent_failed", { code: "e2e_down" });
    await settle(page);
    // The whole row is one event, never one per item as well.
    expect(
      analytics.filter((item) => item.event === "consent_checked"),
    ).toHaveLength(3);
    expect(
      analytics.filter((item) => item.event === "consent_modal_viewed"),
    ).toHaveLength(1);
  });
});

test("the adult verification modal sends its events (TRACKING-PLAN 9-6 to 9-9)", async ({
  page,
  analytics,
}) => {
  await installStubs(page);
  await page.goto("/");
  await signIn(page);
  const toggle = page.getByRole("switch", { name: "세이프 모드" });
  const dialog = page.getByRole("dialog", { name: "성인 인증" });
  await toggle.click();
  await sent(analytics, "adult_verification_viewed");
  await page.keyboard.press("Escape");
  await sent(analytics, "adult_verification_closed", {
    method: "escape",
    rejected: false,
  });
  await setStubs(page, [
    { path: "/api/v1/account/me/adult_verification", status: 503 },
  ]);
  await toggle.click();
  await dialog.getByRole("radio", { name: "여성" }).check();
  const young = new Date();
  young.setUTCFullYear(young.getUTCFullYear() - 10);
  await dialog.getByLabel("생년월일").fill(young.toISOString().slice(0, 10));
  await dialog.getByRole("button", { name: "확인" }).click();
  await sent(analytics, "adult_verification_submit_clicked");
  await sent(analytics, "adult_verification_failed", { code: "e2e_down" });
  await setStubs(page, []);
  await dialog.getByRole("button", { name: "확인" }).click();
  await expect(
    dialog.getByText("만 18세 미만은 성인 콘텐츠를 이용할 수 없어요."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "취소" }).click();
  await sent(analytics, "adult_verification_closed", {
    method: "cancel",
    rejected: true,
  });
  await toggle.click();
  await sent(analytics, "safe_toggle_finished", {
    to: "safe_off",
    result: "verification_rejected",
  });
});

test("SAFE off asks an unverified member for gender and birth date once", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "로그인" }).first().click();
  await page.getByRole("button", { name: "Google로 로그인" }).click();
  const toggle = page.getByRole("switch", { name: "세이프 모드" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  const dialog = page.getByRole("dialog", { name: "성인 인증" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img", { name: "등급 표시" })).toBeVisible();
  await expect(
    dialog.getByText("만 18세 미만은 이용할 수 없습니다"),
  ).toBeVisible();
  const submit = dialog.getByRole("button", { name: "확인" });
  await expect(submit).toBeDisabled();
  await dialog.getByRole("radio", { name: "남성" }).check();
  await dialog.getByLabel("생년월일").fill("1999-03-14");
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});

test("an underage submission is refused and SAFE stays on", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "로그인" }).first().click();
  await page.getByRole("button", { name: "Google로 로그인" }).click();
  const toggle = page.getByRole("switch", { name: "세이프 모드" });
  await toggle.click();
  const dialog = page.getByRole("dialog", { name: "성인 인증" });
  await dialog.getByRole("radio", { name: "여성" }).check();
  const young = new Date();
  young.setUTCFullYear(young.getUTCFullYear() - 10);
  await dialog.getByLabel("생년월일").fill(young.toISOString().slice(0, 10));
  await dialog.getByRole("button", { name: "확인" }).click();
  await expect(
    dialog.getByText("만 18세 미만은 성인 콘텐츠를 이용할 수 없어요."),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "확인" })).toBeDisabled();
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(page.getByRole("dialog", { name: "성인 인증" })).toBeHidden();
  await expect(
    page.getByText("성인 인증 조건을 충족하지 않아 SAFE를 끌 수 없어요."),
  ).toBeVisible();
});
