import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  skipTrailingSlashRedirect: true,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "res.cloudinary.com",
        port: "",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "images.samsung.com",
        port: "",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "images.unsplash.com",
        port: "",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "www.bancolombia.com",
        port: "",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "ribgo.davivienda.com",
        port: "",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "purrfecthire.com",
        port: "",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "ics-networking.com",
        port: "",
        pathname: "/**",
      },
    ],
  },
  async redirects() {
    return [
      {
        source: "/soporte/comunidad",
        destination:
          "https://r1.community.samsung.com/t5/colombia/ct-p/co?profile.language=es&page=1&tab=recent_topics",
        permanent: false,
      },
      {
        source: "/soporte/comunidad",
        destination:
          "https://r1.community.samsung.com/t5/colombia/ct-p/co?profile.language=es&page=1&tab=recent_topics",
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/:path*`,
      },
      // PostHog reverse proxy - bypasses ad blockers
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            // OJO con los dominios de 3D Secure. ePayco sirve su
            // validateThreeds.min.js desde su propio CDN y lo actualiza sin
            // avisar: el 22-sep-2026 cambio los endpoints de
            // 3ds.epayco.com/cardinalcommerce.com a
            // apiflow.epayco.io/cardinaltrusted.com. Con el CSP viejo el
            // navegador bloquea el desafio, el cliente no ve nada y ePayco lo
            // registra como "El usuario pagador abandono el desafio". En la web
            // eso tumbo el 100% de los pagos con tarjeta de soporte durante dos
            // semanas ($5,3 millones sin cobrar); aqui estaba latente solo
            // porque el quiosco cobra poco con tarjeta.
            //
            // Se dejan los VIEJOS y los NUEVOS: ePayco puede revertir igual de
            // callado. Mismo cambio que imagiq-frontend PR #1208.
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* https://*.devtunnels.ms https://imagiq-backend-production.up.railway.app https://customer-success-ms-production.up.railway.app https://www.clarity.ms https://*.clarity.ms https://scripts.clarity.ms https://*.posthog.com https://us.i.posthog.com https://app.posthog.com https://www.googletagmanager.com https://www.google-analytics.com https://analytics.google.com https://googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://connect.facebook.net https://analytics.tiktok.com https://*.tiktok.com https://*.tiktokw.us https://media.flixcar.com https://media.flixfacts.com https://*.flix360.io https://*.flix360.com https://media.flixsyndication.net https://syndication.flix360.com https://content.jwplatform.com https://assets-jpcust.jwpsrv.com https://ssl.p.jwpcdn.com https://d3nkfb7815bs43.cloudfront.net https://d2m3ikv8mpgiy8.cloudfront.net https://d3np41mctoibfu.cloudfront.net https://media.pointandplace.com https://player.pointandplace.com https://t.pointandplace.com https://delivery-alpha.flix360.io https://delivery-beta.flix360.io https://maps.googleapis.com https://*.googleapis.com https://multimedia.epayco.co https://*.epayco.co https://*.epayco.com https://*.epayco.io https://*.cardinaltrusted.com https://device.clearsale.com.br https://vercel.live https://*.bancolombia.com https://*.bancolombia.com.co https://*.davivienda.com",
              "style-src 'self' 'unsafe-inline' https://media.flixcar.com https://media.flixfacts.com https://*.flix360.io https://*.flix360.com https://fonts.googleapis.com",
              "img-src 'self' data: blob: https: http: http://localhost:* https://www.clarity.ms https://*.clarity.ms https://www.google-analytics.com https://www.facebook.com https://media.flixcar.com https://media.flixfacts.com https://*.flix360.io https://*.flix360.com https://res.cloudinary.com https://images.samsung.com https://images.unsplash.com https://www.bancolombia.com https://ribgo.davivienda.com https://purrfecthire.com https://ics-networking.com https://d3nkfb7815bs43.cloudfront.net https://d2m3ikv8mpgiy8.cloudfront.net https://d3np41mctoibfu.cloudfront.net https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.ggpht.com https://*.googleusercontent.com",
              "font-src 'self' data: https://media.flixcar.com https://media.flixfacts.com https://*.flix360.io https://fonts.gstatic.com",
              "connect-src 'self' http://localhost:* https://*.devtunnels.ms ws://localhost:* wss://*.devtunnels.ms ws://imagiq-backend-production.up.railway.app wss://imagiq-backend-production.up.railway.app https://imagiq-backend-production.up.railway.app https://customer-success-ms-production.up.railway.app https://*.sentry.io https://*.ingest.sentry.io https://www.clarity.ms https://*.clarity.ms https://c.clarity.ms https://*.posthog.com https://us.i.posthog.com https://app.posthog.com https://www.googletagmanager.com https://googletagmanager.com https://www.google-analytics.com https://analytics.google.com https://region1.google-analytics.com https://www.facebook.com https://graph.facebook.com https://analytics.tiktok.com https://*.tiktok.com https://*.tiktokw.us https://www.google.com https://*.doubleclick.net https://www.googleadservices.com https://media.flixcar.com https://media.flixfacts.com https://*.flix360.io https://*.flix360.com https://media.flixsyndication.net https://content.jwplatform.com https://assets-jpcust.jwpsrv.com https://ssl.p.jwpcdn.com https://d3nkfb7815bs43.cloudfront.net https://d2m3ikv8mpgiy8.cloudfront.net https://d3np41mctoibfu.cloudfront.net https://media.pointandplace.com https://player.pointandplace.com https://t.pointandplace.com https://maps.googleapis.com https://*.googleapis.com https://*.epayco.co https://*.epayco.com https://*.epayco.io https://*.cardinaltrusted.com https://device.clearsale.com.br https://3ds.epayco.com https://*.alignet.io https://*.cardinalcommerce.com https://*.secureacs.com https://*.3dsecure.io https://*.netcetera.com https://*.gpsrv.com https://vercel.live https://*.bancolombia.com https://*.bancolombia.com.co https://*.davivienda.com https://*.avvillas.com.co https://*.bancodebogota.com https://*.bbva.com.co https://*.itau.com.co https://*.bancoagrario.gov.co https://*.bancocajasocial.com https://*.sudameris.com.co https://*.bancopichincha.com.co https://*.scotiabank.com.co https://*.citibank.com.co https://*.gnbsudameris.com https://*.popular.com.co https://*.bancooccidente.com.co https://*.coopcentral.com.co https://*.bancow.com.co https://*.falabella.com.co https://*.nequi.com.co https://*.daviplata.com https://api.ipify.org https://*.pse.com.co https://*.achcolombia.com.co https://*.bancoserfinanza.com https://*.bancounion.com.co https://*.credifinanciera.com.co https://*.mibanco.com.co https://*.bancoopcentral.digital https://*.confiar.coop https://*.cotrafa.com.co https://*.juriscoop.com.co https://*.dale.com.co https://*.powwi.co https://*.presto.com.co https://*.iris.com.co https://*.rappipay.com https://*.financierairis.com.co https://*.lulobank.com https://*.nu.com.co https://*.bancoomeva.com.co https://*.bancofinandina.com https://*.santander.com.co https://*.itau.co https://*.scotiabankcolpatria.com",
              "frame-src 'self' http://localhost:* https://imagiq-backend-production.up.railway.app https://www.googletagmanager.com https://www.facebook.com https://*.facebook.com https://media.flixcar.com https://media.flixfacts.com https://*.flix360.io https://*.flix360.com https://content.jwplatform.com https://player.pointandplace.com https://*.google.com https://*.googleapis.com https://*.gstatic.com https://*.epayco.co https://*.epayco.com https://*.epayco.io https://*.cardinaltrusted.com https://3ds.epayco.com https://*.alignet.io https://*.cardinalcommerce.com https://*.secureacs.com https://*.3dsecure.io https://*.netcetera.com https://*.gpsrv.com https://*.bancolombia.com https://*.bancolombia.com.co https://*.davivienda.com https://*.avvillas.com.co https://*.bancodebogota.com https://*.bbva.com.co https://*.itau.com.co https://*.bancoagrario.gov.co https://*.bancocajasocial.com https://*.sudameris.com.co https://*.bancopichincha.com.co https://*.scotiabank.com.co https://*.citibank.com.co https://*.gnbsudameris.com https://*.popular.com.co https://*.bancooccidente.com.co https://*.coopcentral.com.co https://*.bancow.com.co https://*.falabella.com.co https://*.nequi.com.co https://*.daviplata.com https://*.sistecredito.com https://*.bancamia.com.co https://*.movii.com.co https://*.pse.com.co https://*.achcolombia.com.co https://*.bancoserfinanza.com https://*.bancounion.com.co https://*.credifinanciera.com.co https://*.mibanco.com.co https://*.bancoopcentral.digital https://*.confiar.coop https://*.cotrafa.com.co https://*.juriscoop.com.co https://*.dale.com.co https://*.powwi.co https://*.presto.com.co https://*.iris.com.co https://*.rappipay.com https://*.financierairis.com.co https://*.lulobank.com https://*.nu.com.co https://*.bancoomeva.com.co https://*.bancofinandina.com https://*.santander.com.co https://*.itau.co https://*.scotiabankcolpatria.com",
              "media-src 'self' blob: https://res.cloudinary.com https://media.flixcar.com https://media.flixfacts.com https://*.flix360.io https://content.jwplatform.com https://assets-jpcust.jwpsrv.com https://ssl.p.jwpcdn.com",
              "worker-src 'self' blob:",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self' https://www.facebook.com https://*.facebook.com https://www.googletagmanager.com https://*.google.com https://*.tiktok.com https://*.epayco.co https://*.epayco.com https://*.epayco.io https://*.cardinaltrusted.com https://3ds.epayco.com https://*.alignet.io https://*.cardinalcommerce.com https://*.secureacs.com https://*.3dsecure.io https://*.netcetera.com https://*.gpsrv.com https://*.bancolombia.com https://*.bancolombia.com.co https://*.davivienda.com https://*.avvillas.com.co https://*.bancodebogota.com https://*.bbva.com.co https://*.itau.com.co https://*.bancoagrario.gov.co https://*.bancocajasocial.com https://*.sudameris.com.co https://*.bancopichincha.com.co https://*.scotiabank.com.co https://*.citibank.com.co https://*.gnbsudameris.com https://*.popular.com.co https://*.bancooccidente.com.co https://*.coopcentral.com.co https://*.bancow.com.co https://*.falabella.com.co https://*.nequi.com.co https://*.daviplata.com https://*.sistecredito.com https://*.bancamia.com.co https://*.movii.com.co https://*.pse.com.co https://*.achcolombia.com.co https://*.bancoserfinanza.com https://*.bancounion.com.co https://*.credifinanciera.com.co https://*.mibanco.com.co https://*.bancoopcentral.digital https://*.confiar.coop https://*.cotrafa.com.co https://*.juriscoop.com.co https://*.dale.com.co https://*.powwi.co https://*.presto.com.co https://*.iris.com.co https://*.rappipay.com https://*.financierairis.com.co https://*.lulobank.com https://*.nu.com.co https://*.bancoomeva.com.co https://*.bancofinandina.com https://*.santander.com.co https://*.itau.co https://*.scotiabankcolpatria.com",
              "upgrade-insecure-requests",
            ].join("; "),
          },
        ],
      },
      // Cache-Control headers para imágenes optimizadas
      {
        source: "/:all*(svg|jpg|jpeg|png|gif|webp|avif|ico|bmp|tiff)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
