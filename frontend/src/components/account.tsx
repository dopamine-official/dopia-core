"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api, readAccount } from "@/lib/api";
import { accountIdentitySchema, accountSchema } from "@/lib/contracts";
import { errorMessageKey } from "@/lib/errors";
import { useSession } from "./providers";
import { Avatar, Footer, Icon, Modal, SiteHeader } from "./ui";
import { RecentChats } from "./recent-chats";

export function Profile() {
  const { account, t, changeAccount, accountRedirect, notice } = useSession();
  const router = useRouter();
  const [edit, setEdit] = useState(false);
  const [withdraw, setWithdraw] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!account.is_guest) return;
    // Guests cannot see this page: show the login modal over home and return here after login.
    const failed =
      new URLSearchParams(window.location.search).get("error") ===
      "login_failed";
    router.replace(
      accountRedirect ??
        `/?login=1&return_to=%2Fme${failed ? "&error=login_failed" : ""}`,
    );
  }, [account.is_guest, accountRedirect, router]);
  if (account.is_guest) return null;
  async function leave(remove = false) {
    setBusy(true);
    try {
      const issued = await api(
        remove ? "/account/withdraw" : "/account/logout",
        accountIdentitySchema,
        { method: "POST" },
      );
      changeAccount(await readAccount(issued.account_id), "/");
    } catch (error) {
      setWithdraw(false);
      notice(t(errorMessageKey(error)));
      setBusy(false);
    }
  }
  return (
    <>
      <SiteHeader />
      <main id="main" className="account_main">
        <h1>{t("account.me.title")}</h1>
        <p className="muted">{t("account.me.subtitle")}</p>
        <section className="box profile_box">
          <Avatar large photo={account.photo_url} name={account.nickname} />
          <strong>{account.nickname}</strong>
          <button
            className="icon_button"
            aria-label={t("account.me.edit")}
            onClick={() => setEdit(true)}
          >
            <Icon name="edit" />
          </button>
        </section>
        <h2 className="account_section_title">{t("account.me.my_chats")}</h2>
        <section className="box profile_recent">
          <RecentChats />
        </section>
        <section className="box account_actions">
          <div className="account_row">
            <span>{t("account.me.logout")}</span>
            <button
              className="button"
              disabled={busy}
              onClick={() => void leave()}
            >
              {t("account.me.logout")}
            </button>
          </div>
          <div className="account_row">
            <div>
              <span>{t("account.me.withdraw")}</span>
              <p className="muted">{t("account.me.withdraw_notice")}</p>
            </div>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => setWithdraw(true)}
            >
              {t("account.me.withdraw")}
            </button>
          </div>
        </section>
        <Footer />
      </main>
      {edit && <EditProfile onClose={() => setEdit(false)} />}
      {withdraw && (
        <Modal
          title={t("account.me.withdraw_title")}
          onClose={() => setWithdraw(false)}
        >
          <p className="muted">{t("account.me.withdraw_body")}</p>
          <div className="modal_actions">
            <button className="button" onClick={() => setWithdraw(false)}>
              {t("common.cancel")}
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void leave(true)}
            >
              {t("account.me.withdraw")}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function EditProfile({ onClose }: { onClose: () => void }) {
  const { account, t, changeAccount, notice } = useSession();
  const [nickname, setNickname] = useState(account.nickname ?? "");
  const [file, setFile] = useState<File | null>(null);
  const fileUrl = useMemo(
    () => (file ? URL.createObjectURL(file) : null),
    [file],
  );
  const preview = fileUrl ?? account.photo_url;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(
    () => () => {
      if (fileUrl) URL.revokeObjectURL(fileUrl);
    },
    [fileUrl],
  );
  async function chooseFile(selected?: File) {
    if (!selected) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(selected.type)) {
      setError("account.me.photo_type_invalid");
      return;
    }
    if (selected.size > 2 * 1024 * 1024) {
      setError("account.me.photo_large");
      return;
    }
    try {
      const bitmap = await createImageBitmap(selected);
      bitmap.close();
      setFile(selected);
      setError("");
    } catch {
      setError("account.me.photo_type_invalid");
    }
  }
  async function save() {
    if (!nickname.trim()) {
      setError("account.me.nickname_required");
      return;
    }
    setBusy(true);
    setError("");
    const form = new FormData();
    if (nickname.trim() !== account.nickname)
      form.set("nickname", nickname.trim());
    if (file) form.set("photo", file);
    try {
      changeAccount(
        await api("/account/me", accountSchema, {
          method: "PATCH",
          body: form,
        }),
      );
      notice(t("account.me.saved"));
      onClose();
    } catch (error) {
      setError(errorMessageKey(error));
      setBusy(false);
    }
  }
  return (
    <Modal title={t("account.me.edit")} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="edit_avatar">
          <Avatar large photo={preview} name={nickname} />
        </div>
        <label className="field">
          {t("account.me.photo")}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(event) => void chooseFile(event.target.files?.[0])}
          />
        </label>
        <p className="field_help">{t("account.me.photo_help")}</p>
        <label className="field">
          {t("account.me.nickname")}
          <input
            autoFocus
            value={nickname}
            autoComplete="nickname"
            disabled={busy}
            onChange={(event) => setNickname(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="inline_error">
            {t(error)}
          </p>
        )}
        <div className="modal_actions">
          <button type="button" className="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || !nickname.trim()}
          >
            {t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
