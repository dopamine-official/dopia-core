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
    <html lang={defaultLocale} data-theme="dark" suppressHydrationWarning>
      <head>
        {/* Dark is the default; a saved light choice applies before first paint, and a
            choice made in another tab applies here at once. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem("dopia:theme")==="light")document.documentElement.dataset.theme="light"}catch(e){}addEventListener("storage",function(e){if(e.key==="dopia:theme")document.documentElement.dataset.theme=e.newValue==="light"?"light":"dark"})`,
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
