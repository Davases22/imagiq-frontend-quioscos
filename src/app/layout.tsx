/**
 * 🏗️ LAYOUT RAÍZ - IMAGIQ ECOMMERCE
 */

import type { Metadata } from "next";
import { samsungSharpSans } from "./fonts";
import { ThreeDSScript } from "@/components/ThreeDSScript";
// Nota: eliminamos la importación de Inter desde next/font/google para evitar
// hacer fetch a fonts.googleapis.com durante el build en entornos sin acceso.
// Usaremos una variable CSS --font-inter definida en globals.css como fallback.
import "./globals.css";

// 🔐 SECURITY: La inicialización del sistema de encriptación se hace en ClientLayout.tsx
// (debe ejecutarse en el cliente, no en el servidor)

import { AuthProvider } from "@/features/auth/context";
import { CartProvider } from "@/features/cart/CartContext";
import { AnalyticsProvider } from "@/features/analytics/AnalyticsContext";
import { UserPreferencesProvider } from "@/features/user/UserPreferencesContext";
import { PostHogProvider } from "@/features/analytics/PostHogProvider";
import { Toaster } from "@/components/ui/sonner";
import ClientLayout from "./ClientLayout";
import AnalyticsScripts from "@/components/analytics/AnalyticsScripts";
import AnalyticsInit from "@/components/analytics/AnalyticsInit";
import { ResponsiveProvider } from "@/components/responsive"; // Importa el provider
import { NavbarVisibilityProvider } from "@/features/layout/NavbarVisibilityContext";
import { ProductProvider } from "@/features/products/ProductContext";
import { SelectedColorProvider } from "@/contexts/SelectedColorContext";
import { PointsProvider } from "@/contexts/PointsContext";
import { SelectedStoreProvider } from "@/contexts/SelectedStoreContext";
import { HeroProvider } from "@/contexts/HeroContext";
import { CategoryMetadataProvider } from "@/contexts/CategoryMetadataContext";
import MaintenanceScreen from "@/components/MaintenanceScreen";
import DevToolsGuard from "@/components/security/DevToolsGuard";
import SecurityInitializer from "@/components/security/SecurityInitializer";
// Si necesitas Inter desde Google Fonts en entornos con internet,
// reactivar la importación desde next/font/google o agregar el CSS manual.

export const metadata: Metadata = {
  metadataBase: new URL("https://imagiq.com"),
  title: {
    default: "Samsung Store - iMagiQ Colombia",
    template: "%s | Samsung Store",
  },
  description:
    "Imagiq - Distribuidor oficial de Samsung en Colombia. Encuentra los últimos Galaxy, tablets, wearables y electrodomésticos con garantía oficial. Envío gratis, soporte especializado y las mejores promociones.",
  keywords: [
    "Samsung Colombia",
    "distribuidor oficial Samsung",
    "Galaxy",
    "Samsung Store",
    "electrodomésticos Samsung",
    "tablets Samsung",
    "smartwatch Samsung",
    "Galaxy Z Fold",
    "Galaxy Z Flip",
    "tienda Samsung Colombia",
  ],
  authors: [{ name: "Imagiq Team", url: "https://imagiq.com" }],
  creator: "Samsung Store",
  publisher: "Samsung Store",
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  // Se declaran explícitamente para que iOS use el icono correcto. Los
  // navegadores los piden por convención aunque no se declaren, y hasta ahora
  // no existían: cada petición caía en la ruta de páginas dinámicas y
  // devolvía un error.
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon.png", type: "image/png", sizes: "32x32" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    type: "website",
    locale: "es_CO",
    url: "https://imagiq.com",
    siteName: "Samsung Store",
    title: "Samsung Store",
    description:
      "Distribuidor oficial de Samsung en Colombia. Galaxy, tablets, wearables y electrodomésticos con garantía oficial.",
    images: [
      {
        url: "/logo-og.png",
        width: 1200,
        height: 630,
        alt: "Samsung Store Logo",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@imagiqstore",
    creator: "@imagiqstore",
  },
  verification: {
    google: process.env.NEXT_PUBLIC_GOOGLE_VERIFICATION,
  },
  alternates: {
    canonical: "https://imagiq.com",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover", // Importante para iOS safe-area
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Verificar si el modo mantenimiento está activado
  const isMaintenanceMode =
    process.env.NEXT_PUBLIC_MAINTENANCE_MODE === "true";

  // Validar children para evitar NaN, null, undefined o string vacío
  let safeChildren = children;
  const isNaNValue =
    (typeof children === "number" && Number.isNaN(children)) ||
    (typeof children === "string" &&
      (children === "NaN" || children.trim() === "")) ||
    children == null;
  if (isNaNValue) {
    safeChildren = <></>;
  }
  return (
    <html
      lang="es"
      className={`${samsungSharpSans.variable}`}
      style={
        {
          "--font-inter":
            "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial",
        } as React.CSSProperties
      }
    >
      <head>
        {/* Optimización Flixmedia: DNS prefetch, preconnect y preload para carga ultra-rápida */}
        <link rel="dns-prefetch" href="//media.flixfacts.com" />
        <link rel="dns-prefetch" href="//media.flixcar.com" />
        <link rel="preconnect" href="https://media.flixfacts.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://media.flixcar.com" crossOrigin="anonymous" />
        <link rel="preload" href="//media.flixfacts.com/js/loader.js" as="script" />
        {/* JSON-LD: WebSite — controls site name in Google SERPs (especially mobile) */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: "Samsung Store",
              alternateName: ["Samsung Store iMagiQ", "Samsung Store Colombia"],
              url: "https://imagiq.com",
            }),
          }}
        />
      </head>
      <body className="antialiased">
        <SecurityInitializer>
          <AnalyticsScripts />
          <AnalyticsInit />

          <DevToolsGuard>
            <ResponsiveProvider>
              <CategoryMetadataProvider>
              <HeroProvider>
                <ProductProvider>
                  <NavbarVisibilityProvider>
                    <PostHogProvider>
                      <AnalyticsProvider>
                        <AuthProvider>
                          <UserPreferencesProvider>
                            <CartProvider>
                              <SelectedColorProvider>
                                <PointsProvider>
                                  <SelectedStoreProvider>
                                      {/* Mostrar pantalla de mantenimiento si está activada */}
                                      {isMaintenanceMode ? (
                                        <MaintenanceScreen />
                                      ) : (
                                        <ClientLayout>{safeChildren}</ClientLayout>
                                      )}
                                  </SelectedStoreProvider>
                                  {/* Toast notifications */}
                                  <Toaster
                                    position="top-center"
                                    expand={true}
                                    richColors
                                    closeButton
                                    toastOptions={{
                                      duration: 4000,
                                      style: {
                                        background: "white",
                                        border: "1px solid #e2e8f0",
                                        color: "#1e293b",
                                        fontFamily: "var(--font-inter)",
                                      },
                                    }}
                                  />
                                </PointsProvider>
                              </SelectedColorProvider>
                            </CartProvider>
                          </UserPreferencesProvider>
                        </AuthProvider>
                      </AnalyticsProvider>
                    </PostHogProvider>
                  </NavbarVisibilityProvider>
                </ProductProvider>
              </HeroProvider>
              </CategoryMetadataProvider>
            </ResponsiveProvider>
          </DevToolsGuard>
        </SecurityInitializer>
        <ThreeDSScript />
      </body>
    </html>
  );
}
