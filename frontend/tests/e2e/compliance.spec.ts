import { test, expect } from "./fixtures";

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
