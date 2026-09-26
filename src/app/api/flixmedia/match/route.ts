import { NextRequest, NextResponse } from "next/server";

/**
 * Proxy cacheado del Match API de Flixmedia.
 *
 * Que un MPN/EAN tenga contenido en Flixmedia cambia casi nunca, pero hoy
 * cada navegador lo consulta directo (caché in-memory por pestaña, 5 min).
 * Este proxy usa el Data Cache de Next (revalidate 24h) para que el match
 * se resuelva UNA vez en el servidor y se comparta entre todos los usuarios.
 * Los headers CDN permiten además cachear la respuesta en el edge.
 *
 * GET /api/flixmedia/match?kind=mpn|ean&value=<sku>&distributor=&language=
 */

const MATCH_API_URL = "https://media.flixcar.com/delivery/webcall/match";
const DEFAULT_DISTRIBUTOR = "17257";
const DEFAULT_LANGUAGE = "f5";

const MATCH_REVALIDATE_SECONDS = 60 * 60 * 24; // 24h

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const kind = searchParams.get("kind") === "ean" ? "ean" : "mpn";
  const value = searchParams.get("value");
  const distributor = searchParams.get("distributor") || DEFAULT_DISTRIBUTOR;
  const language = searchParams.get("language") || DEFAULT_LANGUAGE;

  if (!value) {
    return NextResponse.json(
      { available: false, error: "missing_value" },
      { status: 400 }
    );
  }

  // distributor/language se interpolan como segmentos de path hacia Flixmedia:
  // restringirlos evita que un request malicioso reescriba el path del upstream.
  if (!/^\d{1,10}$/.test(distributor) || !/^[a-z0-9]{1,5}$/i.test(language)) {
    return NextResponse.json(
      { available: false, error: "invalid_params" },
      { status: 400 }
    );
  }

  try {
    const url = `${MATCH_API_URL}/${distributor}/${language}/${kind}/${encodeURIComponent(value)}`;
    const response = await fetch(url, {
      next: { revalidate: MATCH_REVALIDATE_SECONDS },
    });

    // NO interpretar el body si el upstream falló (4xx/5xx). Un error de
    // Flixmedia con cuerpo JSON produciría {available:false} con status 200 y
    // el header CDN de 24h, envenenando un falso negativo compartido para ese
    // MPN. Devolver 502 hace que el cliente caiga al Match API directo (mismo
    // contrato que el catch de red) y evita cachear el error en el CDN.
    if (!response.ok) {
      return NextResponse.json(
        { available: false, error: "match_upstream_status" },
        { status: 502 }
      );
    }

    const data = await response.json();

    const matched = data?.event === "matchhit" && data?.product_id;
    return NextResponse.json(
      matched
        ? { available: true, productId: String(data.product_id) }
        : { available: false },
      {
        headers: {
          "Cache-Control":
            "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400",
        },
      }
    );
  } catch {
    // 502 (y no available:false) para que el cliente distinga "sin contenido"
    // de "proxy caído" y haga fallback al Match API directo.
    return NextResponse.json(
      { available: false, error: "match_upstream_failed" },
      { status: 502 }
    );
  }
}
