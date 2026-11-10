"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { accountSchema } from "@/lib/contracts";
import { errorMessageKey } from "@/lib/errors";
import { errorCode } from "@/lib/analytics";
import { Screen, useTrack } from "./page";
import { useMembersOnly, useSession } from "./providers";
import {
  Avatar,
  Footer,
  Icon,
  Modal,
  SiteHeader,
  useLeave,
  type CloseReason,
} from "./ui";
import { RecentChats } from "./recent-chats";

export function Profile() {
  return (
    <Screen page="me">
      <ProfileScreen />
    </Screen>
  );
}
function ProfileScreen() {
  const { account, t } = useSession();
  const [edit, setEdit] = useState(false);
  const [withdraw, setWithdraw] = useState(false);
  const { busy, leave: leaveAs } = useLeave();
  const leave = (remove = false) => leaveAs(remove, () => setWithdraw(false));
  const send = useTrack();
  const viewed = useRef(false);
  useEffect(() => {
    // Members only: a guest is sent on to the login modal (TRACKING-PLAN 6-1).
    if (account.is_guest || viewed.current) return;
    viewed.current = true;
    send("me_viewed");
  }, [account.is_guest, send]);
  // Guests cannot see this page: the login modal over home, and back here after login.
  const member = useMembersOnly("/me");
  if (!member) return null;
  function cancelWithdraw(method: "cancel" | "outside" | "escape") {
    // Once the withdrawal is sent, closing the modal no longer cancels it.
    if (!busy) send("withdraw_cancelled", { method });
    setWithdraw(false);
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
            onClick={() => {
              send("profile_edit_clicked");
              setEdit(true);
            }}
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
              onClick={() => {
                send("withdraw_clicked");
                setWithdraw(true);
              }}
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
          onClose={(reason) =>
            cancelWithdraw(reason === "button" ? "cancel" : reason)
          }
        >
          <p className="muted">{t("account.me.withdraw_body")}</p>
          <div className="modal_actions">
            <button className="button" onClick={() => cancelWithdraw("cancel")}>
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
  const send = useTrack();
  const methods: Record<CloseReason, "close" | "outside" | "escape"> = {
    button: "close",
    outside: "outside",
    escape: "escape",
  };
  /** Closed without saving (TRACKING-PLAN 6-7). */
  function close(method: "cancel" | "close" | "outside" | "escape") {
    // Once the save is sent, closing does not drop it; its result is recorded instead.
    if (!busy) send("profile_edit_closed", { method });
    onClose();
  }
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
    const checked = (result: "accepted" | "invalid_type" | "too_large") =>
      send("profile_photo_selected", { result });
    if (!["image/png", "image/jpeg", "image/webp"].includes(selected.type)) {
      checked("invalid_type");
      setError("account.me.photo_type_invalid");
      return;
    }
    if (selected.size > 2 * 1024 * 1024) {
      checked("too_large");
      setError("account.me.photo_large");
      return;
    }
    try {
      const bitmap = await createImageBitmap(selected);
      bitmap.close();
      checked("accepted");
      setFile(selected);
      setError("");
    } catch {
      checked("invalid_type");
      setError("account.me.photo_type_invalid");
    }
  }
  async function save() {
    if (busy) return;
    send("profile_save_clicked");
    if (!nickname.trim()) {
      send("profile_update_failed", { code: "nickname_required" });
      setError("account.me.nickname_required");
      return;
    }
    setBusy(true);
    setError("");
    const form = new FormData();
    const nicknameChanged = nickname.trim() !== account.nickname;
    if (nicknameChanged) form.set("nickname", nickname.trim());
    if (file) form.set("photo", file);
    let next;
    try {
      next = await api("/account/me", accountSchema, {
        method: "PATCH",
        body: form,
      });
    } catch (error) {
      // Nothing changed is refused by the server as invalid input, and counted here.
      send("profile_update_failed", { code: errorCode(error) });
      setError(errorMessageKey(error));
      setBusy(false);
      return;
    }
    send("profile_updated", {
      changed: nicknameChanged && file ? "both" : file ? "photo" : "nickname",
    });
    changeAccount(next);
    notice(t("account.me.saved"));
    onClose();
  }
  return (
    <Modal
      title={t("account.me.edit")}
      onClose={(reason) => close(methods[reason])}
    >
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
          <button
            type="button"
            className="button"
            onClick={() => close("cancel")}
          >
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
