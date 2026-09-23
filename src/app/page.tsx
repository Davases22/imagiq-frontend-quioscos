/**
 * 🏠 PÁGINA PRINCIPAL - IMAGIQ ECOMMERCE
 *
 * Server Component con ISR (Incremental Static Regeneration)
 * Revalida cada 60 segundos para contenido actualizado
 */

import { getProductsByCategory, getProductosHomeConfig } from "@/lib/api-server";
import { mapApiProductsToFrontend } from "@/lib/mappers/product-mapper";
import type { ProductCardProps } from "@/app/productos/components/ProductCard";

// Server Components (sin "use client")
import SEO from "@/components/SEO";
import { CTASection } from "@/components/sections/CTASection";

// Client Components (necesitan interactividad)
import AITVsBanner from "@/components/sections/AITVsBanner";
import DynamicBanner from "@/components/banners/DynamicBannerClean";
import TVProductsGrid from "@/components/sections/TVProductsGrid";
import BespokeAIBanner from "@/components/sections/BespokeAIBanner";
import AppliancesProductsGrid from "@/components/sections/AppliancesProductsGrid";

// Client wrapper para efectos del lado del cliente (scroll, etc.)
import HomePageClient from "./HomePageClient";

// ISR: regenerar cada 60 segundos
export const revalidate = 60;

/** Tarjetas que pinta cada franja de la home. */
const CUPOS_POR_FRANJA = 4;

/**
 * Aplica la curaduría del dashboard a una franja. Es la MISMA lógica que la
 * tienda web, para que el quiosco muestre exactamente lo mismo.
 *
 * Los productos fijados van primero, en el orden configurado y SIN filtrar por
 * inventario: si alguien eligió mostrar un producto, se muestra aunque esté
 * agotado. Si quedan cupos, se completan con el resto de la categoría como se
 * hacía antes, para que la franja nunca quede coja.
 */
function aplicarCuraduria(
  disponibles: ProductCardProps[],
  codigos: string[],
  conStock: (p: ProductCardProps) => boolean
): ProductCardProps[] {
  const porCodigo = new Map<string, ProductCardProps>();
  for (const p of disponibles) {
    const codigo = p.apiProduct?.codigoMarketBase;
    if (codigo && !porCodigo.has(codigo)) porCodigo.set(codigo, p);
  }

  const elegidos: ProductCardProps[] = [];
  const usados = new Set<string>();

  for (const codigo of codigos) {
    const p = porCodigo.get(codigo);
    if (p && !usados.has(codigo)) {
      elegidos.push(p);
      usados.add(codigo);
    }
    if (elegidos.length >= CUPOS_POR_FRANJA) break;
  }

  if (elegidos.length < CUPOS_POR_FRANJA) {
    for (const p of disponibles) {
      const codigo = p.apiProduct?.codigoMarketBase;
      if (!codigo || usados.has(codigo) || !conStock(p)) continue;
      elegidos.push(p);
      usados.add(codigo);
      if (elegidos.length >= CUPOS_POR_FRANJA) break;
    }
  }

  return elegidos;
}

export default async function HomePage() {
  // Fetch paralelo de datos en el servidor - más eficiente que CSR
  // Pedimos 50 productos de AV y 100 de DA para asegurar 4 con stock después del filtrado
  const [tvProductsData, appliancesData, curaduria] = await Promise.all([
    getProductsByCategory("AV", undefined, undefined, 1, 50, "precio", "desc").catch(() => ({
      products: [],
      totalItems: 0,
      totalPages: 0,
      currentPage: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    })),
    getProductsByCategory("DA", undefined, undefined, 1, 100, "precio", "desc").catch(() => ({
      products: [],
      totalItems: 0,
      totalPages: 0,
      currentPage: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    })),
    getProductosHomeConfig(),
  ]);

  // Helper para filtrar productos con stock > 0
  const hasStock = (p: ProductCardProps) => {
    const stockTotal = p.apiProduct?.stockTotal;
    if (Array.isArray(stockTotal)) {
      return stockTotal.some(stock => stock > 0);
    }
    return stockTotal ? stockTotal > 0 : false;
  };

  // Ojo: NO se filtra por stock aquí. El filtro se aplica al rellenar, dentro
  // de aplicarCuraduria, para que un producto fijado agotado sí se pueda pintar.
  const tvProducts = tvProductsData.products.length > 0
    ? mapApiProductsToFrontend(tvProductsData.products)
    : [];

  const appliancesProducts = appliancesData.products.length > 0
    ? mapApiProductsToFrontend(appliancesData.products)
    : [];

  const mappedTVProducts = aplicarCuraduria(tvProducts, curaduria.tv, hasStock);

  const mappedAppliancesProducts = aplicarCuraduria(
    appliancesProducts,
    curaduria.electro,
    hasStock
  );

  return (
    <>
      <SEO
        title="Samsung Store - iMagiQ Colombia"
        description="Distribuidor oficial de Samsung en Colombia. Encuentra los últimos Galaxy, tablets, wearables y electrodomésticos con garantía oficial. Envío gratis, soporte especializado y las mejores promociones."
        keywords="Samsung Colombia, distribuidor oficial Samsung, Galaxy, Samsung Store, electrodomésticos Samsung, tablets Samsung, smartwatch Samsung, Galaxy Z Fold, Galaxy Z Flip, tienda Samsung Colombia"
      />

      <HomePageClient>
        <div id="main-page" className="min-h-screen md:mr-0 md:overflow-x-clip">
          <DynamicBanner placement="home-3" fullBleedMobile>
            <AITVsBanner />
          </DynamicBanner>

          <TVProductsGrid initialProducts={mappedTVProducts} />

          <DynamicBanner placement="home-4" className="mt-6 md:mt-8 lg:mt-12">
            <BespokeAIBanner />
          </DynamicBanner>

          <AppliancesProductsGrid initialProducts={mappedAppliancesProducts} />

          <CTASection />
        </div>
      </HomePageClient>
    </>
  );
}
