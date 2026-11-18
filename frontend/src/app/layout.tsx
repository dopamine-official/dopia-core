import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import { AdultVerificationHost, ConsentHost, LoginHost } from "@/components/ui";
import { defaultLocale } from "@/i18n";
import "./globals.css";
export const metadata: Metadata = {
  title: "Character Chat",
  description: "A local character chat preview.",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={defaultLocale} suppressHydrationWarning>
      <head>
        {/* A folded sidebar applies before first paint, and folding it in another tab
            applies here at once. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem("dopia:sidebar")==="closed")document.documentElement.dataset.sidebar="closed"}catch(e){}addEventListener("storage",function(e){if(e.key==="dopia:sidebar"){if(e.newValue==="closed")document.documentElement.dataset.sidebar="closed";else delete document.documentElement.dataset.sidebar}})`,
          }}
        />
      </head>
      <body>
        <Providers>
          {children}
          <LoginHost />
          <AdultVerificationHost />
          <ConsentHost />
        </Providers>
      </body>
    </html>
  );
}
