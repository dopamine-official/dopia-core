"use client";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useSession } from "./providers";
import { useTrack } from "./page";
import { Modal, useSidebarShortcut } from "./ui";
import { DeleteChatModal, RecentChats, type RecentChat } from "./recent-chats";

// The recent chats sidebar, the same on every screen. On a wide screen it is a column beside
// the content and the choice to fold it is kept across screens and visits; on a narrow one it
// is a drawer that starts closed on every screen.
const KEY = "dopia:sidebar";

/** Follows `data-sidebar` on <html>, which `layout.tsx` sets before first paint. */
function subscribe(changed: () => void) {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-sidebar"],
  });
  return () => observer.disconnect();
}
const folded = () => document.documentElement.dataset.sidebar === "closed";

export type SidebarState = {
  /** Whether the list is on screen: the column on a wide screen, the drawer on a narrow one. */
  open: boolean;
  /** A change the visitor asked for: the menu button, the shortcut, or the drawer's close. */
  toggle: (open: boolean) => void;
  drawerOpen: boolean;
  /** Closes the drawer without counting it as the visitor's choice (a link was followed). */
  closeDrawer: () => void;
};

/** The sidebar's state for one screen, with Cmd/Ctrl+B bound to it. */
export function useSidebar(): SidebarState {
  const send = useTrack();
  const columnOpen = !useSyncExternalStore(subscribe, folded, () => false);
  const [mobile, setMobile] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 650px)");
    const update = () => {
      setMobile(media.matches);
      if (!media.matches) setDrawerOpen(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const open = mobile ? drawerOpen : columnOpen;
  function toggle(next: boolean) {
    send("sidebar_toggled", { open: next });
    if (mobile) {
      setDrawerOpen(next);
      return;
    }
    if (next) delete document.documentElement.dataset.sidebar;
    else document.documentElement.dataset.sidebar = "closed";
    try {
      if (next) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, "closed");
    } catch {
      // Storage may be blocked: the choice then lasts for this page only.
    }
  }
  useSidebarShortcut(() => toggle(!open));
  return {
    open,
    toggle,
    drawerOpen,
    closeDrawer: () => setDrawerOpen(false),
  };
}

export function Sidebar({
  state,
  currentId,
  onNavigate,
  onDeleted,
  drawerTitle,
}: {
  state: SidebarState;
  /** The room on screen: shown in the list but not a link. */
  currentId?: string;
  onNavigate?: () => void;
  /** After a chat is deleted; the chat room uses it to leave a deleted room. */
  onDeleted?: (chat: RecentChat) => void | Promise<void>;
  /** Shown in place of the drawer's title, for a screen whose header has no logo. */
  drawerTitle?: ReactNode;
}) {
  const { t } = useSession();
  const [deleteTarget, setDeleteTarget] = useState<RecentChat | null>(null);
  return (
    <>
      <aside className="home_sidebar" aria-label={t("common.recent")}>
        <h2>{t("common.recent")}</h2>
        <RecentChats
          currentId={currentId}
          onNavigate={onNavigate}
          onDelete={setDeleteTarget}
        />
      </aside>
      {state.drawerOpen && (
        <Modal
          drawer
          title={t("common.recent")}
          titleContent={drawerTitle}
          onClose={() => state.toggle(false)}
        >
          <RecentChats
            currentId={currentId}
            onNavigate={() => {
              onNavigate?.();
              state.closeDrawer();
            }}
            onDelete={(chat) => {
              state.closeDrawer();
              setDeleteTarget(chat);
            }}
          />
        </Modal>
      )}
      {deleteTarget && (
        <DeleteChatModal
          chat={deleteTarget}
          currentId={currentId}
          onClose={() => setDeleteTarget(null)}
          onDeleted={onDeleted}
        />
      )}
    </>
  );
}
